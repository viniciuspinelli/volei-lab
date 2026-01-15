const express = require('express');
const fs = require('fs');
const crypto = require('crypto');

const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, 'public')));

// Configuração do PostgreSQL via variáveis de ambiente (Render exige SSL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DATA_FILE = './confirmados.json';

// Função para gerar hash de senha
function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha).digest('hex');
}

// Função para gerar token de sessão
function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Armazena tokens de sessão válidos (em memória - resetados quando servidor reinicia)
const sessoes = new Map();

// Criação/atualização da tabela se não existir (inclui genero e teste)
async function criarTabela() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS confirmados (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        tipo VARCHAR(20) NOT NULL,
        genero VARCHAR(20),
        teste BOOLEAN DEFAULT false,
        data TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE confirmados ADD COLUMN IF NOT EXISTS genero VARCHAR(20)");
    await pool.query("ALTER TABLE confirmados ADD COLUMN IF NOT EXISTS teste BOOLEAN DEFAULT false");
    
    // Criar tabela de admin
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        senha_hash VARCHAR(64) NOT NULL,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
  } catch (err) {
    console.error('Erro ao criar/atualizar tabelas:', err);
  }
}
criarTabela();
// Rota para limpar todos os confirmados
app.delete('/confirmados', async (req, res) => {
  try {
    await pool.query('DELETE FROM confirmados');
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao limpar confirmados.' });
  }
});

// Rota para registrar presença
app.post('/confirmar', async (req, res) => {
  const { nome, tipo, genero, teste = false } = req.body;
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e genero são obrigatórios.' });
  }
  try {
    // Verifica duplicidade
    const existe = await pool.query('SELECT 1 FROM confirmados WHERE LOWER(nome) = LOWER($1)', [nome]);
    if (existe.rowCount > 0) {
      return res.status(409).json({ erro: 'Nome já confirmado.' });
    }
    // Verifica se já atingiu o limite de 24 confirmados (não conta testes)
    const cnt = await pool.query('SELECT COUNT(*) FROM confirmados WHERE teste = false');
    const confirmedCount = parseInt(cnt.rows[0].count, 10);
    if (confirmedCount >= 24 && !teste) {
      return res.status(403).json({ erro: 'Limite de 24 confirmados atingido.' });
    }
    // Insere e retorna timestamp
    const insert = await pool.query('INSERT INTO confirmados (nome, tipo, genero, teste) VALUES ($1, $2, $3, $4) RETURNING data, id', [nome, tipo, genero, teste]);
    const insertedAt = insert.rows[0].data;
    // Calcula posição na lista (ordem por data asc)
    const posRes = await pool.query('SELECT COUNT(*) FROM confirmados WHERE data <= $1', [insertedAt]);
    const position = parseInt(posRes.rows[0].count, 10);
    const isWaitlist = position > 24;
    res.json({ sucesso: true, position, waitlist: isWaitlist });
  } catch (err) {
    console.error('Erro /confirmar:', err);
    res.status(500).json({ erro: 'Erro ao registrar presença.' });
  }
});

// Rota para listar confirmados
app.get('/confirmados', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nome, tipo, genero, teste, data FROM confirmados WHERE teste = false ORDER BY data ASC');
    const rows = result.rows;
    const confirmed = rows.slice(0, 24);
    const waitlist = rows.slice(24);
    res.json({ confirmed, waitlist });
  } catch (err) {
    console.error('Erro /confirmados:', err);
    res.status(500).json({ erro: 'Erro ao buscar confirmados.' });
  }
});

// Rota para remover um confirmado por id
app.delete('/confirmados/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const del = await pool.query('DELETE FROM confirmados WHERE id = $1', [id]);
    if (del.rowCount === 0) {
      return res.status(404).json({ erro: 'Confirmado não encontrado.' });
    }
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro DELETE /confirmados/:id', err);
    res.status(500).json({ erro: 'Erro ao remover confirmado.' });
  }
});

// Middleware para verificar autenticação admin
function verificarAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !sessoes.has(token)) {
    return res.status(401).json({ erro: 'Acesso negado. Faça login como admin.' });
  }
  next();
}

// Rota para setup inicial do admin (só funciona se não existir admin)
app.post('/setup-admin', async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Usuário e senha são obrigatórios.' });
  }
  try {
    // Verifica se já existe um admin
    const existe = await pool.query('SELECT COUNT(*) FROM admin');
    if (parseInt(existe.rows[0].count) > 0) {
      return res.status(403).json({ erro: 'Admin já configurado. Use login.' });
    }
    // Cria o admin
    const senhaHash = hashSenha(senha);
    await pool.query('INSERT INTO admin (usuario, senha_hash) VALUES ($1, $2)', [usuario, senhaHash]);
    res.json({ sucesso: true, mensagem: 'Admin criado com sucesso!' });
  } catch (err) {
    console.error('Erro setup-admin:', err);
    res.status(500).json({ erro: 'Erro ao criar admin.' });
  }
});

// Rota para verificar se admin existe
app.get('/admin-existe', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM admin');
    res.json({ existe: parseInt(result.rows[0].count) > 0 });
  } catch (err) {
    res.json({ existe: false });
  }
});

// Rota para login admin
app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Usuário e senha são obrigatórios.' });
  }
  try {
    const senhaHash = hashSenha(senha);
    const result = await pool.query('SELECT * FROM admin WHERE usuario = $1 AND senha_hash = $2', [usuario, senhaHash]);
    if (result.rowCount === 0) {
      return res.status(401).json({ erro: 'Usuário ou senha inválidos.' });
    }
    const token = gerarToken();
    sessoes.set(token, { usuario, loginEm: Date.now() });
    // Limpa tokens antigos (mais de 24h)
    for (const [t, data] of sessoes) {
      if (Date.now() - data.loginEm > 24 * 60 * 60 * 1000) sessoes.delete(t);
    }
    res.json({ sucesso: true, token });
  } catch (err) {
    console.error('Erro login:', err);
    res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

// Rota para logout
app.post('/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) sessoes.delete(token);
  res.json({ sucesso: true });
});

// Rota para verificar se token é válido
app.get('/verificar-token', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token && sessoes.has(token)) {
    res.json({ valido: true, usuario: sessoes.get(token).usuario });
  } else {
    res.json({ valido: false });
  }
});

// Rota para remover todas as confirmações de um usuário por nome (PROTEGIDA)
app.delete('/estatisticas/:nome', verificarAdmin, async (req, res) => {
  const nome = decodeURIComponent(req.params.nome);
  try {
    const del = await pool.query('DELETE FROM confirmados WHERE LOWER(nome) = LOWER($1)', [nome]);
    if (del.rowCount === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }
    res.json({ sucesso: true, removidos: del.rowCount });
  } catch (err) {
    console.error('Erro DELETE /estatisticas/:nome', err);
    res.status(500).json({ erro: 'Erro ao remover usuário das estatísticas.' });
  }
});

// Rota para retornar estatísticas de frequência
app.get('/estatisticas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        nome, 
        genero, 
        tipo,
        COUNT(*) as total_confirmacoes,
        MAX(data) as ultima_confirmacao
      FROM confirmados
      WHERE teste = false
      GROUP BY nome, genero, tipo
      ORDER BY total_confirmacoes DESC
    `);
    const stats = result.rows;
    
    // Calcula estatísticas gerais
    const totalConfirmacoes = stats.reduce((sum, s) => sum + parseInt(s.total_confirmacoes, 10), 0);
    const pessoasUnicas = stats.length;
    const mediaConfirmacoes = pessoasUnicas > 0 ? (totalConfirmacoes / pessoasUnicas).toFixed(2) : 0;
    
    // Estatísticas por gênero
    const porGenero = {};
    stats.forEach(s => {
      if (!porGenero[s.genero]) porGenero[s.genero] = { total: 0, pessoas: 0 };
      porGenero[s.genero].total += parseInt(s.total_confirmacoes, 10);
      porGenero[s.genero].pessoas += 1;
    });
    
    res.json({ 
      ranking: stats,
      resumo: { totalConfirmacoes, pessoasUnicas, mediaConfirmacoes },
      porGenero 
    });
  } catch (err) {
    console.error('Erro /estatisticas:', err);
    res.status(500).json({ erro: 'Erro ao buscar estatísticas.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
