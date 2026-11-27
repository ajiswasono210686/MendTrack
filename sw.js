const CACHE_NAME = 'mendtrack-shell-v18-saved-meas-picker';
const APP_SHELL = [
  '/admin.html',
  '/index.html',
  '/track.html',
  '/css/tailwind.css',
  '/css/theme.css',
  '/js/theme-toggle.js',
  '/js/sidebar.js',
  '/js/i18n.js',
  '/js/qr-svg.js',
  '/js/config.js',
  '/js/utils.js',
  '/js/store-settings.js',
  '/js/supabase-client.js',
  '/js/storage-draft.js',
  '/js/admin-panel.js',
  '/js/public-tracker.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/rest/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.includes('/functions/') ||
    url.pathname.includes('/storage/')
  ) {
    return;
  }

  // Network-first for HTML/JS/CSS so normal reloads pick up fixes; cache fallback covers offline use.
  const isAppCode = request.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname);
  if (isAppCode) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => {
            if (cached) return cached;
            if (request.mode === 'navigate') {
              if (url.pathname.startsWith('/t/')) return caches.match('/track.html');
              if (url.pathname.startsWith('/admin')) return caches.match('/admin.html');
              return caches.match('/index.html');
            }
            return Response.error();
          })
        )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
