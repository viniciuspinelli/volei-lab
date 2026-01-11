const express = require('express');
const fs = require('fs');
const cors = require('cors');
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const DATA_FILE = './confirmados.json';

// Função para ler os confirmados
function lerConfirmados() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const data = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(data);
}

// Função para salvar os confirmados
function salvarConfirmados(confirmados) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(confirmados, null, 2));
}

// Rota para registrar presença
app.post('/confirmar', (req, res) => {
  const { nome, tipo } = req.body;
  if (!nome || !tipo) {
    return res.status(400).json({ erro: 'Nome e tipo são obrigatórios.' });
  }
  const confirmados = lerConfirmados();
  // Evita duplicidade
  if (confirmados.some(c => c.nome.toLowerCase() === nome.toLowerCase())) {
    return res.status(409).json({ erro: 'Nome já confirmado.' });
  }
  confirmados.push({ nome, tipo, data: new Date().toISOString() });
  salvarConfirmados(confirmados);
  res.json({ sucesso: true });
});

// Rota para listar confirmados
app.get('/confirmados', (req, res) => {
  const confirmados = lerConfirmados();
  res.json(confirmados);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
