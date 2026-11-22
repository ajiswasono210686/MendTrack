const CACHE_NAME = 'mendtrack-shell-v7-pastel-sidebar';
const APP_SHELL = [
  '/admin.html', '/index.html', '/css/custom.css', '/css/premium-theme.css', '/css/modern-theme.css', '/js/theme-toggle.js', '/js/sidebar.js',
  '/js/config.js', '/js/utils.js', '/js/store-settings.js',
  '/js/supabase-client.js', '/js/storage-draft.js',
  '/js/admin-panel.js', '/js/public-tracker.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/') || url.pathname.includes('/functions/')) return;

  // Always try the network first for app code and HTML so normal reloads receive fixes.
  // Fall back to the cached copy only when offline.
  const isAppCode = request.mode === 'navigate' || /\.(?:html|js|css|webmanifest)$/.test(url.pathname);
  if (isAppCode) {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => {
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/admin.html');
        return Response.error();
      }))
    );
    return;
  }

  // Images and other static assets remain cache-first for quick repeat loads.
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});
