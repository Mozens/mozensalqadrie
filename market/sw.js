// Naikkan versi jika ada perubahan file di web
const CACHE_NAME = 'bich-mart-v2'; 

const ASSETS_TO_CACHE = [
  '/market/mart.html',
  '/market/manifest.json',
  '/market/icon-192.png',
  '/market/icon-512.png'
];

// 1. Install & Simpan Aset Ke Cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // PERBAIKAN: Gunakan ASSETS_TO_CACHE (bukan urlsToCache)
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Bersihkan Cache Versi Lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// 3. Ambil Data Dari Cache Atau Network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});