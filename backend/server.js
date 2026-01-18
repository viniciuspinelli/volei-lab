const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cron = require('node-cron');
const mercadopago = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configurar Mercado Pago
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN
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
      req.path === '/login.html' || 
      req.path === '/registro' || 
      req.path === '/logout' || 
      req.path === '/verificar-token' ||
      req.path === '/webhook/mercadopago') {
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
  // Pular verificação para rotas admin, API, webhook e arquivos estáticos
  if (req.path.startsWith('/api/') || 
      req.path.startsWith('/admin-panel') || 
      req.path === '/login' || 
      req.path === '/login.html' || 
      req.path === '/registro' || 
      req.path === '/verificar-token' ||
      req.path === '/webhook/mercadopago' ||
      req.path.match(/\.(css|js|jpg|png|gif|ico)$/)) {
    return next();
  }

  // Verificar apenas para páginas HTML
  if (req.path.match(/\.(html)$/) || req.path === '/') {
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
          <html><head><meta charset="UTF-8"><title>Time não encontrado</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h1>❌ Time não encontrado</h1>
            <p>O time que você está tentando acessar não existe ou foi removido.</p>
          </body></html>
        `);
      }

      const status = result.rows[0].status;

      if (status === 'inactive') {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html><head><meta charset="UTF-8"><title>Time desativado</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h1>🔒 Acesso bloqueado</h1>
            <p>Este time está desativado.</p>
          </body></html>
        `);
      }

      if (status === 'pending' || status === 'expired') {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html><head><meta charset="UTF-8"><title>Pagamento pendente</title></head>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h1>⏳ Assinatura ${status === 'expired' ? 'expirada' : 'pendente'}</h1>
            <p>Aguardando confirmação de pagamento.</p>
            <a href="/payment.html" style="display: inline-block; margin-top: 20px; padding: 15px 30px; background: #009ee3; color: white; text-decoration: none; border-radius: 8px;">
              Assinar agora
            </a>
          </body></html>
        `);
      }
    } catch (error) {
      console.error('Erro ao verificar status do tenant:', error);
    }
  }
  
  next();
}

// Aplicar middlewares
app.use(extrairTenantId);
app.use(verificarStatusTenant);
app.use(express.static('public'));

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Login
app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  
  try {
    const result = await pool.query(
      'SELECT * FROM admins WHERE usuario = $1',
      [usuario]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    const admin = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, admin.senha_hash);

    if (!senhaValida) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    // Gerar token
    const token = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

    await pool.query(
      'INSERT INTO admin_tokens (token, admin_id, expira_em) VALUES ($1, $2, $3)',
      [token, admin.id, expiraEm]
    );

    res.json({ 
      success: true, 
      token,
      tenant_id: admin.tenant_id
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Verificar token
app.get('/verificar-token', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ valid: false });
  }

  try {
    const result = await pool.query(`
      SELECT a.tenant_id, a.usuario, t.expira_em
      FROM admin_tokens t
      JOIN admins a ON a.id = t.admin_id
      WHERE t.token = $1 AND t.expira_em > NOW()
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(401).json({ valid: false });
    }

    res.json({ 
      valid: true,
      tenant_id: result.rows[0].tenant_id,
      usuario: result.rows[0].usuario
    });
  } catch (error) {
    console.error('Erro ao verificar token:', error);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token) {
    try {
      await pool.query('DELETE FROM admin_tokens WHERE token = $1', [token]);
    } catch (error) {
      console.error('Erro ao fazer logout:', error);
    }
  }
  
  res.json({ success: true });
});

// ==================== ROTAS DE CONFIRMAÇÃO ====================

// Buscar confirmados atuais
app.get('/confirmados', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM confirmados_atual WHERE tenant_id = $1 ORDER BY data_confirmacao DESC',
      [req.tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar confirmados:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
});

// Adicionar confirmado
app.post('/confirmados', async (req, res) => {
  const { nome, tipo, genero } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO confirmados_atual (tenant_id, nome, tipo, genero) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [req.tenantId, nome, tipo, genero]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao adicionar confirmado:', err);
    res.status(500).json({ error: 'Erro ao adicionar confirmado' });
  }
});

// Remover confirmado
app.delete('/confirmados/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM confirmados_atual WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao remover confirmado:', err);
    res.status(500).json({ error: 'Erro ao remover confirmado' });
  }
});

// Limpar lista
app.delete('/limpar', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Mover para histórico
    await client.query(
      `INSERT INTO historico_confirmacoes (tenant_id, nome, tipo, genero, data_confirmacao)
       SELECT tenant_id, nome, tipo, genero, data_confirmacao 
       FROM confirmados_atual 
       WHERE tenant_id = $1`,
      [req.tenantId]
    );
    
    // Limpar atual
    await client.query(
      'DELETE FROM confirmados_atual WHERE tenant_id = $1',
      [req.tenantId]
    );
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao limpar lista:', err);
    res.status(500).json({ error: 'Erro ao limpar lista' });
  } finally {
    client.release();
  }
});

// Buscar estatísticas
app.get('/estatisticas', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT nome, COUNT(*) as total 
       FROM historico_confirmacoes 
       WHERE tenant_id = $1
       GROUP BY nome 
       ORDER BY total DESC`,
      [req.tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao buscar estatísticas:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// ==================== ROTAS ADMIN ====================

// Listar todos os tenants (super admin)
app.get('/api/admin/tenants', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, email, status, subscription_plan, 
             subscription_expires, created_at,
             CASE 
               WHEN subscription_expires < NOW() AND status = 'active' THEN true
               ELSE false
             END as is_expired
      FROM tenants 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar tenants:', error);
    res.status(500).json({ error: 'Erro ao buscar tenants' });
  }
});

// Atualizar tenant
app.put('/api/admin/tenants/:id', async (req, res) => {
  const { id } = req.params;
  const { status, subscription_plan, subscription_expires } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE tenants 
       SET status = $1, 
           subscription_plan = $2, 
           subscription_expires = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, subscription_plan, subscription_expires, id]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar tenant:', error);
    res.status(500).json({ error: 'Erro ao atualizar tenant' });
  }
});

// ==================== MERCADO PAGO ====================

// Criar pagamento
app.post('/api/create-payment', async (req, res) => {
  const { plano, tenant_id } = req.body;
  
  const precos = {
    mensal: 29.90,
    anual: 299.00
  };

  try {
    const preference = {
      items: [
        {
          title: `VoleiLab - Plano ${plano.charAt(0).toUpperCase() + plano.slice(1)}`,
          unit_price: precos[plano],
          quantity: 1,
          currency_id: 'BRL'
        }
      ],
      back_urls: {
        success: `${process.env.BASE_URL || 'https://volei-lab.onrender.com'}/success.html`,
        failure: `${process.env.BASE_URL || 'https://volei-lab.onrender.com'}/failure.html`,
        pending: `${process.env.BASE_URL || 'https://volei-lab.onrender.com'}/success.html`
      },
      auto_return: 'approved',
      metadata: {
        tenant_id: tenant_id,
        plano: plano
      },
      notification_url: `${process.env.BASE_URL || 'https://volei-lab.onrender.com'}/webhook/mercadopago`
    };

    const response = await mercadopago.preferences.create(preference);
    res.json({ id: response.body.id, init_point: response.body.init_point });
    
  } catch (error) {
    console.error('Erro ao criar pagamento:', error);
    res.status(500).json({ error: 'Erro ao processar pagamento' });
  }
});

// ========== WEBHOOK MERCADO PAGO ==========
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data, action } = req.body;
    
    console.log('📩 Webhook recebido:', { type, action, data });
    
    // Mercado Pago pode enviar vários tipos de notificação
    if (type === 'payment' || action === 'payment.created' || action === 'payment.updated') {
      const paymentId = data.id;
      
      // Buscar detalhes completos do pagamento
      const payment = await mercadopago.payment.findById(paymentId);
      const paymentData = payment.body;
      
      console.log('💳 Pagamento ID:', paymentId);
      console.log('📊 Status:', paymentData.status);
      console.log('📦 Metadata:', paymentData.metadata);
      
      const tenantId = paymentData.metadata?.tenant_id;
      const plano = paymentData.metadata?.plano;
      
      if (!tenantId || !plano) {
        console.log('⚠️  Metadata incompleta, ignorando...');
        return res.status(200).send('OK');
      }
      
      // Processar pagamento aprovado
      if (paymentData.status === 'approved') {
        const mesesValidade = plano === 'mensal' ? 1 : 12;
        const dataExpiracao = new Date();
        dataExpiracao.setMonth(dataExpiracao.getMonth() + mesesValidade);
        
        await pool.query(
          `UPDATE tenants 
           SET status = 'active',
               subscription_plan = $1,
               subscription_expires = $2,
               mercadopago_payment_id = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [plano, dataExpiracao, paymentId, tenantId]
        );
        
        console.log(`✅ Tenant ${tenantId} ATIVADO até ${dataExpiracao.toLocaleDateString('pt-BR')}`);
      }
      
      // Processar pagamento rejeitado/cancelado
      else if (paymentData.status === 'rejected' || paymentData.status === 'cancelled') {
        await pool.query(
          `UPDATE tenants 
           SET status = 'pending',
               updated_at = NOW()
           WHERE id = $1`,
          [tenantId]
        );
        
        console.log(`❌ Pagamento rejeitado para tenant ${tenantId}`);
      }
      
      // Pagamento pendente (boleto, pix aguardando)
      else if (paymentData.status === 'pending') {
        console.log(`⏳ Pagamento pendente para tenant ${tenantId}`);
      }
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('❌ Erro no webhook:', error);
    res.status(500).send('Error');
  }
});

// ========== CRON JOB - VERIFICAR ASSINATURAS ==========
// Executa todo dia às 02:00 AM
cron.schedule('0 2 * * *', async () => {
  try {
    console.log('🔍 Verificando assinaturas expiradas...');
    
    const result = await pool.query(
      `UPDATE tenants 
       SET status = 'expired'
       WHERE status = 'active' 
       AND subscription_expires < NOW()`
    );
    
    if (result.rowCount > 0) {
      console.log(`⚠️  ${result.rowCount} assinatura(s) expirada(s)`);
    } else {
      console.log('✅ Todas as assinaturas estão ativas');
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar assinaturas:', error);
  }
});

// ========== ROTAS DE MIGRAÇÃO (TEMPORÁRIAS) ==========
app.post('/api/migrate/add-column', async (req, res) => {
  const { column } = req.body;
  try {
    await pool.query(`
      ALTER TABLE tenants 
      ADD COLUMN IF NOT EXISTS ${column} ${column.includes('timestamp') ? 'TIMESTAMP DEFAULT NOW()' : 'VARCHAR(255)'}
    `);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/migrate/add-constraint', async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE tenants 
      ADD CONSTRAINT IF NOT EXISTS tenants_status_check 
      CHECK (status IN ('active', 'pending', 'expired', 'inactive'))
    `);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/migrate/create-default-tenant', async (req, res) => {
  try {
    const result = await pool.query(`
      INSERT INTO tenants (id, name, email, status, subscription_plan, subscription_expires)
      VALUES (1, 'Time Principal', 'admin@voleilab.com', 'active', 'mensal', NOW() + INTERVAL '30 days')
      ON CONFLICT (id) DO NOTHING
    `);
    res.json({ success: true, rows: result.rowCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log('⏰ Cron job de assinaturas ativado');
});
