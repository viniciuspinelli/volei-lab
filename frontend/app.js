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
        confirmed.forEach((c, i) => {
          const li = document.createElement('li');
          li.className = 'd-flex align-items-center justify-content-between';
          if (c.tipo === 'avulso') li.classList.add('tipo-avulso');
          const span = document.createElement('span');
          span.textContent = `${i + 1}. ${c.nome} (${c.tipo})`;
          span.style.color = c.tipo === 'avulso' ? '#ffd54f' : '#eaf6ff';
          const btn = document.createElement('button');
          btn.className = 'remove-btn';
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

  // 4 times de 6
  const times = [[], [], [], []];
  
  // Distribui mulheres primeiro - uma por time (garante que cada time tenha mulher)
  for (let i = 0; i < Math.min(4, mulheres.length); i++) {
    times[i].push(mulheres[i]);
  }
  
  // Distribui mulheres restantes entre os times
  for (let i = 4; i < mulheres.length; i++) {
    const idx = i % 4;
    times[idx].push(mulheres[i]);
  }
  
  // Distribui homens entre os times
  for (let i = 0; i < homens.length; i++) {
    const idx = i % 4;
    times[idx].push(homens[i]);
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
      let list = Array.isArray(confirmados) ? confirmados : (confirmados.confirmed || []);
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
      
      // Botão de compartilhar no WhatsApp
      let shareBtn = document.getElementById('shareWhatsAppBtn');
      if (!shareBtn) {
        shareBtn = document.createElement('button');
        shareBtn.id = 'shareWhatsAppBtn';
        shareBtn.className = 'primary';
        shareBtn.textContent = 'Compartilhar no WhatsApp';
        shareBtn.style.marginTop = '12px';
        shareBtn.addEventListener('click', () => compartilharWhatsApp(times));
        document.getElementById('resultadoSorteio').appendChild(shareBtn);
      }
    });
});

function compartilharWhatsApp(times) {
  let mensagem = '*🏐 SORTEIO DOS TIMES - VÔLEI SEXTA 🏐*%0A%0A';
  for (let i = 0; i < 4; i++) {
    mensagem += `*Time ${i + 1}*%0A`;
    times[i].forEach(p => {
      mensagem += `• ${p.nome}${p.genero ? ' (' + p.genero + ')' : ''}%0A`;
    });
    mensagem += '%0A';
  }
  const numero = '5511986439388';
  const url = `https://wa.me/${numero}?text=${mensagem}`;
  window.open(url, '_blank');
}


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

// Botão para limpar apenas o sorteio
document.addEventListener('DOMContentLoaded', function() {
  let limparSorteioBtn = document.createElement('button');
  limparSorteioBtn.id = 'limparSorteio';
  limparSorteioBtn.className = 'ghost';
  limparSorteioBtn.textContent = 'Limpar Sorteio';
  limparSorteioBtn.style.marginTop = '12px';
  limparSorteioBtn.addEventListener('click', function() {
    document.getElementById('resultadoSorteio').innerHTML = '';
    document.getElementById('mensagem').textContent = 'Sorteio limpo!';
    document.getElementById('mensagem').style.color = '#27ae60';
  });
  
  // Adiciona o botão logo após o elemento resultadoSorteio (após o sorteio ser realizado)
  const observer = new MutationObserver(() => {
    if (document.getElementById('resultadoSorteio').innerHTML && !document.getElementById('limparSorteio')) {
      document.getElementById('resultadoSorteio').parentNode.insertBefore(limparSorteioBtn, document.getElementById('resultadoSorteio').nextSibling);
    }
  });
  observer.observe(document.getElementById('resultadoSorteio'), { childList: true });
});

// Inicializa lista ao carregar
atualizarLista();
