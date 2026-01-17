const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Criar tabelas se não existirem
async function initDB() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS confirmados_atual (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        tenant_id INTEGER,
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS historico_confirmacoes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        tenant_id INTEGER,
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        tenant_id INTEGER,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_tokens (
        token VARCHAR(255) PRIMARY KEY,
        admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expira_em TIMESTAMP
      )
    `);
    
    await client.query('COMMIT');
    console.log('✅ Tabelas criadas/verificadas com sucesso!');
    
    const adminExists = await client.query('SELECT * FROM admins WHERE usuario = $1', ['admin']);
    if (adminExists.rows.length === 0) {
      const senhaHash = await bcrypt.hash('admin123', 10);
      await client.query('INSERT INTO admins (usuario, senha_hash) VALUES ($1, $2)', ['admin', senhaHash]);
      console.log('✅ Admin padrão criado: admin/admin123');
    }
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar tabelas:', err);
    throw err;
  } finally {
    client.release();
  }
}

initDB();

// ==================== MIDDLEWARES ====================

async function verificarTenant(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }
  
  try {
    const result = await pool.query(`
      SELECT at.admin_id, a.tenant_id, a.usuario,
             t.status, t.nome as tenant_nome, t.whatsapp_number
      FROM admin_tokens at
      INNER JOIN admins a ON at.admin_id = a.id
      LEFT JOIN tenants t ON a.tenant_id = t.id
      WHERE at.token = $1 AND at.expira_em > NOW()
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    
    const data = result.rows[0];
    
    if (!data.tenant_id) {
      req.adminId = data.admin_id;
      req.tenantId = null;
      req.tenantNome = 'Admin Principal';
      req.whatsappNumber = null;
      return next();
    }
    
    if (data.status !== 'active') {
      return res.status(403).json({ erro: 'Assinatura inativa. Entre em contato.' });
    }
    
    req.adminId = data.admin_id;
    req.tenantId = data.tenant_id;
    req.tenantNome = data.tenant_nome;
    req.whatsappNumber = data.whatsapp_number;
    
    next();
  } catch (err) {
    console.error('Erro ao verificar tenant:', err);
    return res.status(500).json({ erro: 'Erro ao verificar token' });
  }
}

async function verificarAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM admin_tokens WHERE token = $1 AND expira_em > NOW()',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    
    req.adminId = result.rows[0].admin_id;
    next();
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar token' });
  }
}

// ==================== ROTAS HTML ====================

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/login.html');
});

app.get('/setup-admin', (req, res) => {
  res.sendFile(__dirname + '/public/setup-admin.html');
});

app.get('/registro', (req, res) => {
  res.sendFile(__dirname + '/public/registro.html');
});

app.get('/lab', (req, res) => {
  res.sendFile(__dirname + '/public/lab.html');
});

// ==================== AUTENTICAÇÃO ====================

app.post('/api/registro', async (req, res) => {
  const { nome_time, email, senha, nome_usuario, telefone, whatsapp } = req.body;
  
  console.log('📝 Tentativa de registro:', { nome_time, email, nome_usuario });
  
  if (!nome_time || !email || !senha || !nome_usuario) {
    return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios' });
  }
  
  try {
    const emailExists = await pool.query('SELECT id FROM admins WHERE usuario = $1', [email]);
    if (emailExists.rows.length > 0) {
      return res.status(400).json({ erro: 'Email já cadastrado. Use outro email.' });
    }
    
    let subdomainBase = nome_time.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    
    let subdomain = subdomainBase;
    let tentativa = 1;
    
    while (tentativa < 100) {
      const check = await pool.query('SELECT id FROM tenants WHERE subdomain = $1', [subdomain]);
      if (check.rows.length === 0) break;
      subdomain = `${subdomainBase}-${tentativa}`;
      tentativa++;
    }
    
    console.log('📌 Subdomain:', subdomain);
    
    const tenantResult = await pool.query(`
      INSERT INTO tenants (nome, subdomain, whatsapp_number, status, plano)
      VALUES ($1, $2, $3, 'active', 'mensal')
      RETURNING id
    `, [nome_time, subdomain, whatsapp || telefone]);
    
    const tenantId = tenantResult.rows[0].id;
    const senhaHash = await bcrypt.hash(senha, 10);
    
    await pool.query(`
      INSERT INTO admins (usuario, senha_hash, tenant_id)
      VALUES ($1, $2, $3)
    `, [email, senhaHash, tenantId]);
    
    await pool.query(`
      INSERT INTO users (tenant_id, email, senha_hash, nome, telefone, role)
      VALUES ($1, $2, $3, $4, $5, 'tenant_admin')
    `, [tenantId, email, senhaHash, nome_usuario, telefone]);
    
    console.log('✅ Tenant criado:', tenantId);
    
    res.json({ 
      sucesso: true, 
      mensagem: 'Cadastro realizado com sucesso!',
      tenant_id: tenantId,
      subdomain: subdomain
    });
    
  } catch (err) {
    console.error('❌ Erro no registro:', err.message);
    res.status(500).json({ erro: `Erro ao criar conta: ${err.message}` });
  }
});

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM admins WHERE usuario = $1', [usuario]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ sucesso: false, erro: 'Usuário não encontrado' });
    }
    
    const admin = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, admin.senha_hash);
    
    if (!senhaValida) {
      return res.status(401).json({ sucesso: false, erro: 'Senha incorreta' });
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    await pool.query(
      'INSERT INTO admin_tokens (token, admin_id, expira_em) VALUES ($1, $2, $3)',
      [token, admin.id, expiraEm]
    );
    
    res.json({ sucesso: true, token });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ sucesso: false, erro: 'Erro no servidor' });
  }
});

app.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    await pool.query('DELETE FROM admin_tokens WHERE token = $1', [token]);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: 'Erro ao fazer logout' });
  }
});

app.get('/verificar-token', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.json({ valido: false });
  }
  
  try {
    const result = await pool.query(`
      SELECT at.*, a.tenant_id, t.nome as tenant_nome, t.status
      FROM admin_tokens at
      INNER JOIN admins a ON at.admin_id = a.id
      LEFT JOIN tenants t ON a.tenant_id = t.id
      WHERE at.token = $1 AND at.expira_em > NOW()
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.json({ valido: false });
    }
    
    const data = result.rows[0];
    
    res.json({ 
      valido: true,
      tenant_id: data.tenant_id,
      tenant_nome: data.tenant_nome || 'Admin Principal',
      status: data.status || 'active'
    });
  } catch (err) {
    res.json({ valido: false });
  }
});

app.get('/admin-existe', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as total FROM admins');
    res.json({ existe: parseInt(result.rows[0].total) > 0 });
  } catch (err) {
    res.json({ existe: false });
  }
});

// ==================== CONFIRMAÇÕES ====================

app.post('/confirmar', verificarTenant, async (req, res) => {
  const { nome, tipo, genero } = req.body;
  
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e gênero são obrigatórios' });
  }
  
  try {
    let countQuery = 'SELECT COUNT(*) as total FROM confirmados_atual';
    let countParams = [];
    
    if (req.tenantId) {
      countQuery += ' WHERE tenant_id = $1';
      countParams = [req.tenantId];
    }
    
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);
    
    if (total >= 24) {
      return res.status(400).json({ erro: 'Limite de 24 confirmados atingido!' });
    }
    
    const resultAtual = await pool.query(
      'INSERT INTO confirmados_atual (nome, tipo, genero, tenant_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, tipo, genero, req.tenantId]
    );
    
    await pool.query(
      'INSERT INTO historico_confirmacoes (nome, tipo, genero, tenant_id) VALUES ($1, $2, $3, $4)',
      [nome, tipo, genero, req.tenantId]
    );
    
    res.json({ sucesso: true, confirmado: resultAtual.rows[0] });
  } catch (err) {
    console.error('Erro ao confirmar:', err);
    res.status(500).json({ erro: 'Erro ao confirmar presença' });
  }
});

app.get('/confirmados', verificarTenant, async (req, res) => {
  try {
    let query = 'SELECT * FROM confirmados_atual';
    let params = [];
    
    if (req.tenantId) {
      query += ' WHERE tenant_id = $1';
      params = [req.tenantId];
    }
    
    query += ' ORDER BY data_confirmacao ASC LIMIT 24';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar confirmados' });
  }
});

app.delete('/confirmados/:id', verificarTenant, async (req, res) => {
  try {
    let query = 'DELETE FROM confirmados_atual WHERE id = $1';
    let params = [req.params.id];
    
    if (req.tenantId) {
      query += ' AND tenant_id = $2';
      params.push(req.tenantId);
    }
    
    await pool.query(query, params);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover' });
  }
});

app.delete('/confirmados', verificarTenant, async (req, res) => {
  try {
    let query = 'DELETE FROM confirmados_atual';
    let params = [];
    
    if (req.tenantId) {
      query += ' WHERE tenant_id = $1';
      params = [req.tenantId];
    }
    
    await pool.query(query, params);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao limpar lista' });
  }
});

// ==================== ESTATÍSTICAS ====================

app.get('/estatisticas', verificarTenant, async (req, res) => {
  try {
    let whereClause = '';
    let params = [];
    
    if (req.tenantId) {
      whereClause = 'WHERE tenant_id = $1';
      params = [req.tenantId];
    }
    
    const ranking = await pool.query(`
      SELECT nome, tipo, genero,
        COUNT(*) as total_confirmacoes,
        MAX(data_confirmacao) as ultima_confirmacao
      FROM historico_confirmacoes
      ${whereClause}
      GROUP BY nome, tipo, genero
      ORDER BY total_confirmacoes DESC, nome ASC
    `, params);
    
    const totalConfirmacoes = await pool.query(
      `SELECT COUNT(*) as total FROM historico_confirmacoes ${whereClause}`,
      params
    );
    
    const pessoasUnicas = await pool.query(
      `SELECT COUNT(DISTINCT nome) as total FROM historico_confirmacoes ${whereClause}`,
      params
    );
    
    const total = parseInt(totalConfirmacoes.rows[0].total) || 0;
    const pessoas = parseInt(pessoasUnicas.rows[0].total) || 1;
    const media = pessoas > 0 ? (total / pessoas).toFixed(1) : 0;
    
    const porGenero = await pool.query(`
      SELECT genero, COUNT(*) as total, COUNT(DISTINCT nome) as pessoas
      FROM historico_confirmacoes
      ${whereClause}
      GROUP BY genero
    `, params);
    
    const generoObj = {};
    porGenero.rows.forEach(row => {
      generoObj[row.genero] = {
        total: parseInt(row.total),
        pessoas: parseInt(row.pessoas)
      };
    });
    
    const rankingFormatado = ranking.rows.map(row => ({
      nome: row.nome,
      tipo: row.tipo,
      genero: row.genero,
      totalconfirmacoes: parseInt(row.total_confirmacoes) || 0,
      total_confirmacoes: parseInt(row.total_confirmacoes) || 0,
      ultimaconfirmacao: row.ultima_confirmacao,
      ultima_confirmacao: row.ultima_confirmacao
    }));
    
    res.json({
      ranking: rankingFormatado,
      resumo: {
        totalConfirmacoes: total,
        pessoasUnicas: pessoas,
        mediaConfirmacoes: media
      },
      porGenero: generoObj
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' });
  }
});

app.put('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  const { novoTotal } = req.body;
  
  if (!novoTotal || novoTotal < 0) {
    return res.status(400).json({ erro: 'Informe um número válido de presenças' });
  }
  
  try {
    const pessoa = await pool.query(
      'SELECT tipo, genero, COUNT(*) as atual FROM historico_confirmacoes WHERE nome = $1 GROUP BY tipo, genero',
      [nome]
    );
    
    if (pessoa.rows.length === 0) {
      return res.status(404).json({ erro: 'Pessoa não encontrada' });
    }
    
    const { tipo, genero, atual } = pessoa.rows[0];
    const atualInt = parseInt(atual);
    const diferenca = novoTotal - atualInt;
    
    if (diferenca > 0) {
      for (let i = 0; i < diferenca; i++) {
        await pool.query(
          'INSERT INTO historico_confirmacoes (nome, tipo, genero) VALUES ($1, $2, $3)',
          [nome, tipo, genero]
        );
      }
    } else if (diferenca < 0) {
      await pool.query(
        `DELETE FROM historico_confirmacoes 
         WHERE id IN (
           SELECT id FROM historico_confirmacoes 
           WHERE nome = $1 
           ORDER BY data_confirmacao DESC 
           LIMIT $2
         )`,
        [nome, Math.abs(diferenca)]
      );
    }
    
    res.json({ 
      sucesso: true, 
      anterior: atualInt,
      novo: novoTotal,
      diferenca: diferenca
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao editar presenças' });
  }
});

app.delete('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM historico_confirmacoes WHERE nome = $1', [req.params.nome]);
    await pool.query('DELETE FROM confirmados_atual WHERE nome = $1', [req.params.nome]);
    res.json({ sucesso: true, removidos: result.rowCount });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover pessoa das estatísticas' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
