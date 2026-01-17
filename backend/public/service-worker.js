const CACHE_NAME = 'volei-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/registro.html',
  '/manifest.json'
];

// Instalar Service Worker
self.addEventListener('install', event => {
  console.log('🔧 Service Worker: Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('✅ Cache aberto');
        return cache.addAll(urlsToCache);
      })
      .catch(err => console.error('❌ Erro ao adicionar ao cache:', err))
  );
  self.skipWaiting();
});

// Ativar Service Worker
self.addEventListener('activate', event => {
  console.log('🔧 Service Worker: Ativando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Removendo cache antigo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceptar requisições (com filtro de schemes válidos)
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // ✅ FILTRAR: Ignorar requisições não HTTP/HTTPS
  if (!request.url.startsWith('http')) {
    return; // Ignora chrome-extension://, devtools://, etc
  }
  
  // ✅ FILTRAR: Ignorar requisições POST/PUT/DELETE (apenas GET)
  if (request.method !== 'GET') {
    return;
  }
  
  event.respondWith(
    caches.match(request)
      .then(response => {
        if (response) {
          return response; // Retorna do cache
        }
        
        // Clone da requisição
        const fetchRequest = request.clone();
        
        return fetch(fetchRequest)
          .then(response => {
            // Verifica se é uma resposta válida
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // Clone da resposta para cachear
            const responseToCache = response.clone();
            
            caches.open(CACHE_NAME)
              .then(cache => {
                // ✅ FILTRAR: Não cachear APIs
                if (!url.pathname.startsWith('/api/') && 
                    !url.pathname.startsWith('/confirmar') &&
                    !url.pathname.startsWith('/confirmados')) {
                  cache.put(request, responseToCache);
                }
              });
            
            return response;
          })
          .catch(error => {
            console.log('📡 Offline - tentando cache:', error);
            return caches.match('/index.html');
          });
      })
  );
});

// Mensagem de status
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('✅ Service Worker carregado!');
