const CACHE_NAME = 'bich-mart-v2';
const urlsToCache = [
  '/market/mart.html',
  '/market/seller.html',
  '/market/checkout.html',
  '/market/manifest.json',
  '/market/supabase.js',
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