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

// Criar tabelas se não existirem - COM MIGRAÇÃO AUTOMÁTICA
async function initDB() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Verificar se existe tabela admins antiga (sem a estrutura correta)
    const checkAdmins = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'admins' AND column_name = 'usuario'
    `);
    
    // Se não existe a coluna usuario, dropar e recriar
    if (checkAdmins.rows.length === 0) {
      console.log('Estrutura antiga detectada. Recriando tabelas...');
      await client.query('DROP TABLE IF EXISTS admin_tokens CASCADE');
      await client.query('DROP TABLE IF EXISTS admins CASCADE');
      await client.query('DROP TABLE IF EXISTS confirmados_atual CASCADE');
      await client.query('DROP TABLE IF EXISTS historico_confirmacoes CASCADE');
    }
    
    // Criar tabela de confirmados atuais
    await client.query(`
      CREATE TABLE IF NOT EXISTS confirmados_atual (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Criar tabela de histórico
    await client.query(`
      CREATE TABLE IF NOT EXISTS historico_confirmacoes (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Criar tabela de admins
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Criar tabela de tokens
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
    
    // Criar admin padrão se não existir
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

// MIDDLEWARE: Extrair tenant do token
async function verificarTenant(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }
  
  try {
    const result = await pool.query(`
      SELECT at.admin_id, a.tenant_id, t.status, t.nome as tenant_nome
      FROM admin_tokens at
      INNER JOIN admins a ON at.admin_id = a.id
      INNER JOIN tenants t ON a.tenant_id = t.id
      WHERE at.token = $1 AND at.expira_em > NOW()
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
    
    const data = result.rows[0];
    
    if (data.status !== 'active') {
      return res.status(403).json({ erro: 'Assinatura inativa. Entre em contato.' });
    }
    
    req.adminId = data.admin_id;
    req.tenantId = data.tenant_id;
    req.tenantNome = data.tenant_nome;
    
    next();
  } catch (err) {
    console.error('Erro ao verificar tenant:', err);
    return res.status(500).json({ erro: 'Erro ao verificar token' });
  }
}

// REGISTRAR NOVO TENANT (público)
app.post('/registro', async (req, res) => {
  const { nome_time, email, senha, nome_usuario, telefone } = req.body;
  
  try {
    // Criar tenant
    const tenantResult = await pool.query(`
      INSERT INTO tenants (nome, subdomain, status, plano)
      VALUES ($1, $2, 'trial', 'mensal')
      RETURNING id
    `, [nome_time, email.split('@')[0]]); // subdomain baseado no email
    
    const tenantId = tenantResult.rows[0].id;
    
    // Criar usuário admin do tenant
    const senhaHash = await bcrypt.hash(senha, 10);
    await pool.query(`
      INSERT INTO users (tenant_id, email, senha_hash, nome, telefone, role)
      VALUES ($1, $2, $3, $4, $5, 'tenant_admin')
    `, [tenantId, email, senhaHash, nome_usuario, telefone]);
    
    // Também criar na tabela admins antiga (compatibilidade)
    await pool.query(`
      INSERT INTO admins (usuario, senha_hash, tenant_id)
      VALUES ($1, $2, $3)
    `, [email, senhaHash, tenantId]);
    
    res.json({ 
      sucesso: true, 
      mensagem: 'Cadastro realizado! Faça login para começar.',
      tenant_id: tenantId 
    });
    
  } catch (err) {
    console.error('Erro no registro:', err);
    res.status(500).json({ erro: 'Erro ao criar conta' });
  }
});

// ATUALIZAR ROTA DE CONFIRMAÇÃO para usar tenant
app.post('/confirmar', verificarTenant, async (req, res) => {
  const { nome, tipo, genero } = req.body;
  const tenantId = req.tenantId;
  
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e gênero são obrigatórios' });
  }
  
  try {
    // Contar apenas confirmados do tenant
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM confirmados_atual WHERE tenant_id = $1',
      [tenantId]
    );
    
    const total = parseInt(countResult.rows[0].total);
    if (total >= 24) {
      return res.status(400).json({ erro: 'Limite de 24 confirmados atingido!' });
    }
    
    // Salvar com tenant_id
    const resultAtual = await pool.query(
      'INSERT INTO confirmados_atual (nome, tipo, genero, tenant_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, tipo, genero, tenantId]
    );
    
    await pool.query(
      'INSERT INTO historico_confirmacoes (nome, tipo, genero, tenant_id) VALUES ($1, $2, $3, $4)',
      [nome, tipo, genero, tenantId]
    );
    
    res.json({ sucesso: true, confirmado: resultAtual.rows[0] });
  } catch (err) {
    console.error('Erro ao confirmar:', err);
    res.status(500).json({ erro: 'Erro ao confirmar presença' });
  }
});

// ATUALIZAR ROTA DE LISTAR para usar tenant
app.get('/confirmados', verificarTenant, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM confirmados_atual WHERE tenant_id = $1 ORDER BY data_confirmacao ASC LIMIT 24',
      [req.tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar:', err);
    res.status(500).json({ erro: 'Erro ao listar confirmados' });
  }
});

// Aplicar o mesmo para todas as outras rotas...


// MIDDLEWARE: Verificar token admin
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

// LOGIN ADMIN
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
    
    // Gerar token
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
    
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

// LOGOUT ADMIN
app.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  try {
    await pool.query('DELETE FROM admin_tokens WHERE token = $1', [token]);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: 'Erro ao fazer logout' });
  }
});

// VERIFICAR TOKEN
app.get('/verificar-token', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.json({ valido: false });
  }
  
  try {
    const result = await pool.query(
      'SELECT * FROM admin_tokens WHERE token = $1 AND expira_em > NOW()',
      [token]
    );
    
    res.json({ valido: result.rows.length > 0 });
  } catch (err) {
    res.json({ valido: false });
  }
});

// CONFIRMAR PRESENÇA (salva em AMBAS as tabelas)
app.post('/confirmar', async (req, res) => {
  const { nome, tipo, genero } = req.body;
  
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e gênero são obrigatórios' });
  }
  
  try {
    // Verifica se já tem 24 confirmados
    const countResult = await pool.query('SELECT COUNT(*) as total FROM confirmados_atual');
    const total = parseInt(countResult.rows[0].total);
    
    if (total >= 24) {
      return res.status(400).json({ erro: 'Limite de 24 confirmados atingido!' });
    }
    
    // Salvar na lista atual (temporária)
    const resultAtual = await pool.query(
      'INSERT INTO confirmados_atual (nome, tipo, genero) VALUES ($1, $2, $3) RETURNING *',
      [nome, tipo, genero]
    );
    
    // Salvar no histórico (permanente)
    await pool.query(
      'INSERT INTO historico_confirmacoes (nome, tipo, genero) VALUES ($1, $2, $3)',
      [nome, tipo, genero]
    );
    
    res.json({ sucesso: true, confirmado: resultAtual.rows[0] });
  } catch (err) {
    console.error('Erro ao confirmar:', err);
    res.status(500).json({ erro: 'Erro ao confirmar presença' });
  }
});

// LISTAR CONFIRMADOS ATUAIS
app.get('/confirmados', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM confirmados_atual ORDER BY data_confirmacao ASC LIMIT 24'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar:', err);
    res.status(500).json({ erro: 'Erro ao listar confirmados' });
  }
});

// REMOVER CONFIRMADO ATUAL (não afeta histórico)
app.delete('/confirmados/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    await pool.query('DELETE FROM confirmados_atual WHERE id = $1', [id]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao remover:', err);
    res.status(500).json({ erro: 'Erro ao remover' });
  }
});

// LIMPAR LISTA DE CONFIRMADOS ATUAIS (não afeta histórico)
app.delete('/confirmados', async (req, res) => {
  try {
    await pool.query('DELETE FROM confirmados_atual');
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao limpar:', err);
    res.status(500).json({ erro: 'Erro ao limpar lista' });
  }
});

// ESTATÍSTICAS (busca do histórico permanente)
app.get('/estatisticas', async (req, res) => {
  try {
    const ranking = await pool.query(`
      SELECT 
        nome,
        tipo,
        genero,
        COUNT(*) as total_confirmacoes,
        MAX(data_confirmacao) as ultima_confirmacao
      FROM historico_confirmacoes
      GROUP BY nome, tipo, genero
      ORDER BY total_confirmacoes DESC, nome ASC
    `);
    
    const totalConfirmacoes = await pool.query(`
      SELECT COUNT(*) as total FROM historico_confirmacoes
    `);
    
    const pessoasUnicas = await pool.query(`
      SELECT COUNT(DISTINCT nome) as total FROM historico_confirmacoes
    `);
    
    const total = parseInt(totalConfirmacoes.rows[0].total) || 0;
    const pessoas = parseInt(pessoasUnicas.rows[0].total) || 1;
    const media = pessoas > 0 ? (total / pessoas).toFixed(1) : 0;
    
    const porGenero = await pool.query(`
      SELECT 
        genero,
        COUNT(*) as total,
        COUNT(DISTINCT nome) as pessoas
      FROM historico_confirmacoes
      GROUP BY genero
    `);
    
    const generoObj = {};
    porGenero.rows.forEach(row => {
      generoObj[row.genero] = {
        total: parseInt(row.total),
        pessoas: parseInt(row.pessoas)
      };
    });
    
    // CORREÇÃO AQUI - garantir que o número seja convertido corretamente
const rankingFormatado = ranking.rows.map(row => ({
  nome: row.nome,
  tipo: row.tipo,
  genero: row.genero,
  totalconfirmacoes: parseInt(row.total_confirmacoes) || 0,  // converter de total_confirmacoes para totalconfirmacoes
  total_confirmacoes: parseInt(row.total_confirmacoes) || 0,  // manter ambos por compatibilidade
  ultimaconfirmacao: row.ultima_confirmacao,
  ultima_confirmacao: row.ultima_confirmacao  // manter ambos
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
    console.error('Erro nas estatísticas:', err);
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' });
  }
});


// EDITAR NÚMERO DE PRESENÇAS (ADMIN)
app.put('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  const { novoTotal } = req.body;
  
  if (!novoTotal || novoTotal < 0) {
    return res.status(400).json({ erro: 'Informe um número válido de presenças' });
  }
  
  try {
    // Buscar dados atuais da pessoa
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
      // Adicionar registros
      for (let i = 0; i < diferenca; i++) {
        await pool.query(
          'INSERT INTO historico_confirmacoes (nome, tipo, genero) VALUES ($1, $2, $3)',
          [nome, tipo, genero]
        );
      }
    } else if (diferenca < 0) {
      // Remover registros (os mais recentes)
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
    console.error('Erro ao editar presenças:', err);
    res.status(500).json({ erro: 'Erro ao editar presenças' });
  }
});

// REMOVER PESSOA DO HISTÓRICO (ADMIN APENAS)
app.delete('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  
  try {
    // Remove TODAS as confirmações dessa pessoa do histórico
    const result = await pool.query('DELETE FROM historico_confirmacoes WHERE nome = $1', [nome]);
    
    // Remove também da lista atual se estiver lá
    await pool.query('DELETE FROM confirmados_atual WHERE nome = $1', [nome]);
    
    res.json({ sucesso: true, removidos: result.rowCount });
  } catch (err) {
    console.error('Erro ao remover pessoa:', err);
    res.status(500).json({ erro: 'Erro ao remover pessoa das estatísticas' });
  }
});

// TROCAR SENHA DO ADMIN
app.post('/admin/trocar-senha', verificarAdmin, async (req, res) => {
  const { senha_antiga, senha_nova } = req.body;
  
  try {
    const admin = await pool.query('SELECT * FROM admins WHERE id = $1', [req.adminId]);
    
    if (admin.rows.length === 0) {
      return res.status(404).json({ erro: 'Admin não encontrado' });
    }
    
    const senhaValida = await bcrypt.compare(senha_antiga, admin.rows[0].senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha antiga incorreta' });
    }
    
    const novaSenhaHash = await bcrypt.hash(senha_nova, 10);
    await pool.query('UPDATE admins SET senha_hash = $1 WHERE id = $2', [novaSenhaHash, req.adminId]);
    
    res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao trocar senha' });
  }
});


app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
