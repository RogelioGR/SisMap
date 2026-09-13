const CACHE_NAME = 'mapa-sismico-v2';
const STATIC_CACHE = 'static-v2';
const TILES_CACHE = 'tiles-v1';
const API_CACHE = 'api-v1';


const PRECACHE_ASSETS = [
  './',
  './index.html',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/config.js',
  './assets/iconoApp.png',
  './assets/manifest.webmanifest',
  './assets/css/leaflet.css',
  './assets/js/leaflet.js'
];

const API_URLS = [
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson'
];

/* =========================================================
   EVENTO: INSTALL
   ========================================================= */
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando y precacheando assets...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        return Promise.all(
          PRECACHE_ASSETS.map(url => 
            cache.add(url).catch(err => {
              console.warn(`[SW] Falló cachear: ${url}`, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* =========================================================
   EVENTO: ACTIVATE
   ========================================================= */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activando y limpiando caches antiguos...');
  const currentCaches = [CACHE_NAME, STATIC_CACHE, TILES_CACHE, API_CACHE];
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter(name => !currentCaches.includes(name))
            .map(name => {
              console.log(`[SW] Eliminando cache antiguo: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

/* =========================================================
   EVENTO: FETCH (CORREGIDO)
   ========================================================= */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  // 1. Ignorar peticiones que no sean GET
  if (request.method !== 'GET') return;
  
  // 2. IGNORAR extensiones de Chrome y protocolos no HTTP/HTTPS
  // Esto soluciona el error "chrome-extension is unsupported"
  if (!request.url.startsWith('http://') && !request.url.startsWith('https://')) {
    return;
  }

  const url = new URL(request.url);
  
  // ESTRATEGIA 1: API de USGS - Network First con fallback a caché
  if (url.hostname === 'earthquake.usgs.gov') {
    event.respondWith(networkFirstWithCache(request, API_CACHE));
    return;
  }
  
  // ESTRATEGIA 2: Tiles del mapa - Cache First con límite
  if (url.hostname.includes('cartocdn.com') || 
      url.hostname.includes('openstreetmap.org') ||
      url.hostname.includes('opentopomap.org')) {
    event.respondWith(cacheFirstWithLimit(request, TILES_CACHE, 500));
    return;
  }
  
  // ESTRATEGIA 3: Assets estáticos (JS, CSS, fuentes, imágenes) - Cache First
  if (url.pathname.match(/\.(js|css|woff2|ttf|png|jpg|svg|webmanifest)$/)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  
  // ESTRATEGIA 4: HTML y otros - Stale While Revalidate
  event.respondWith(staleWhileRevalidate(request));
});

/* =========================================================
   ESTRATEGIAS DE CACHÉ
   ========================================================= */

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn(`[SW] Cache First falló para: ${request.url}`, err);
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirstWithCache(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.log(`[SW] Red no disponible, usando caché para: ${request.url}`);
    const cached = await caches.match(request);
    if (cached) return cached;
    
    return new Response(
      JSON.stringify({ 
        type: 'FeatureCollection', 
        features: [],
        metadata: { title: 'Sin conexión', status: 503 }
      }),
      { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

async function cacheFirstWithLimit(request, cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    
    if (cached) return cached;
    
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      
      const keys = await cache.keys();
      if (keys.length > maxItems) {
        await cache.delete(keys[0]);
      }
    }
    return response;
  } catch (err) {
    return new Response('', { status: 404 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || new Response('Offline', { status: 503 }));
  
  return cached || fetchPromise;
}

/* =========================================================
   MENSAJES DESDE LA APP
   ========================================================= */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(names => {
      names.forEach(name => caches.delete(name));
    });
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});

/* =========================================================
   BACKGROUND SYNC
   ========================================================= */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-earthquakes') {
    console.log('[SW] Sincronización en segundo plano activada');
    event.waitUntil(
      fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson')
        .then(response => {
          if (response.ok) {
            return caches.open(API_CACHE).then(cache => 
              cache.put(
                'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
                response.clone()
              )
            );
          }
        })
    );
  }
});