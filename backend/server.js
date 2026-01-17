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

// ==================== MIDDLEWARE: VERIFICAR STATUS DO TENANT ====================
async function verificarStatusTenant(req, res, next) {
  // Pular verificação para rotas admin
  if (req.path.startsWith('/api/admin') || req.path === '/admin-panel.html' || req.path === '/test-update.html') {
    return next();
  }
  
  // Extrair subdomain do host (preparado para multitenancy)
  const host = req.hostname;
  const subdomain = host.split('.')[0];
  
  // Para desenvolvimento/teste, usar tenant ID 1 por padrão
  // Quando implementar subdomains reais, descomentar a lógica de subdomain
  let tenantId = 1; // ID padrão para testes
  
  try {
    // Buscar tenant pelo ID (ou subdomain quando implementar)
    const result = await pool.query(
      'SELECT status FROM tenants WHERE id = $1',
      [tenantId]
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
            .container {
              text-align: center;
              max-width: 500px;
            }
            h1 {
              font-size: 72px;
              margin-bottom: 20px;
              color: #ff6b00;
            }
            h2 {
              font-size: 28px;
              margin-bottom: 16px;
            }
            p {
              color: #999;
              font-size: 16px;
              line-height: 1.6;
            }
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
            .container {
              text-align: center;
              max-width: 500px;
            }
            h1 {
              font-size: 72px;
              margin-bottom: 20px;
              color: #ef4444;
            }
            h2 {
              font-size: 28px;
              margin-bottom: 16px;
            }
            p {
              color: #999;
              font-size: 16px;
              line-height: 1.6;
              margin-bottom: 12px;
            }
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
            <p>Entre em contato com o suporte para mais informações.</p>
            <div class="contact">
              <p>📧 Suporte: <a href="mailto:suporte@voleilab.com">suporte@voleilab.com</a></p>
            </div>
          </div>
        </body>
        </html>
      `);
    }
    
    // Verificar se está pendente (aguardando pagamento)
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
            .container {
              text-align: center;
              max-width: 500px;
            }
            h1 {
              font-size: 72px;
              margin-bottom: 20px;
              color: #fbbf24;
            }
            h2 {
              font-size: 28px;
              margin-bottom: 16px;
            }
            p {
              color: #999;
              font-size: 16px;
              line-height: 1.6;
              margin-bottom: 12px;
            }
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
            <p>Complete o pagamento para liberar o acesso completo.</p>
            <div class="contact">
              <p>💳 Dúvidas sobre pagamento: <a href="mailto:financeiro@voleilab.com">financeiro@voleilab.com</a></p>
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

// ==================== VERIFICAR MASTER ADMIN ====================
function verificarMasterAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token === 'admin@2026volei') {
    return next();
  }
  
  return res.status(401).json({ erro: 'Acesso negado' });
}

// Aplicar middleware de status ANTES de servir arquivos estáticos
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
    
    // 2. Atualizar email do admin apenas se mudou
    if (email) {
      console.log('Verificando se email mudou...');
      
      // Buscar email atual do admin
      const adminAtual = await pool.query(`
        SELECT usuario 
        FROM admins 
        WHERE tenant_id = $1
      `, [tenantId]);
      
      const emailAtual = adminAtual.rows[0]?.usuario;
      console.log('Email atual:', emailAtual, '| Email novo:', email);
      
      // Só atualizar se for diferente
      if (emailAtual !== email) {
        console.log('Email mudou, atualizando...');
        const adminResult = await pool.query(`
          UPDATE admins 
          SET usuario = $1 
          WHERE tenant_id = $2
          RETURNING *
        `, [email, tenantId]);
        
        console.log('Admin atualizado:', adminResult.rows[0]);
      } else {
        console.log('Email não mudou, mantendo o atual');
      }
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

// ==================== LOGIN ADMIN ====================
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

// ==================== ROTAS PRINCIPAIS (COM VERIFICAÇÃO DE STATUS) ====================

// CONFIRMAR PRESENÇA (salva em AMBAS as tabelas)
app.post('/confirmar', verificarStatusTenant, async (req, res) => {
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
app.get('/confirmados', verificarStatusTenant, async (req, res) => {
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
app.delete('/confirmados/:id', verificarStatusTenant, async (req, res) => {
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
app.delete('/confirmados', verificarStatusTenant, async (req, res) => {
  try {
    await pool.query('DELETE FROM confirmados_atual');
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao limpar:', err);
    res.status(500).json({ erro: 'Erro ao limpar lista' });
  }
});

// ESTATÍSTICAS (busca do histórico permanente)
app.get('/estatisticas', verificarStatusTenant, async (req, res) => {
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
    console.error('Erro ao editar presenças:', err);
    res.status(500).json({ erro: 'Erro ao editar presenças' });
  }
});

// REMOVER PESSOA DO HISTÓRICO (ADMIN APENAS)
app.delete('/estatisticas/pessoa/:nome', verificarAdmin, async (req, res) => {
  const { nome } = req.params;
  try {
    const result = await pool.query('DELETE FROM historico_confirmacoes WHERE nome = $1', [nome]);
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
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
