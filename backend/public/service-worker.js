const CACHE_NAME = 'volei-v2';
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/registro.html'
];

// Instalar
self.addEventListener('install', event => {
  console.log('🔧 SW: Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => console.log('✅ Cache criado'))
      .catch(err => console.error('❌ Erro cache:', err))
  );
  self.skipWaiting();
});

// Ativar
self.addEventListener('activate', event => {
  console.log('🔧 SW: Ativando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch
self.addEventListener('fetch', event => {
  const url = event.request.url;
  
  // ⚠️ IMPORTANTE: Validar ANTES de chamar respondWith
  const isHttp = url.startsWith('http://') || url.startsWith('https://');
  const isGet = event.request.method === 'GET';
  
  if (!isHttp || !isGet) {
    return; // Deixa o navegador lidar com isso
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) {
          return cached;
        }
        
        return fetch(event.request)
          .then(response => {
            // Não cachear se não for sucesso
            if (!response || response.status !== 200) {
              return response;
            }
            
            // Não cachear APIs
            const urlObj = new URL(event.request.url);
            const isApi = urlObj.pathname.includes('/api/') || 
                         urlObj.pathname.includes('/confirmar') ||
                         urlObj.pathname.includes('/estatistica');
            
            if (!isApi && response.type === 'basic') {
              const responseClone = response.clone();
              caches.open(CACHE_NAME)
                .then(cache => cache.put(event.request, responseClone))
                .catch(err => console.log('Cache put error:', err));
            }
            
            return response;
          })
          .catch(() => caches.match('/index.html'));
      })
  );
});

console.log('✅ SW v2 carregado');
