const STATIC_CACHE = 'yidimension-static-v1';
const RUNTIME_CACHE = 'yidimension-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll([
      './',
      './index.html',
      './yidimension-sdk.js',
      './assets/games.json'
    ]);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => ![STATIC_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k)));
  })());
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isLikelyMedia = /\.(mp4|webm|m3u8|ts)(\?|$)/i.test(url.pathname);
  const isAppAsset = /\/assets\//.test(url.pathname) || /\/index\.html$/.test(url.pathname) || /\/yidimension-sdk\.js$/.test(url.pathname);

  if (isLikelyMedia || isAppAsset) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((resp) => {
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(() => null);

  if (cached) {
    eventWait(networkPromise);
    return cached;
  }

  const networkResp = await networkPromise;
  if (networkResp) return networkResp;

  return new Response('offline', { status: 503, statusText: 'offline' });
}

function eventWait(promise) {
  try { self.registration && promise && promise.catch(() => {}); } catch {}
}
