const API_URL = '';

function atualizarLista() {
  fetch(`/confirmados`)
    .then(res => res.json())
    .then(confirmados => {
      const container = document.getElementById('listaConfirmados');
      container.innerHTML = '';
      if (confirmados.length === 0) {
        container.innerHTML = '<div class="text-muted">Nenhuma confirmação ainda.</div>';
        return;
      }
      confirmados.forEach(c => {
        const item = document.createElement('div');
        item.className = 'list-group-item d-flex justify-content-between align-items-start';
        const generoIcon = c.genero === 'feminino' ? '<i class="bi bi-gender-female text-danger me-1"></i>' : '<i class="bi bi-gender-male text-primary me-1"></i>';
        item.innerHTML = `<div class="d-flex align-items-center"><i class="bi bi-person-fill me-2"></i><div><strong>${c.nome}</strong><div class="small text-muted">${c.tipo} ${c.genero ? '• ' + generoIcon + ' ' + c.genero : ''}</div></div></div>`;
        container.appendChild(item);
      });
    });
}

document.getElementById('formConfirma').addEventListener('submit', function(e) {
  e.preventDefault();
  const nome = document.getElementById('nome').value.trim();
  const tipo = document.getElementById('tipo').value;
  const genero = document.getElementById('genero').value;
  const mensagem = document.getElementById('mensagem');
  mensagem.textContent = '';
  mensagem.style.color = '#27ae60';
  if (!nome || !tipo || !genero) return;
  fetch(`/confirmar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, tipo, genero })
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
// Função para sortear times equilibrando homens e mulheres
function sortearTimes(confirmados) {
  // Adiciona campo genero default masculino se não existir (retrocompatibilidade)
  confirmados.forEach(c => { if (!c.genero) c.genero = 'masculino'; });
  const homens = confirmados.filter(c => c.genero === 'masculino');
  const mulheres = confirmados.filter(c => c.genero === 'feminino');
  // Embaralha arrays
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  shuffle(homens);
  shuffle(mulheres);
  // 4 times de 6
  const times = [[], [], [], []];
  // Distribui mulheres
  for (let i = 0; i < 4 * 3; i++) {
    const idx = i % 4;
    if (mulheres.length > 0) times[idx].push(mulheres.pop());
  }
  // Distribui homens
  for (let i = 0; i < 4 * 3; i++) {
    const idx = i % 4;
    if (homens.length > 0) times[idx].push(homens.pop());
  }
  // Preenche vagas livres
  for (let i = 0; i < 4; i++) {
    while (times[i].length < 6) {
      times[i].push({ nome: 'Vaga Livre', genero: '', tipo: '' });
    }
  }
  return times;
}

// Botão de sorteio
document.getElementById('sortearTimes').addEventListener('click', function(e) {
  e.preventDefault();
  fetch(`/confirmados`)
    .then(res => res.json())
    .then(confirmados => {
      const times = sortearTimes(confirmados);
      let html = '';
      for (let i = 0; i < 4; i++) {
        html += `<b>Time ${i + 1}</b><ul>`;
        times[i].forEach(p => {
          html += `<li>${p.nome}${p.genero ? ' (' + p.genero + ')' : ''}</li>`;
        });
        html += '</ul>';
      }
      document.getElementById('resultadoSorteio').innerHTML = html;
    });
});


// Botão para limpar confirmados
document.getElementById('limparConfirmados').addEventListener('click', function(e) {
  e.preventDefault();
  if (confirm('Tem certeza que deseja limpar todos os confirmados?')) {
    fetch('/confirmados', { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if (data.sucesso) {
          document.getElementById('mensagem').textContent = 'Lista limpa!';
          document.getElementById('mensagem').style.color = '#27ae60';
          atualizarLista();
        } else {
          document.getElementById('mensagem').textContent = 'Erro ao limpar lista.';
          document.getElementById('mensagem').style.color = '#c0392b';
        }
      });
  }
});

// Inicializa lista ao carregar
atualizarLista();
