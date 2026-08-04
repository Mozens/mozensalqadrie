// Ubah v1 menjadi v2 (atau versi berikutnya)
const CACHE_NAME = 'bich-mart-v2'; 

const ASSETS_TO_CACHE = [
  '/market/mart.html',
  '/market/manifest.json',
  '/market/icon-192.png',
  '/market/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', (event) => {
  // Bersihkan cache versi lama supaya user tidak stuck di versi file basi
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});