const CACHE = 'aussteiger-bandapp-v7-3';
const APP_SHELL = ['./','./index.html','./chords.html','./app.js?v=7.3','./styles.css?v=7.3','./manifest.json?v=7.3','./songs.json','./setlists.json','./assets/images/logo.jpg','./assets/icons/icon.svg','./assets/icons/icon-180.png','./assets/icons/icon-192.png','./assets/icons/icon-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') { event.respondWith(fetch(event.request).then(response => { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); return response; }).catch(async () => (await caches.match(event.request)) || caches.match('./index.html'))); return; }
  event.respondWith(fetch(event.request).then(response => { if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone())); return response; }).catch(() => caches.match(event.request)));
});
