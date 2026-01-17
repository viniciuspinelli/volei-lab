const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('🔄 Iniciando migração multi-tenant...');
    
    // 1. Criar tabela de tenants
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        subdomain VARCHAR(50) UNIQUE,
        whatsapp_number VARCHAR(20),
        whatsapp_api_token VARCHAR(255),
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'trial', 'canceled')),
        plano VARCHAR(20) CHECK (plano IN ('mensal', 'trimestral', 'anual')),
        data_inicio DATE DEFAULT CURRENT_DATE,
        data_vencimento DATE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabela tenants criada');
    
    // 2. Adicionar tenant_id aos admins (se não existir)
    const checkAdminTenant = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'admins' AND column_name = 'tenant_id'
    `);
    
    if (checkAdminTenant.rows.length === 0) {
      await client.query('ALTER TABLE admins ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)');
      console.log('✅ Campo tenant_id adicionado em admins');
    }
    
    // 3. Adicionar tenant_id nas tabelas de confirmação
    const tables = ['confirmados_atual', 'historico_confirmacoes'];
    
    for (const table of tables) {
      const checkColumn = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = 'tenant_id'
      `, [table]);
      
      if (checkColumn.rows.length === 0) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)`);
        console.log(`✅ Campo tenant_id adicionado em ${table}`);
      }
    }
    
    // 4. Criar tenant padrão para dados existentes
    const tenantCheck = await client.query('SELECT id FROM tenants WHERE subdomain = $1', ['principal']);
    
    let tenantId;
    if (tenantCheck.rows.length === 0) {
      const result = await client.query(`
        INSERT INTO tenants (nome, subdomain, status, plano)
        VALUES ('Time Principal', 'principal', 'active', 'mensal')
        RETURNING id
      `);
      tenantId = result.rows[0].id;
      console.log(`✅ Tenant padrão criado com ID: ${tenantId}`);
    } else {
      tenantId = tenantCheck.rows[0].id;
      console.log(`ℹ️  Tenant padrão já existe com ID: ${tenantId}`);
    }
    
    // 5. Atualizar dados existentes com o tenant padrão
    await client.query(`UPDATE admins SET tenant_id = $1 WHERE tenant_id IS NULL`, [tenantId]);
    await client.query(`UPDATE confirmados_atual SET tenant_id = $1 WHERE tenant_id IS NULL`, [tenantId]);
    await client.query(`UPDATE historico_confirmacoes SET tenant_id = $1 WHERE tenant_id IS NULL`, [tenantId]);
    console.log('✅ Dados existentes migrados para tenant padrão');
    
    // 6. Criar tabela de usuários (separado de admins)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email VARCHAR(100) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        nome VARCHAR(100) NOT NULL,
        telefone VARCHAR(20),
        role VARCHAR(20) DEFAULT 'tenant_admin' CHECK (role IN ('super_admin', 'tenant_admin', 'member')),
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ultimo_login TIMESTAMP
      )
    `);
    console.log('✅ Tabela users criada');
    
    // 7. Criar índices para performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_confirmados_atual_tenant ON confirmados_atual(tenant_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_historico_tenant ON historico_confirmacoes(tenant_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    console.log('✅ Índices criados');
    
    await client.query('COMMIT');
    console.log('🎉 Migração concluída com sucesso!');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
