// Service worker untuk PWA Sungai Kayan (Pariwisata & Mobilitas)
// Pola sama seperti market/sw.js - naikkan versi kalau ada perubahan aset.
const CACHE_NAME = 'bich-tourism-v2'; // v2: ikon-192/512 diganti (file lama JPEG salah label PNG)

const ASSETS_TO_CACHE = [
  '/bich/pariwisata.html',
  '/bich/tourism-manifest.json',
  '/bich/tourism-icon-192.png',
  '/bich/tourism-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});