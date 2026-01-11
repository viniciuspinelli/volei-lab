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

// Configuração do PostgreSQL via variáveis de ambiente (Render exige SSL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DATA_FILE = './confirmados.json';

// Criação/atualização da tabela se não existir (inclui genero)
async function criarTabela() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS confirmados (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        tipo VARCHAR(20) NOT NULL,
        genero VARCHAR(20),
        data TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE confirmados ADD COLUMN IF NOT EXISTS genero VARCHAR(20)");
  } catch (err) {
    console.error('Erro ao criar/atualizar tabela confirmados:', err);
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
  const { nome, tipo, genero } = req.body;
  if (!nome || !tipo || !genero) {
    return res.status(400).json({ erro: 'Nome, tipo e genero são obrigatórios.' });
  }
  try {
    // Verifica duplicidade
    const existe = await pool.query('SELECT 1 FROM confirmados WHERE LOWER(nome) = LOWER($1)', [nome]);
    if (existe.rowCount > 0) {
      return res.status(409).json({ erro: 'Nome já confirmado.' });
    }
    // Insere e retorna timestamp
    const insert = await pool.query('INSERT INTO confirmados (nome, tipo, genero) VALUES ($1, $2, $3) RETURNING data, id', [nome, tipo, genero]);
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
    const result = await pool.query('SELECT nome, tipo, genero, data FROM confirmados ORDER BY data ASC');
    const rows = result.rows;
    const confirmed = rows.slice(0, 24);
    const waitlist = rows.slice(24);
    res.json({ confirmed, waitlist });
  } catch (err) {
    console.error('Erro /confirmados:', err);
    res.status(500).json({ erro: 'Erro ao buscar confirmados.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
