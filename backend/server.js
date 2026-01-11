// Rota para limpar todos os confirmados
app.delete('/confirmados', async (req, res) => {
  try {
    await pool.query('DELETE FROM confirmados');
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao limpar confirmados.' });
  }
});
const express = require('express');
const fs = require('fs');

const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, 'public')));

// Configuração do PostgreSQL via variáveis de ambiente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

const DATA_FILE = './confirmados.json';


// Criação da tabela se não existir
async function criarTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confirmados (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      data TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}
criarTabela();

// Rota para registrar presença
app.post('/confirmar', async (req, res) => {
  const { nome, tipo } = req.body;
  if (!nome || !tipo) {
    return res.status(400).json({ erro: 'Nome e tipo são obrigatórios.' });
  }
  try {
    // Verifica duplicidade
    const existe = await pool.query('SELECT 1 FROM confirmados WHERE LOWER(nome) = LOWER($1)', [nome]);
    if (existe.rowCount > 0) {
      return res.status(409).json({ erro: 'Nome já confirmado.' });
    }
    await pool.query('INSERT INTO confirmados (nome, tipo) VALUES ($1, $2)', [nome, tipo]);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao registrar presença.' });
  }
});

// Rota para listar confirmados
app.get('/confirmados', async (req, res) => {
  try {
    const result = await pool.query('SELECT nome, tipo, data FROM confirmados ORDER BY data ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar confirmados.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
