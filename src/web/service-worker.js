const MUSIC_COVER_CACHE_NAME = 'yaya-music-covers-v1';
const MUSIC_COVER_CACHE_PREFIX = 'yaya-music-covers-';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter((name) => name.startsWith(MUSIC_COVER_CACHE_PREFIX) && name !== MUSIC_COVER_CACHE_NAME)
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || request.destination !== 'image') return;

    event.respondWith((async () => {
        const cache = await caches.open(MUSIC_COVER_CACHE_NAME);
        const cachedResponse = await cache.match(request, { ignoreVary: true });
        return cachedResponse || fetch(request);
    })());
});
