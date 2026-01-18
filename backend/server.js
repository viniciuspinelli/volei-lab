const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
    
    // Criar tabela de confirmados atuais com tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS confirmados_atual (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);
    
    // Criar tabela de histórico com tenant_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS historico_confirmacoes (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        nome VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        genero VARCHAR(50),
        data_confirmacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);
    
    // Criar tabela de admins
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER UNIQUE,
        usuario VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
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
    
    // Criar índices
    await client.query('CREATE INDEX IF NOT EXISTS idx_confirmados_tenant ON confirmados_atual(tenant_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_historico_tenant ON historico_confirmacoes(tenant_id)');
    
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

// ==================== MIDDLEWARE: EXTRAIR TENANT_ID ====================
async function extrairTenantId(req, res, next) {
  // Rotas que não precisam de tenant_id
  if (req.path.startsWith('/api/admin') || 
      req.path === '/admin-panel.html' ||
      req.path === '/login' ||
      req.path === '/logout' ||
      req.path === '/verificar-token') {
    return next();
  }
  
  // 1. Tentar pegar tenant_id do token de autenticação
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token) {
    try {
      const result = await pool.query(`
        SELECT a.tenant_id 
        FROM admin_tokens t 
        JOIN admins a ON a.id = t.admin_id 
        WHERE t.token = $1 AND t.expira_em > NOW()
      `, [token]);
      
      if (result.rows.length > 0) {
        req.tenantId = result.rows[0].tenant_id;
        console.log('✅ Tenant extraído do token:', req.tenantId);
        return next();
      }
    } catch (err) {
      console.error('Erro ao buscar tenant do token:', err);
    }
  }
  
  // 2. Fallback: query parameter ?tenant=X (para testes sem login)
  const tenantQuery = req.query.tenant;
  if (tenantQuery) {
    req.tenantId = parseInt(tenantQuery);
    console.log('⚠️ Tenant extraído da query:', req.tenantId);
    return next();
  }
  
  // 3. Padrão: tenant_id = 1 (compatibilidade)
  req.tenantId = 1;
  console.log('⚠️ Usando tenant padrão: 1');
  next();
}

// ==================== MIDDLEWARE: VERIFICAR STATUS DO TENANT ====================
async function verificarStatusTenant(req, res, next) {
  // Pular verificação para rotas admin e arquivos estáticos
  if (req.path.startsWith('/api/admin') || 
      req.path === '/admin-panel.html' || 
      req.path === '/test-update.html' ||
      req.path.match(/\.(css|js|jpg|png|gif|ico)$/)) {
    return next();
  }
  
  // Se não tem tenant_id, deixar passar
  if (!req.tenantId) {
    return next();
  }
  
  try {
    const result = await pool.query(
      'SELECT status FROM tenants WHERE id = $1',
      [req.tenantId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Time não encontrado</title>
          <style>
            body {
              font-family: 'Inter', sans-serif;
              background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
            }
            .container { text-align: center; max-width: 500px; }
            h1 { font-size: 72px; margin-bottom: 20px; color: #ff6b00; }
            h2 { font-size: 28px; margin-bottom: 16px; }
            p { color: #999; font-size: 16px; line-height: 1.6; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌</h1>
            <h2>Time não encontrado</h2>
            <p>O time que você está tentando acessar não existe ou foi removido.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    const tenant = result.rows[0];
    
    // Verificar se está inativo
    if (tenant.status === 'inactive') {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Acesso Bloqueado</title>
          <style>
            body {
              font-family: 'Inter', sans-serif;
              background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
            }
            .container { text-align: center; max-width: 500px; }
            h1 { font-size: 72px; margin-bottom: 20px; color: #ef4444; }
            h2 { font-size: 28px; margin-bottom: 16px; }
            p { color: #999; font-size: 16px; line-height: 1.6; margin-bottom: 12px; }
            .contact {
              margin-top: 24px;
              padding: 16px;
              background: rgba(255,107,0,0.1);
              border: 1px solid rgba(255,107,0,0.3);
              border-radius: 12px;
            }
            .contact a {
              color: #ff6b00;
              text-decoration: none;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🔒</h1>
            <h2>Acesso Bloqueado</h2>
            <p>Este time está com o acesso desativado.</p>
            <p>Entre em contato com o suporte para reativar.</p>
            <div class="contact">
              <p>📧 Suporte: <a href="mailto:suporte@voleilab.com">suporte@voleilab.com</a></p>
            </div>
          </div>
        </body>
        </html>
      `);
    }
    
    // Verificar se está pendente
    if (tenant.status === 'pending') {
      return res.status(402).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Pagamento Pendente</title>
          <style>
            body {
              font-family: 'Inter', sans-serif;
              background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
            }
            .container { text-align: center; max-width: 500px; }
            h1 { font-size: 72px; margin-bottom: 20px; color: #fbbf24; }
            h2 { font-size: 28px; margin-bottom: 16px; }
            p { color: #999; font-size: 16px; line-height: 1.6; margin-bottom: 12px; }
            .contact {
              margin-top: 24px;
              padding: 16px;
              background: rgba(251,191,36,0.1);
              border: 1px solid rgba(251,191,36,0.3);
              border-radius: 12px;
            }
            .contact a {
              color: #fbbf24;
              text-decoration: none;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⏳</h1>
            <h2>Pagamento Pendente</h2>
            <p>Seu time está aguardando confirmação de pagamento.</p>
            <p>Complete o pagamento para liberar o acesso.</p>
            <div class="contact">
              <p>💳 Financeiro: <a href="mailto:financeiro@voleilab.com">financeiro@voleilab.com</a></p>
            </div>
          </div>
        </body>
        </html>
      `);
    }
    
    // Status 'active' - permitir acesso
    next();
    
  } catch (err) {
    console.error('Erro ao verificar status do tenant:', err);
    next(); // Em caso de erro, permitir acesso (fail-safe)
  }
}

// ==================== MIDDLEWARE: Verificar token admin ====================
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

// ==================== MIDDLEWARE: Master Admin ====================
function verificarMasterAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token === 'admin@2026volei') {
    return next();
  }
  
  return res.status(401).json({ erro: 'Acesso negado' });
}

// Aplicar middlewares na ordem correta
app.use(extrairTenantId);
app.use(verificarStatusTenant);
app.use(express.static('public'));

// ==================== ROTAS ADMIN PAINEL ====================

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
        t.data_vencimento,
        t.criado_em,
        a.usuario as email
      FROM tenants t
      LEFT JOIN admins a ON a.tenant_id = t.id
      ORDER BY t.id ASC
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar tenants:', err);
    res.status(500).json({ erro: 'Erro ao listar tenants' });
  }
});

// Buscar tenant específico
app.get('/api/admin/tenants/:id', verificarMasterAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.id,
        t.nome,
        t.subdomain,
        t.whatsapp_number,
        t.status,
        t.plano,
        t.data_vencimento,
        t.criado_em,
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
    res.status(500).json({ erro: 'Erro ao buscar tenant' });
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
    
    // 2. Atualizar email do admin apenas se mudou
    if (email) {
      const adminAtual = await pool.query(`
        SELECT usuario 
        FROM admins 
        WHERE tenant_id = $1
      `, [tenantId]);
      
      const emailAtual = adminAtual.rows[0]?.usuario;
      
      if (emailAtual !== email) {
        await pool.query(`
          UPDATE admins 
          SET usuario = $1 
          WHERE tenant_id = $2
        `, [email, tenantId]);
      }
    }
    
    console.log('✅ Atualização concluída!');
    
    res.json({ 
      sucesso: true, 
      mensagem: 'Time atualizado com sucesso!',
      tenant: tenantResult.rows[0]
    });
  } catch (err) {
    console.error('❌ Erro ao atualizar tenant:', err);
    res.status(500).json({ 
      erro: 'Erro ao atualizar', 
      detalhes: err.message
    });
  }
});

// ==================== ROTAS PRINCIPAIS COM TENANT_ID ====================

// CONFIRMAR PRESENÇA
app.post('/confirmar', async (req, res) => {
  const { nome, tipo, genero } = req.body;
  const tenantId = req.tenantId || 1;
  
  console.log('=== POST /confirmar ===');
  console.log('Tenant ID:', tenantId);
  console.log('Nome:', nome);
  
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e gênero são obrigatórios' });
  }
  
  try {
    // Verifica se já tem 24 confirmados DESTE TENANT
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM confirmados_atual WHERE tenant_id = $1',
      [tenantId]
    );
    const total = parseInt(countResult.rows[0].total);
    
    if (total >= 24) {
      return res.status(400).json({ erro: 'Limite de 24 confirmados atingido!' });
    }
    
    // Salvar na lista atual
    const resultAtual = await pool.query(
      'INSERT INTO confirmados_atual (tenant_id, nome, tipo, genero) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenantId, nome, tipo, genero]
    );
    
    // Salvar no histórico
    await pool.query(
      'INSERT INTO historico_confirmacoes (tenant_id, nome, tipo, genero) VALUES ($1, $2, $3, $4)',
      [tenantId, nome, tipo, genero]
    );
    
    console.log('✅ Confirmado salvo com tenant_id:', tenantId);
    res.json({ sucesso: true, confirmado: resultAtual.rows[0] });
  } catch (err) {
    console.error('Erro ao confirmar:', err);
    res.status(500).json({ erro: 'Erro ao confirmar presença' });
  }
});

// LISTAR CONFIRMADOS ATUAIS
app.get('/confirmados', async (req, res) => {
  const tenantId = req.tenantId || 1;
  
  console.log('=== GET /confirmados ===');
  console.log('Tenant ID:', tenantId);
  
  try {
    const result = await pool.query(
      'SELECT * FROM confirmados_atual WHERE tenant_id = $1 ORDER BY data_confirmacao ASC LIMIT 24',
      [tenantId]
    );
    
    console.log('✅ Registros retornados:', result.rows.length);
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao listar:', err);
    res.status(500).json({ erro: 'Erro ao listar confirmados' });
  }
});

// REMOVER CONFIRMADO ATUAL
app.delete('/confirmados/:id', async (req, res) => {
  const { id } = req.params;
  const tenantId = req.tenantId || 1;
  
  try {
    await pool.query(
      'DELETE FROM confirmados_atual WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao remover:', err);
    res.status(500).json({ erro: 'Erro ao remover' });
  }
});

// LIMPAR LISTA DE CONFIRMADOS ATUAIS
app.delete('/confirmados', async (req, res) => {
  const tenantId = req.tenantId || 1;
  
  try {
    await pool.query('DELETE FROM confirmados_atual WHERE tenant_id = $1', [tenantId]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao limpar:', err);
    res.status(500).json({ erro: 'Erro ao limpar lista' });
  }
});

// ESTATÍSTICAS
app.get('/estatisticas', async (req, res) => {
  const tenantId = req.tenantId || 1;
  
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
    `, [tenantId]);
    
    const totalConfirmacoes = await pool.query(
      'SELECT COUNT(*) as total FROM historico_confirmacoes WHERE tenant_id = $1',
      [tenantId]
    );
    
    const pessoasUnicas = await pool.query(
      'SELECT COUNT(DISTINCT nome) as total FROM historico_confirmacoes WHERE tenant_id = $1',
      [tenantId]
    );
    
    const total = parseInt(totalConfirmacoes.rows[0].total) || 0;
    const pessoas = parseInt(pessoasUnicas.rows[0].total) || 1;
    const media = pessoas > 0 ? (total / pessoas).toFixed(1) : 0;
    
    const porGenero = await pool.query(`
      SELECT 
        genero,
        COUNT(*) as total,
        COUNT(DISTINCT nome) as pessoas
      FROM historico_confirmacoes
      WHERE tenant_id = $1
      GROUP BY genero
    `, [tenantId]);
    
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
    console.error('Erro nas estatísticas:', err);
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' });
  }
});

// EDITAR NÚMERO DE PRESENÇAS (ADMIN)
app.put('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  const { novoTotal } = req.body;
  const tenantId = req.tenantId || 1;
  
  if (!novoTotal || novoTotal < 0) {
    return res.status(400).json({ erro: 'Informe um número válido de presenças' });
  }
  
  try {
    const pessoa = await pool.query(
      'SELECT tipo, genero, COUNT(*) as atual FROM historico_confirmacoes WHERE nome = $1 AND tenant_id = $2 GROUP BY tipo, genero',
      [nome, tenantId]
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
          'INSERT INTO historico_confirmacoes (tenant_id, nome, tipo, genero) VALUES ($1, $2, $3, $4)',
          [tenantId, nome, tipo, genero]
        );
      }
    } else if (diferenca < 0) {
      await pool.query(
        `DELETE FROM historico_confirmacoes
         WHERE id IN (
           SELECT id FROM historico_confirmacoes
           WHERE nome = $1 AND tenant_id = $2
           ORDER BY data_confirmacao DESC
           LIMIT $3
         )`,
        [nome, tenantId, Math.abs(diferenca)]
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
  const tenantId = req.tenantId || 1;
  
  try {
    const result = await pool.query(
      'DELETE FROM historico_confirmacoes WHERE nome = $1 AND tenant_id = $2',
      [nome, tenantId]
    );
    await pool.query(
      'DELETE FROM confirmados_atual WHERE nome = $1 AND tenant_id = $2',
      [nome, tenantId]
    );
    res.json({ sucesso: true, removidos: result.rowCount });
  } catch (err) {
    console.error('Erro ao remover pessoa:', err);
    res.status(500).json({ erro: 'Erro ao remover pessoa das estatísticas' });
  }
});

// ==================== LOGIN/LOGOUT ====================

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  try {
    const result = await pool.query(
      'SELECT a.*, a.tenant_id FROM admins a WHERE usuario = $1',
      [usuario]
    );
    
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
    
    console.log('✅ Login realizado - Tenant ID:', admin.tenant_id);
    
    res.json({ 
      sucesso: true, 
      token,
      tenant_id: admin.tenant_id
    });
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
    const result = await pool.query(
      'SELECT * FROM admin_tokens WHERE token = $1 AND expira_em > NOW()',
      [token]
    );
    res.json({ valido: result.rows.length > 0 });
  } catch (err) {
    res.json({ valido: false });
  }
});

// ==================== ROTA DE DEBUG (TEMPORÁRIA) ====================
app.get('/api/debug/tenant-check', async (req, res) => {
  const tenantId = req.tenantId;
  
  try {
    const confirmados = await pool.query(
      'SELECT id, tenant_id, nome FROM confirmados_atual WHERE tenant_id = $1',
      [tenantId]
    );
    
    const todosConfirmados = await pool.query(
      'SELECT id, tenant_id, nome FROM confirmados_atual ORDER BY tenant_id, id'
    );
    
    res.json({
      req_tenantId: tenantId,
      confirmados_deste_tenant: confirmados.rows,
      todos_confirmados_no_banco: todosConfirmados.rows
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ==================== ROTA DE REGISTRO ====================
app.post('/api/registro', async (req, res) => {
  const { nome_time, nome_usuario, email, telefone, whatsapp, senha } = req.body;
  
  console.log('=== POST /api/registro ===');
  console.log('Body recebido:', req.body);
  
  if (!nome_time || !nome_usuario || !email || !senha) {
    return res.status(400).json({ erro: 'Campos obrigatórios: Nome do Time, Nome, Email e Senha' });
  }
  
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Verificar se email já existe
    console.log('Verificando se email existe...');
    const emailExiste = await client.query(
      'SELECT id FROM admins WHERE usuario = $1',
      [email]
    );
    
    if (emailExiste.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Este email já está cadastrado' });
    }
    
    // Gerar subdomain
    const subdomain = nome_time.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    
    console.log('Criando tenant...');
    const tenantResult = await client.query(`
      INSERT INTO tenants (nome, subdomain, whatsapp_number, status, plano)
      VALUES ($1, $2, $3, 'active', 'mensal')
      RETURNING id
    `, [nome_time, subdomain, whatsapp || '']);
    
    const tenantId = tenantResult.rows[0].id;
    console.log('Tenant criado com ID:', tenantId);
    
    // Hash da senha
    console.log('Gerando hash da senha...');
    const senhaHash = await bcrypt.hash(senha, 10);
    
    // Criar admin COM status
    console.log('Criando admin...');
    await client.query(`
      INSERT INTO admins (tenant_id, usuario, senha_hash, status)
      VALUES ($1, $2, $3, $4)
    `, [tenantId, email, senhaHash, 'active']);
    
    await client.query('COMMIT');
    console.log('✅ Conta criada com sucesso!');
    
    res.json({ 
      sucesso: true, 
      mensagem: 'Conta criada com sucesso!',
      tenant_id: tenantId
    });
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro detalhado:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ 
      erro: 'Erro ao criar conta: ' + err.message
    });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
