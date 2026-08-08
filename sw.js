const CACHE_NAME = 'nexus-cache-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './carmeow.html',
    './ai.html',
    './chat.html',
    './media.html',
    './settings.html',
    './gust.html',
    './style.css',
    './app.js',
    './cookie-engine.js',
    './cookie-core.js',
    './bgm-manager.js',
    './game-title-utils.js',
    './tutorial-engine.js',
    './games.json',
    // Assets SVGs
    './Assets/AI.svg',
    './Assets/Active%20Timer.svg',
    './Assets/Backup.svg',
    './Assets/Bolt.svg',
    './Assets/Chart.svg',
    './Assets/Chat.svg',
    './Assets/Cookie.svg',
    './Assets/Cooldown.svg',
    './Assets/Custom.svg',
    './Assets/Delete.svg',
    './Assets/Drag.svg',
    './Assets/Fire.svg',
    './Assets/Fullscreen.svg',
    './Assets/Game.svg',
    './Assets/New%20Chat.svg',
    './Assets/Proxy.svg',
    './Assets/Rename.svg',
    './Assets/Restore.svg',
    './Assets/Robot.svg',
    './Assets/Settings.svg',
    './Assets/media-back-arrow.svg',
    './Assets/nexus-ai.svg',
    './Assets/nexus-chat.svg',
    './Assets/nexus-drag.svg',
    './Assets/nexus-game.svg',
    './Assets/nexus-media.svg',
    './Assets/nexus-proxy.svg',
    './Assets/nexus-settings.svg',
    // Assets PNGs/GIFs
    './Assets/bookmark.png',
    './Assets/canvas_cloak.png',
    './Assets/cursor.png',
    './Assets/drive_cloak.png',
    './Assets/loadingRoll.gif',
    './Assets/magnet.png',
    './Assets/mediaP.png',
    './Assets/nexusLogo.png',
    './Assets/photoIcon.png',
    './Assets/pop.gif',
    './Assets/tutorial.pdf',
    // Assets Videos
    './Assets/loopBG.mp4',
    './Assets/purpleBG2.mp4'
];

// Install Event - Pre-cache Core Assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Caching initial assets...');
                // Promise.allSettled avoids a single request fail block-breaking the entire SW load
                return Promise.allSettled(
                    ASSETS_TO_CACHE.map(url => {
                        return cache.add(url).catch(err => {
                            console.error(`Failed to cache asset: ${url}`, err);
                        });
                    })
                );
            })
            .then(() => self.skipWaiting())
    );
});

// Activate Event - Clean Up Old Caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('Clearing old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Helper for HTTP Range Requests (needed for mp3/mp4 playback offline)
function returnRangeResponse(request, cachedResponse) {
    return cachedResponse.arrayBuffer().then(arrayBuffer => {
        const rangeHeader = request.headers.get('range');
        if (!rangeHeader) {
            return new Response(arrayBuffer, {
                status: 200,
                headers: cachedResponse.headers
            });
        }

        const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
        if (!match) {
            return new Response(arrayBuffer, {
                status: 200,
                headers: cachedResponse.headers
            });
        }

        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : arrayBuffer.byteLength - 1;
        const chunk = arrayBuffer.slice(start, end + 1);

        const headers = new Headers(cachedResponse.headers);
        headers.set('Content-Range', `bytes ${start}-${end}/${arrayBuffer.byteLength}`);
        headers.set('Content-Length', chunk.byteLength);

        return new Response(chunk, {
            status: 206,
            statusText: 'Partial Content',
            headers: headers
        });
    });
}

// Fetch Event - Network First, fallback to Cache
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (!url.protocol.startsWith('http')) return;

    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // Cache a copy of the response if valid and not a range request
                if (networkResponse && networkResponse.status === 200 && !event.request.headers.has('range')) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Offline fallback - retrieve from cache
                return caches.match(event.request).then(cachedResponse => {
                    if (cachedResponse) {
                        if (event.request.headers.has('range')) {
                            return returnRangeResponse(event.request, cachedResponse);
                        }
                        return cachedResponse;
                    }
                    return new Response('Offline content not available', {
                        status: 503,
                        statusText: 'Service Unavailable'
                    });
                });
            })
    );
});
