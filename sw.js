// Service Worker za Dinamo Zagreb fan app
// Cilj: keširati "app shell" (index.html sa svim ugrađenim slikama/CSS/JS)
// tako da se aplikacija otvori i radi i bez interneta (ili na sporoj/filtriranoj
// mreži). Firebase podaci (live rezultati, predikcije) i dalje trebaju mrežu za
// osvježavanje, ali sama aplikacija se prikaže odmah iz cache-a.

const CACHE_NAME = 'dinamo-app-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Strategija: "network first, fallback to cache" za index.html (uvijek pokušaj
// dohvatiti najnoviju verziju ako ima interneta; ako nema, posluži zadnju
// spremljenu verziju iz cache-a). Za ostale statične resurse: cache first.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isAppShell = url.origin === self.location.origin;

  if (isAppShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
  }
  // Vanjski resursi (Firebase, Sofascore, html2canvas...) - pusti browseru
  // da ih normalno rukuje (ne keširamo third-party/live podatke).
});
