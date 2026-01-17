const CACHE_NAME = 'volei-v3';
const urlsToCache = [
  '/login.html',
  '/registro.html'
];

// Instalar
self.addEventListener('install', event => {
  console.log('🔧 SW v3: Instalando...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => console.log('✅ Cache criado'))
  );
  self.skipWaiting();
});

// Ativar e limpar caches antigos
self.addEventListener('activate', event => {
  console.log('🔧 SW v3: Ativando...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('🗑️ Removendo cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// Fetch - SEM CACHE para APIs
self.addEventListener('fetch', event => {
  const url = event.request.url;
  
  // Validar se é HTTP/HTTPS
  const isHttp = url.startsWith('http://') || url.startsWith('https://');
  if (!isHttp) return;
  
  // Validar se é GET
  const isGet = event.request.method === 'GET';
  if (!isGet) return;
  
  // ⚠️ NÃO CACHEAR: index.html, APIs, dados dinâmicos
  const urlObj = new URL(url);
  const noCachePaths = [
    '/index.html',
    '/confirmar',
    '/confirmados',
    '/estatisticas',
    '/verificar-token',
    '/api/',
    '/logout'
  ];
  
  const shouldNotCache = noCachePaths.some(path => urlObj.pathname.includes(path));
  
  if (shouldNotCache) {
    // Buscar direto da rede, sem cache
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Para outros arquivos (login, registro), usar cache
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
  );
});

console.log('✅ SW v3 carregado - SEM cache de APIs');
