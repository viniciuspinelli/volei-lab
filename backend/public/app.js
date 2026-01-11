const API_URL = '';

function atualizarLista() {
  fetch(`/confirmados`)
    .then(res => res.json())
    .then(data => {
      // data may be { confirmed, waitlist } or an array (legacy)
      let confirmed = [];
      let waitlist = [];
      if (Array.isArray(data)) {
        confirmed = data.slice(0, 24);
        waitlist = data.slice(24);
      } else {
        confirmed = data.confirmed || [];
        waitlist = data.waitlist || [];
      }

      const ul = document.getElementById('listaConfirmados');
      ul.innerHTML = '';
      confirmed.forEach(c => {
        const li = document.createElement('li');
        li.className = 'd-flex align-items-center justify-content-between';
        const span = document.createElement('span');
        span.textContent = `${c.nome} (${c.tipo})`;
        span.style.color = '#ffffff';
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-light ms-2';
        btn.textContent = 'Remover';
        btn.addEventListener('click', () => removerConfirmado(c.id));
        li.appendChild(span);
        li.appendChild(btn);
        ul.appendChild(li);
      });

      const waitEl = document.getElementById('resultadoSorteio');
      // use resultadoSorteio area for waitlist display when not showing teams
      let waitHtml = '';
      if (waitlist.length > 0) {
        waitHtml += '<div class="mt-3"><strong>Lista de Espera</strong><ol class="ms-3 mt-2" style="color:#fff">';
        waitlist.forEach(w => { waitHtml += `<li>${w.nome} (${w.tipo})</li>` });
        waitHtml += '</ol></div>';
      }
      waitEl.innerHTML = waitHtml;
    });
}

function removerConfirmado(id) {
  if (!confirm('Remover esta pessoa da lista?')) return;
  fetch(`/confirmados/${id}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.sucesso) {
        document.getElementById('mensagem').textContent = 'Confirmado removido.';
        document.getElementById('mensagem').style.color = '#27ae60';
        atualizarLista();
      } else if (data.erro) {
        document.getElementById('mensagem').textContent = data.erro;
        document.getElementById('mensagem').style.color = '#c0392b';
      }
    })
    .catch(() => {
      document.getElementById('mensagem').textContent = 'Erro ao remover.';
      document.getElementById('mensagem').style.color = '#c0392b';
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
  // Limita a 24 confirmados (4 times de 6)
  confirmados = (confirmados || []).slice(0, 24);
  confirmados.forEach(c => { if (!c.genero) c.genero = 'masculino'; });
  const homens = confirmados.filter(c => c.genero === 'masculino').slice();
  const mulheres = confirmados.filter(c => c.genero === 'feminino').slice();
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  shuffle(homens);
  shuffle(mulheres);

  // Intercala gêneros tentando equilibrar; quando um gênero acabar, o outro completa
  const combined = [];
  while (homens.length || mulheres.length) {
    if (homens.length >= mulheres.length) {
      if (homens.length) combined.push(homens.pop());
      if (mulheres.length) combined.push(mulheres.pop());
    } else {
      if (mulheres.length) combined.push(mulheres.pop());
      if (homens.length) combined.push(homens.pop());
    }
  }

  const times = [[], [], [], []];
  for (let i = 0; i < combined.length; i++) {
    times[i % 4].push(combined[i]);
  }

  // Preenche vagas livres até 6 por time
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
      const list = Array.isArray(confirmados) ? confirmados : (confirmados.confirmed || []);
      const times = sortearTimes(list);
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
