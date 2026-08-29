const MUSIC_COVER_CACHE_NAME = 'yaya-music-covers-v4';
const MUSIC_COVER_CACHE_PREFIX = 'yaya-music-covers-';
let shouldReloadOpenClients = false;

self.addEventListener('install', (event) => {
    shouldReloadOpenClients = Boolean(self.registration.active);
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter((name) => name.startsWith(MUSIC_COVER_CACHE_PREFIX) && name !== MUSIC_COVER_CACHE_NAME)
            .map((name) => caches.delete(name)));
        await self.clients.claim();
        if (shouldReloadOpenClients) {
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            await Promise.all(clients.map((client) => client.navigate(client.url)));
        }
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || request.destination !== 'image') return;

    const requestUrl = new URL(request.url);
    const isSameOriginImage = requestUrl.origin === self.location.origin;
    const isMusicCoverImage = requestUrl.origin === 'https://music.gnz.hk';
    if (!isSameOriginImage && !isMusicCoverImage) return;

    const loadResponse = (async () => {
        const cache = await caches.open(MUSIC_COVER_CACHE_NAME);
        const cachedResponse = await cache.match(request, { ignoreVary: true });
        if (cachedResponse) {
            return { response: cachedResponse, cacheResponse: null };
        }

        const response = await fetch(request);
        return {
            response,
            cacheResponse: response && (response.ok || response.type === 'opaque')
                ? response.clone()
                : null
        };
    })();

    event.respondWith(loadResponse.then(({ response }) => response));
    event.waitUntil(loadResponse.then(async ({ cacheResponse }) => {
        if (!cacheResponse) return;
        const cache = await caches.open(MUSIC_COVER_CACHE_NAME);
        await cache.put(request, cacheResponse);
    }).catch(() => {}));
});
