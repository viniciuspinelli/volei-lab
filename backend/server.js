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

// ==================== INIT DATABASE COM MULTI-TENANT ====================
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Criar tabela de tenants
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        subdomain VARCHAR(100),
        whatsapp_number VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        plano VARCHAR(20) DEFAULT 'mensal',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Criar tabela de admins (vincular a tenant)
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
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
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expira_em TIMESTAMP
      )
    `);
    
    // Criar tabela de confirmados por tenant
    await client.query(`
      CREATE TABLE IF NOT EXISTS confirmados_atual (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
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
        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Migração: criar tenant padrão se não existir
    const tenantCheck = await client.query('SELECT COUNT(*) FROM tenants');
    if (parseInt(tenantCheck.rows[0].count) === 0) {
      console.log('📦 Criando tenant padrão...');
      
      // Criar tenant padrão
      const tenantResult = await client.query(`
        INSERT INTO tenants (nome, subdomain, whatsapp_number, status, plano)
        VALUES ('Time Principal', 'default', '5511999999999', 'active', 'mensal')
        RETURNING id
      `);
      
      const tenantId = tenantResult.rows[0].id;
      
      // Criar admin padrão vinculado ao tenant
      const senhaHash = await bcrypt.hash('admin123', 10);
      await client.query(`
        INSERT INTO admins (tenant_id, usuario, senha_hash)
        VALUES ($1, $2, $3)
      `, [tenantId, 'admin', senhaHash]);
      
      console.log('✅ Tenant e admin padrão criados!');
    }
    
    await client.query('COMMIT');
    console.log('✅ Tabelas criadas/verificadas com sucesso!');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar tabelas:', err);
    throw err;
  } finally {
    client.release();
  }
}

initDB();

// ==================== MIDDLEWARE ====================
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
    req.tenantId = result.rows[0].tenant_id;
    next();
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao verificar token' });
  }
}

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// LOGIN
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
      'INSERT INTO admin_tokens (token, admin_id, tenant_id, expira_em) VALUES ($1, $2, $3, $4)',
      [token, admin.id, admin.tenant_id, expiraEm]
    );
    
    res.json({ sucesso: true, token });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ sucesso: false, erro: 'Erro no servidor' });
  }
});

// LOGOUT
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
    const result = await pool.query(`
      SELECT t.*, ten.nome as tenant_nome, ten.whatsapp_number
      FROM admin_tokens t
      JOIN tenants ten ON ten.id = t.tenant_id
      WHERE t.token = $1 AND t.expira_em > NOW()
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.json({ valido: false });
    }
    
    res.json({
      valido: true,
      tenant_id: result.rows[0].tenant_id,
      tenant_nome: result.rows[0].tenant_nome,
      whatsapp_number: result.rows[0].whatsapp_number
    });
  } catch (err) {
    res.json({ valido: false });
  }
});

// ==================== ROTAS DE CONFIRMADOS ====================

// CONFIRMAR PRESENÇA
app.post('/confirmar', verificarAdmin, async (req, res) => {
  const { nome, tipo, genero } = req.body;
  
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e gênero são obrigatórios' });
  }
  
  try {
    // Verifica se já tem 24 confirmados
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM confirmados_atual WHERE tenant_id = $1',
      [req.tenantId]
    );
    const total = parseInt(countResult.rows[0].total);
    
    if (total >= 24) {
      return res.status(400).json({ erro: 'Limite de 24 confirmados atingido!' });
    }
    
    // Salvar na lista atual (temporária)
    const resultAtual = await pool.query(
      'INSERT INTO confirmados_atual (tenant_id, nome, tipo, genero) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.tenantId, nome, tipo, genero]
    );
    
    // Salvar no histórico (permanente)
    await pool.query(
      'INSERT INTO historico_confirmacoes (tenant_id, nome, tipo, genero) VALUES ($1, $2, $3, $4)',
      [req.tenantId, nome, tipo, genero]
    );
    
    res.json({ sucesso: true, confirmado: resultAtual.rows[0] });
  } catch (err) {
    console.error('Erro ao confirmar:', err);
    res.status(500).json({ erro: 'Erro ao confirmar presença' });
  }
});

// LISTAR CONFIRMADOS
app.get('/confirmados', verificarAdmin, async (req, res) => {
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

// REMOVER CONFIRMADO
app.delete('/confirmados/:id', verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      'DELETE FROM confirmados_atual WHERE id = $1 AND tenant_id = $2',
      [id, req.tenantId]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao remover:', err);
    res.status(500).json({ erro: 'Erro ao remover' });
  }
});

// LIMPAR LISTA
app.delete('/confirmados', verificarAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM confirmados_atual WHERE tenant_id = $1', [req.tenantId]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao limpar:', err);
    res.status(500).json({ erro: 'Erro ao limpar lista' });
  }
});

// ==================== ROTAS DE ESTATÍSTICAS ====================

app.get('/estatisticas', verificarAdmin, async (req, res) => {
  try {
    const ranking = await pool.query(`
      SELECT 
        nome,
        tipo,
        genero,
        COUNT(*) as total_confirmacoes,
        MAX(data_confirmacao) as ultima_confirmacao
      FROM historico_confirmacoes
      WHERE tenant_id = $1
      GROUP BY nome, tipo, genero
      ORDER BY total_confirmacoes DESC, nome ASC
    `, [req.tenantId]);
    
    const totalConfirmacoes = await pool.query(
      'SELECT COUNT(*) as total FROM historico_confirmacoes WHERE tenant_id = $1',
      [req.tenantId]
    );
    
    const pessoasUnicas = await pool.query(
      'SELECT COUNT(DISTINCT nome) as total FROM historico_confirmacoes WHERE tenant_id = $1',
      [req.tenantId]
    );
    
    const total = parseInt(totalConfirmacoes.rows[0].total) || 0;
    const pessoas = parseInt(pessoasUnicas.rows[0].total) || 1;
    const media = pessoas > 0 ? (total / pessoas).toFixed(1) : 0;
    
    const rankingFormatado = ranking.rows.map(row => ({
      nome: row.nome,
      tipo: row.tipo,
      genero: row.genero,
      total_confirmacoes: parseInt(row.total_confirmacoes) || 0,
      ultima_confirmacao: row.ultima_confirmacao
    }));
    
    res.json({
      ranking: rankingFormatado,
      resumo: {
        totalConfirmacoes: total,
        pessoasUnicas: pessoas,
        mediaConfirmacoes: media
      }
    });
  } catch (err) {
    console.error('Erro nas estatísticas:', err);
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' });
  }
});

// REMOVER PESSOA DO HISTÓRICO
app.delete('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM historico_confirmacoes WHERE nome = $1 AND tenant_id = $2',
      [nome, req.tenantId]
    );
    
    await pool.query(
      'DELETE FROM confirmados_atual WHERE nome = $1 AND tenant_id = $2',
      [nome, req.tenantId]
    );
    
    res.json({ sucesso: true, removidos: result.rowCount });
  } catch (err) {
    console.error('Erro ao remover pessoa:', err);
    res.status(500).json({ erro: 'Erro ao remover pessoa das estatísticas' });
  }
});

// ==================== ROTAS ADMIN MASTER ====================
const MASTER_PASSWORD = 'admin@2026volei'; // ⚠️ TROQUE EM PRODUÇÃO!

function verificarMasterAdmin(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  
  if (auth !== MASTER_PASSWORD) {
    return res.status(403).json({ erro: 'Acesso negado' });
  }
  
  next();
}

// Listar todos os tenants
app.get('/api/admin/tenants', verificarMasterAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id,
        t.nome,
        t.subdomain,
        t.whatsapp_number,
        t.status,
        t.plano,
        t.criado_em,
        a.usuario as email
      FROM tenants t
      LEFT JOIN admins a ON a.tenant_id = t.id
      ORDER BY t.criado_em DESC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar tenants:', err);
    res.status(500).json({ erro: 'Erro no servidor', detalhes: err.message });
  }
});

// Buscar tenant específico
app.get('/api/admin/tenants/:id', verificarMasterAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.*,
        a.usuario as email
      FROM tenants t
      LEFT JOIN admins a ON a.tenant_id = t.id
      WHERE t.id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Tenant não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao buscar tenant:', err);
    res.status(500).json({ erro: 'Erro no servidor' });
  }
});

// Atualizar tenant
app.put('/api/admin/tenants/:id', verificarMasterAdmin, async (req, res) => {
  const { nome, email, whatsapp, status, plano } = req.body;
  const tenantId = req.params.id;
  
  console.log('=== PUT /api/admin/tenants/:id ===');
  console.log('Tenant ID:', tenantId);
  console.log('Body recebido:', req.body);
  
  try {
    // 1. Atualizar dados do tenant
    console.log('Atualizando tenant...');
    const tenantResult = await pool.query(`
      UPDATE tenants 
      SET nome = $1, 
          whatsapp_number = $2, 
          status = $3, 
          plano = $4
      WHERE id = $5
      RETURNING *
    `, [nome, whatsapp, status, plano, tenantId]);
    
    console.log('Tenant atualizado:', tenantResult.rows[0]);
    
    // 2. Atualizar email do admin se fornecido
    if (email) {
      console.log('Atualizando email do admin para:', email);
      const adminResult = await pool.query(`
        UPDATE admins 
        SET usuario = $1 
        WHERE tenant_id = $2
        RETURNING *
      `, [email, tenantId]);
      
      console.log('Admin atualizado:', adminResult.rows[0]);
    }
    
    console.log('✅ Atualização concluída com sucesso!');
    
    res.json({ 
      sucesso: true, 
      mensagem: 'Time atualizado com sucesso!',
      tenant: tenantResult.rows[0]
    });
  } catch (err) {
    console.error('❌ Erro ao atualizar tenant:', err);
    console.error('Stack:', err.stack);
    
    res.status(500).json({ 
      erro: 'Erro ao atualizar', 
      detalhes: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ==================== ROTA DE MIGRAÇÃO ====================
app.post('/api/migrate', async (req, res) => {
  const logs = [];
  
  try {
    logs.push('📦 Iniciando migração...');
    
    // 1. Criar tabela de tenants se não existir
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        subdomain VARCHAR(100),
        whatsapp_number VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        plano VARCHAR(20) DEFAULT 'mensal',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    logs.push('✅ Tabela tenants criada');
    
    // 2. Verificar se já existe tenant padrão
    const tenantCheck = await pool.query('SELECT COUNT(*) FROM tenants');
    let tenantId;
    
    if (parseInt(tenantCheck.rows[0].count) === 0) {
      const tenantResult = await pool.query(`
        INSERT INTO tenants (nome, subdomain, whatsapp_number, status, plano)
        VALUES ('Time Principal', 'default', '5511999999999', 'active', 'mensal')
        RETURNING id
      `);
      tenantId = tenantResult.rows[0].id;
      logs.push(`✅ Tenant padrão criado (ID: ${tenantId})`);
    } else {
      const tenant = await pool.query('SELECT id FROM tenants LIMIT 1');
      tenantId = tenant.rows[0].id;
      logs.push(`✅ Tenant existente encontrado (ID: ${tenantId})`);
    }
    
    // 3. Adicionar coluna tenant_id em admins se não existir
    try {
      await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      logs.push('✅ Coluna tenant_id adicionada em admins');
    } catch (e) {
      logs.push('⚠️ Coluna tenant_id já existe em admins');
    }
    
    // 4. Atualizar admins sem tenant_id
    await pool.query('UPDATE admins SET tenant_id = $1 WHERE tenant_id IS NULL', [tenantId]);
    logs.push('✅ Admins associados ao tenant');
    
    // 5. Adicionar coluna tenant_id em admin_tokens se não existir
    try {
      await pool.query('ALTER TABLE admin_tokens ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      logs.push('✅ Coluna tenant_id adicionada em admin_tokens');
    } catch (e) {
      logs.push('⚠️ Coluna tenant_id já existe em admin_tokens');
    }
    
    // 6. Atualizar tokens sem tenant_id
    await pool.query(`
      UPDATE admin_tokens 
      SET tenant_id = $1 
      WHERE tenant_id IS NULL
    `, [tenantId]);
    logs.push('✅ Tokens associados ao tenant');
    
    // 7. Adicionar coluna tenant_id em confirmados_atual se não existir
    try {
      await pool.query('ALTER TABLE confirmados_atual ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      logs.push('✅ Coluna tenant_id adicionada em confirmados_atual');
    } catch (e) {
      logs.push('⚠️ Coluna tenant_id já existe em confirmados_atual');
    }
    
    // 8. Atualizar confirmados sem tenant_id
    await pool.query('UPDATE confirmados_atual SET tenant_id = $1 WHERE tenant_id IS NULL', [tenantId]);
    logs.push('✅ Confirmados associados ao tenant');
    
    // 9. Adicionar coluna tenant_id em historico_confirmacoes se não existir
    try {
      await pool.query('ALTER TABLE historico_confirmacoes ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE');
      logs.push('✅ Coluna tenant_id adicionada em historico_confirmacoes');
    } catch (e) {
      logs.push('⚠️ Coluna tenant_id já existe em historico_confirmacoes');
    }
    
    // 10. Atualizar histórico sem tenant_id
    await pool.query('UPDATE historico_confirmacoes SET tenant_id = $1 WHERE tenant_id IS NULL', [tenantId]);
    logs.push('✅ Histórico associado ao tenant');
    
    logs.push('🎉 Migração concluída com sucesso!');
    
    res.json({ sucesso: true, logs });
  } catch (err) {
    console.error('Erro na migração:', err);
    logs.push(`❌ Erro: ${err.message}`);
    res.status(500).json({ sucesso: false, erro: err.message, logs });
  }
});

// ==================== ROTA DE CORREÇÃO DE SCHEMA ====================
app.post('/api/fix-schema', async (req, res) => {
  const logs = [];
  
  try {
    logs.push('🔧 Corrigindo estrutura da tabela tenants...');
    
    // Adicionar coluna criado_em se não existir
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    logs.push('✅ Coluna criado_em adicionada/verificada');
    
    // Adicionar outras colunas que possam estar faltando
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS nome VARCHAR(255) NOT NULL DEFAULT 'Time Sem Nome'
    `);
    logs.push('✅ Coluna nome verificada');
    
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100)
    `);
    logs.push('✅ Coluna subdomain verificada');
    
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(20)
    `);
    logs.push('✅ Coluna whatsapp_number verificada');
    
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'
    `);
    logs.push('✅ Coluna status verificada');
    
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS plano VARCHAR(20) DEFAULT 'mensal'
    `);
    logs.push('✅ Coluna plano verificada');
    
    // Atualizar registros existentes sem criado_em
    await pool.query(`
      UPDATE tenants 
      SET criado_em = CURRENT_TIMESTAMP 
      WHERE criado_em IS NULL
    `);
    logs.push('✅ Datas de criação atualizadas');
    
    logs.push('🎉 Correção de estrutura concluída!');
    
    res.json({ sucesso: true, logs });
  } catch (err) {
    console.error('Erro na correção:', err);
    logs.push(`❌ Erro: ${err.message}`);
    res.status(500).json({ sucesso: false, erro: err.message, logs });
  }
});


// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
