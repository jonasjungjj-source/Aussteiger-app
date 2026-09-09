const CACHE = 'aussteiger-bandapp-v9-7-0-back-nav-pdf-canvas';
const APP_SHELL = [
  './', './index.html', './chords.html',
  './app.js?v=9.7.0', './styles.css?v=9.7.0', './manifest.json?v=9.7.0',
  './songs.json', './setlists.json',
  './assets/images/logo.jpg', './assets/icons/icon.svg',
  './assets/icons/icon-180.png', './assets/icons/icon-192.png', './assets/icons/icon-512.png'
];

// PDF-Anzeige: wird zusätzlich vorgeladen, blockiert die Installation aber nicht.
const PDF_ENGINE = [
  './assets/vendor/pdfjs/pdf.min.mjs',
  './assets/vendor/pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE)
    .then(cache => cache.addAll(APP_SHELL).then(() => cache.addAll(PDF_ENGINE).catch(error => console.warn('PDF-Anzeige nicht vorgeladen', error))))
    .then(() => self.skipWaiting())
));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
