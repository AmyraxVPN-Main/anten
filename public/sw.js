/* language: JavaScript | file: public/sw.js | PWA shell cache
   shell (html/css/js) is network-first so a deploy lands on the next load;
   images and fonts are cache-first. bump VERSION when the shell contract changes. */

const VERSION = 'ir-v11';
const BASE = new URL('./', self.location.href);
const CACHE_PREFIX = `ir:${BASE.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const cached = (request, options) => caches.open(CACHE_NAME).then((cache) => cache.match(request, options));
const SHELL = [
  './', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-512.png',
  'fonts/Vazirmatn.woff2', 'shared/profile.js', 'shared/catalog.js', 'shared/apn-sources.js'
].map((file) => new URL(file, BASE).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isShell = (url) =>
  url.pathname === BASE.pathname ||
  /\.(css|js|webmanifest)$/.test(url.pathname) ||
  url.pathname === new URL('index.html', BASE).pathname;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // profile downloads and profile API must always hit the network
  if (url.pathname.startsWith('/p/') || url.pathname.startsWith('/api/profile') || url.pathname.startsWith('/mdm/')) return;

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/api/catalog') return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached(request))
    );
    return;
  }

  if (isShell(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached(request, { ignoreSearch: true }).then((hit) => hit || (request.mode === 'navigate' ? cached(BASE.href) : Response.error())))
    );
    return;
  }

  event.respondWith(
    cached(request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          const copy = response.clone();
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
    )
  );
});
