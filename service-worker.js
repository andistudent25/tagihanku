/* TagihanKu PWA service worker — app shell only; never cache account or payment API responses. */
'use strict';
const CACHE_PREFIX = 'tagihanku-pwa-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-auth-v1`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-auth-v1`;
const APP_SHELL = [
  './', './index.html', './styles.css', './script.js', './backend-config.js', './backend-client.js',
  './manifest.webmanifest', './favicon.svg', './offline.html', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, RUNTIME_CACHE].includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/\/(api|exec|auth)(\/|$)/i.test(url.pathname)) return;

  // Always refresh public endpoint configuration while online, then use the last good copy offline.
  if (url.pathname.endsWith('/backend-config.js')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        return await caches.match(request) || new Response('Konfigurasi akun belum tersedia saat offline.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(request, fresh.clone());
          return fresh;
        }
      } catch (error) { /* fallback below */ }
      return await caches.match(request) || await caches.match('./index.html') || await caches.match('./offline.html');
    })());
    return;
  }

  if (!/\.(?:css|js|svg|png|webmanifest)$/i.test(url.pathname)) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (error) {
      return new Response('Aset tidak tersedia saat offline.', {
        status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
