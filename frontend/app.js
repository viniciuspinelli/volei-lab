const API_URL = 'http://localhost:3001';

function atualizarLista() {
  fetch(`${API_URL}/confirmados`)
    .then(res => res.json())
    .then(confirmados => {
      const ul = document.getElementById('listaConfirmados');
      ul.innerHTML = '';
      confirmados.forEach(c => {
        const li = document.createElement('li');
        li.textContent = `${c.nome} (${c.tipo})`;
        ul.appendChild(li);
      });
    });
}

document.getElementById('formConfirma').addEventListener('submit', function(e) {
  e.preventDefault();
  const nome = document.getElementById('nome').value.trim();
  const tipo = document.getElementById('tipo').value;
  const mensagem = document.getElementById('mensagem');
  mensagem.textContent = '';
  if (!nome || !tipo) return;
  fetch(`${API_URL}/confirmar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, tipo })
  })
    .then(res => res.json())
    .then(data => {
      if (data.sucesso) {
        mensagem.textContent = 'Presença confirmada!';
        atualizarLista();
        document.getElementById('formConfirma').reset();
      } else if (data.erro) {
        mensagem.textContent = data.erro;
        mensagem.style.color = '#c0392b';
      }
    });
});

// Inicializa lista ao carregar
atualizarLista();
