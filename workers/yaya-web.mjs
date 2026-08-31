import { hasPocketChannel, invokePocketChannel } from '../src/common/pocket-runtime.mjs';
import errorUtils from '../src/common/error-utils.js';

const { getErrorMessage, reportIgnoredError } = errorUtils;

const DEFAULT_API_BACKEND = 'https://api.gnz.hk';
const DESKTOP_DOWNLOAD_FILE = 'yaya_msg-v2.11-win.zip';
const R2_MUSIC_LIST_CACHE_TTL_SECONDS = 6 * 60 * 60;
const R2_MUSIC_LIST_CACHE_TTL_MS = R2_MUSIC_LIST_CACHE_TTL_SECONDS * 1000;
const R2_MUSIC_ALBUM_METADATA_KEY = '_metadata/r2-music-albums.json';
const R2_MUSIC_TRACK_METADATA_KEY = '_metadata/r2-music-tracks.json';
const R2_MUSIC_PUBLIC_ORIGIN = 'https://music.gnz.hk';
const POCKET_PROXY_RETRY_DELAYS_MS = [350, 900];
const INVOICE_BACKEND_TIMEOUT_MS = 20 * 1000;

let r2MusicListCache = null;

const R2_MUSIC_TITLE_OVERRIDES = new Map([
    ['SNH48/魔女的诗篇/Tinkle Tinkle.mp3', 'Twinkle Twinkle'],
    ['SNH48/化作北极星/化作北极星.flac', '化作樱花树 (万万没想到特别版)'],
    ['TPE48/24／7 Shining/24／7 Shining.flac', '24/7 Shining']
]);
const R2_MUSIC_ALBUM_OVERRIDES = new Map([
    ['TPE48/24／7 Shining', '24/7 Shining'],
    ['TPE48/RESET／UNIT DAISY', 'RESET錄音室錄音選輯']
]);

function logWorkerEvent(level, event, details = {}) {
    const entry = {
        level,
        event,
        ...details
    };
    const logger = level === 'error'
        ? console.error
        : level === 'warn'
            ? console.warn
            : console.log;
    logger(entry);
}

function createProxyDeviceId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID().toUpperCase();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `WEB-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const invoiceChannels = new Set([
    'fetch-invoice-tips',
    'fetch-invoice-config',
    'fetch-invoice-order-list',
    'apply-electronic-invoice'
]);
const invoiceLoadChannels = new Set([
    'fetch-invoice-tips',
    'fetch-invoice-config',
    'fetch-invoice-order-list'
]);

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.hostname.toLowerCase() === 'music.gnz.hk' && url.pathname === '/') {
            const musicPageUrl = new URL('https://gnz.hk/music');
            musicPageUrl.search = url.search;
            return Response.redirect(musicPageUrl.toString(), 302);
        }

        if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
            url.pathname = url.pathname.replace(/\/+$/, '');
            return Response.redirect(url.toString(), 301);
        }

        if (url.pathname === '/api/r2-music') {
            return handleR2MusicListRequest(request, env, ctx);
        }

        if (url.pathname === '/r2-music' || url.pathname.startsWith('/r2-music/')) {
            return handleR2MusicObjectRequest(request, env, url);
        }

        if (url.pathname === '/api/ipc') {
            const apiBackend = getApiBackend(env);
            if (apiBackend && await shouldProxyIpcToBackend(request)) {
                return proxyIpcRequest(request, env, apiBackend);
            }
            return handleIpc(request, env);
        }

        const apiBackend = getApiBackend(env);
        if (apiBackend && isPocketBackendApiPath(url.pathname)) {
            return proxyApiRequest(request, apiBackend);
        }

        if (apiBackend && url.pathname.startsWith('/api/')) {
            return proxyApiRequest(request, apiBackend);
        }

        if (url.pathname === '/web-media-proxy') {
            return handleMediaProxy(request);
        }

        if (url.pathname === '/report' || url.pathname.startsWith('/report/')) {
            return handleReportRequest(request, env, url);
        }

        if (url.pathname === '/downloads' || url.pathname.startsWith('/downloads/')) {
            return handleDownloadRequest(request, env, url);
        }

        if (url.pathname === '/api/health') {
            return json({ success: true, runtime: 'cloudflare-workers' });
        }

        if (url.pathname === '/api/pocket') {
            return handlePocketProxy(request);
        }

        if (url.pathname === '/api/text-proxy') {
            return handleTextProxy(request);
        }

        return withWebRuntimeHeaders(await fetchWebAsset(request, env, url), url);
    }
};

async function fetchWebAsset(request, env, url) {
    const nestedAssetResponse = await fetchNestedRouteAsset(request, env, url);
    if (nestedAssetResponse) return nestedAssetResponse;

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    const path = url.pathname || '/';
    const looksLikeFile = /\/[^/]+\.[^/]+$/.test(path);
    if (looksLikeFile) return assetResponse;

    return fetchIndexAsset(request, env);
}

async function handleReportRequest(request, env, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return textResponse('Method Not Allowed', 405);
    }
    if (!env.YAYA_DOWNLOADS) {
        return textResponse('Report storage is not configured', 500);
    }

    const requestedName = decodeURIComponent(url.pathname.replace(/^\/report\/?/, '') || '')
        .replace(/^\/+/, '');
    if (!requestedName) {
        return textResponse('Report not found', 404);
    }
    if (requestedName.includes('..') || requestedName.includes('\\')) {
        return textResponse('Invalid report path', 400);
    }

    const fileName = requestedName.endsWith('.html') ? requestedName : `${requestedName}.html`;
    const object = await env.YAYA_DOWNLOADS.get(`reports/${fileName}`);
    if (!object) {
        return textResponse('Report not found', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Content-Type', 'text/html;charset=utf-8');
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName.split('/').pop() || 'report.html')}"`);
    headers.set('Cache-Control', 'no-cache');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

function fetchIndexAsset(request, env) {
    const indexUrl = new URL(request.url);
    indexUrl.pathname = '/';
    indexUrl.search = '';
    return env.ASSETS.fetch(new Request(indexUrl, request));
}

const WEB_APP_ROUTE_SLUGS = new Set([
        'home',
        'messages',
        'fetch',
        'live',
        'vod',
        'meet48-live',
        'meet48-vod',
        'replay',
        'room',
        'followed-rooms',
        'message',
        'img',
        'dynamic',
        'weibo',
        'performances',
        'openlive',
        'send-flip',
        'flip',
        'nft',
        'video',
        'music',
        'official-site-music',
        'audio',
        'profile',
        'database',
        'invoice',
        'melee',
        'trip',
        'login',
        'settings',
        'voice'
]);

async function fetchNestedRouteAsset(request, env, url) {
    const parts = decodeURIComponent(String(url.pathname || '/'))
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
    if (parts.length < 2 || !WEB_APP_ROUTE_SLUGS.has(parts[0])) return null;

    const nestedAssetPath = `/${parts.slice(1).join('/')}`;
    const looksLikeFile = /\/[^/]+\.[^/]+$/.test(nestedAssetPath);
    const looksLikeSourceAsset = nestedAssetPath.startsWith('/src/');
    if (!looksLikeFile && !looksLikeSourceAsset) return null;

    const assetUrl = new URL(request.url);
    assetUrl.pathname = nestedAssetPath;
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    return response.status === 404 ? null : response;
}

function getApiBackend(env) {
    if (env && Object.prototype.hasOwnProperty.call(env, 'YAYA_API_BACKEND')) {
        const configured = String(env.YAYA_API_BACKEND || '').trim();
        if (!configured || configured === 'local') return '';
        return configured.replace(/\/+$/, '');
    }
    const value = String(DEFAULT_API_BACKEND || '').trim().replace(/\/+$/, '');
    return value || '';
}

function isPocketBackendApiPath(pathname) {
    return pathname === '/api/pocket'
        || pathname === '/api/text-proxy';
}

async function shouldProxyIpcToBackend(request) {
    if (request.method !== 'POST') return false;
    try {
        const body = await request.clone().json();
        return new Set([
            'login-send-sms',
            'login-by-code',
            'login-check-token',
            'fetch-trip-list',
            'fetch-invoice-tips',
            'fetch-invoice-config',
            'fetch-invoice-order-list',
            'apply-electronic-invoice'
        ]).has(String(body?.channel || ''));
    } catch (error) {
        return false;
    }
}

async function proxyIpcRequest(request, env, apiBackend) {
    let channel = '';
    try {
        const body = await request.clone().json();
        channel = String(body?.channel || '');
    } catch (error) { reportIgnoredError(error, 'workers/yaya-web.mjs'); }

    const response = await proxyApiRequest(request.clone(), apiBackend, {
        timeoutMs: invoiceLoadChannels.has(channel) ? INVOICE_BACKEND_TIMEOUT_MS : 0
    });
    if (!invoiceChannels.has(channel)) {
        return response;
    }

    const text = await response.clone().text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (error) {
        return response;
    }

    const msg = String(data?.msg || data?.message || '');
    if (!data?.success && msg.includes(`网页版暂不支持: ${channel}`)) {
        return json({
            success: false,
            msg: 'api.gnz.hk 后端还是旧版本，暂不支持发票接口。请更新并重启后端 server/yaya-api.mjs。'
        }, 502);
    }
    return response;
}

async function proxyApiRequest(request, apiBackend, options = {}) {
    const sourceUrl = new URL(request.url);
    const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, apiBackend);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const init = {
        method: request.method,
        headers,
        redirect: 'manual',
        ...(controller ? { signal: controller.signal } : {})
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }
    try {
        const response = await fetch(targetUrl.toString(), init);
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
            return response;
        }

        const text = await response.text();
        if (!/^\s*</.test(text || '')) {
            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }

        return json({
            success: false,
            msg: 'API 后端被 Cloudflare 浏览器校验拦截，请放行 api.gnz.hk/api/* 或配置不受校验的 YAYA_API_BACKEND。'
        }, 502);
    } catch (error) {
        if (controller?.signal.aborted) {
            logWorkerEvent('warn', 'api_backend_timeout', {
                path: sourceUrl.pathname,
                timeoutMs
            });
            return json({
                success: false,
                msg: '开票服务响应超时，请稍后重试'
            }, 504);
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function handleDownloadRequest(request, env, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ success: false, msg: 'Method Not Allowed' }, 405);
    }
    if (!env.YAYA_DOWNLOADS) {
        return new Response('Download storage is not configured', { status: 500 });
    }

    const requestedKey = decodeURIComponent(url.pathname.replace(/^\/downloads\/?/, '') || DESKTOP_DOWNLOAD_FILE)
        .replace(/^\/+/, '');
    if (!requestedKey || requestedKey.includes('..') || requestedKey.includes('\\')) {
        return new Response('Invalid download path', { status: 400 });
    }

    const resolvedKey = requestedKey;
    const rangeHeader = request.headers.get('range');
    const getOptions = rangeHeader ? { range: request.headers } : undefined;
    const object = await env.YAYA_DOWNLOADS.get(resolvedKey, getOptions);
    if (!object) {
        return new Response('File not found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=3600');
    headers.set('Content-Type', headers.get('Content-Type') || getDownloadContentType(resolvedKey));
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(resolvedKey.split('/').pop() || DESKTOP_DOWNLOAD_FILE)}"`);
    const isRangeResponse = Boolean(rangeHeader && object.range);
    if (isRangeResponse) {
        headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.end ?? object.size - 1}/${object.size}`);
        headers.set('Content-Length', String((object.range.end ?? object.size - 1) - object.range.offset + 1));
    } else {
        headers.set('Content-Length', String(object.size));
    }

    return new Response(request.method === 'HEAD' ? null : object.body, {
        status: isRangeResponse ? 206 : 200,
        headers
    });
}

function getDownloadContentType(key) {
    const lowered = String(key || '').toLowerCase();
    if (lowered.endsWith('.tar.gz') || lowered.endsWith('.tgz')) return 'application/gzip';
    if (lowered.endsWith('.zip')) return 'application/zip';
    if (lowered.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
    return 'application/octet-stream';
}

const R2_MUSIC_PREFIXES = [
    'SNH48/',
    'GNZ48/',
    'BEJ48/',
    'CKG48/',
    'CGT48/',
    'SHY48/',
    'TSH48/',
    'AKB48/',
    'TPE48/',
    '7SENSES/',
    'BLUEV/',
    'DEMOON/',
    'HO2/',
    'Color Girls/',
    '塞纳河组合/'
];
const R2_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);
const R2_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const R2_MUSIC_IMAGE_CACHE_SECONDS = 30 * 24 * 60 * 60;
const R2_MUSIC_AUDIO_CACHE_SECONDS = 7 * 24 * 60 * 60;

function getR2MusicBucket(env) {
    return env.YAYA_MUSIC || env.YAYA_DOWNLOADS;
}

function getR2MusicCorsHeaders(extraHeaders = {}) {
    const headers = new Headers(extraHeaders);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range, Cache-Control, Content-Type');
    headers.set('Access-Control-Expose-Headers', 'X-Yaya-Cache, Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type');
    return headers;
}

function r2MusicOptionsResponse() {
    return new Response(null, {
        status: 204,
        headers: getR2MusicCorsHeaders({ 'Cache-Control': 'no-store' })
    });
}

function getR2ObjectExtension(key) {
    const file = String(key || '').split('/').pop() || '';
    const match = file.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
}

function isAllowedR2MusicKey(key) {
    const normalizedKey = String(key || '').replace(/^\/+/, '');
    return normalizedKey
        && !normalizedKey.includes('..')
        && !normalizedKey.includes('\\')
        && R2_MUSIC_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix));
}

function getR2MusicContentType(key, fallback = '') {
    const ext = getR2ObjectExtension(key);
    if (fallback) return fallback;
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a' || ext === 'aac') return 'audio/mp4';
    if (ext === 'wav') return 'audio/wav';
    if (ext === 'flac') return 'audio/flac';
    if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    return 'application/octet-stream';
}

function encodeR2MusicPath(key) {
    return String(key || '').split('/').map(encodeURIComponent).join('/');
}

function parseR2MusicTitle(key) {
    const override = R2_MUSIC_TITLE_OVERRIDES.get(String(key || ''));
    if (override) return override;
    const file = String(key || '').split('/').pop() || '';
    return file
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/^\s*\d{1,3}\s*[._\-、\]\)]\s*/u, '')
        .replace(/^\s*[\[\(（]\s*\d{1,3}\s*[\]\)）]\s*/u, '')
        .replace(/_\d{1,3}$/u, '')
        .trim() || file;
}

function getR2MusicAlbum(key) {
    const parts = String(key || '').split('/').filter(Boolean);
    if (parts.length <= 2) return '';
    const albumPath = parts.slice(0, -1).join('/');
    return R2_MUSIC_ALBUM_OVERRIDES.get(albumPath) || parts.slice(1, -1).join(' / ');
}

function getR2MusicGroupInfo(key) {
    const folder = String(key || '').split('/').filter(Boolean)[0] || '';
    const label = folder || '公演';
    return {
        groupLabel: label,
        groupKey: label.replace(/48$/i, '').toUpperCase() || label.toUpperCase()
    };
}

async function listR2MusicObjects(bucket) {
    const objectsByPrefix = await Promise.all(R2_MUSIC_PREFIXES.map(async (prefix) => {
        const objects = [];
        let cursor = undefined;
        do {
            const listed = await bucket.list({ prefix, cursor, limit: 1000 });
            objects.push(...(listed.objects || []));
            cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
        return objects;
    }));

    return objectsByPrefix.flat();
}

async function loadR2MusicAlbumMetadata(bucket) {
    try {
        const metadataObject = await bucket.get(R2_MUSIC_ALBUM_METADATA_KEY);
        if (!metadataObject) return new Map();
        const payload = JSON.parse(await metadataObject.text());
        const albums = payload && typeof payload.albums === 'object' ? payload.albums : {};
        return new Map(Object.entries(albums).map(([key, value]) => [key, {
            grouping: String(value?.grouping || '').trim(),
            date: String(value?.date || '').trim()
        }]));
    } catch (error) {
        logWorkerEvent('error', 'r2_music_album_metadata_failed', { error: getErrorMessage(error) });
        return new Map();
    }
}

function normalizeR2MusicTrackNumber(value) {
    const match = String(value ?? '').trim().match(/^\s*(\d{1,4})/u);
    const number = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function parseR2MusicTrackNumberFromKey(key) {
    const file = String(key || '').split('/').pop() || '';
    const match = file.match(/^\s*(?:[\[(（]\s*)?(\d{1,3})(?:\s*[\])）]|\s*[._\-、])\s*/u);
    return match ? normalizeR2MusicTrackNumber(match[1]) : 0;
}

async function loadR2MusicTrackMetadata(bucket) {
    try {
        const metadataObject = await bucket.get(R2_MUSIC_TRACK_METADATA_KEY);
        if (!metadataObject) return new Map();
        const payload = JSON.parse(await metadataObject.text());
        const tracks = payload && typeof payload.tracks === 'object' ? payload.tracks : {};
        return new Map(Object.entries(tracks).map(([key, value]) => [key, {
            trackNumber: normalizeR2MusicTrackNumber(value?.trackNumber),
            discNumber: normalizeR2MusicTrackNumber(value?.discNumber) || 1
        }]));
    } catch (error) {
        logWorkerEvent('error', 'r2_music_track_metadata_failed', { error: getErrorMessage(error) });
        return new Map();
    }
}

async function handleR2MusicListRequest(request, env, ctx) {
    if (request.method === 'OPTIONS') {
        return r2MusicOptionsResponse();
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(JSON.stringify({ success: false, msg: 'Method Not Allowed', tracks: [] }), {
            status: 405,
            headers: getR2MusicCorsHeaders({
                'Content-Type': 'application/json;charset=utf-8',
                'Cache-Control': 'no-store'
            })
        });
    }
    const musicBucket = getR2MusicBucket(env);
    if (!musicBucket || typeof musicBucket.list !== 'function') {
        return new Response(JSON.stringify({ success: false, msg: 'Music storage is not configured', tracks: [] }), {
            status: 500,
            headers: getR2MusicCorsHeaders({
                'Content-Type': 'application/json;charset=utf-8',
                'Cache-Control': 'no-store'
            })
        });
    }

    const bypassCache = /\bno-cache\b/i.test(request.headers.get('Cache-Control') || '');
    const now = Date.now();
    if (!bypassCache && r2MusicListCache && r2MusicListCache.expiresAt > now) {
        return new Response(r2MusicListCache.body, {
            headers: getR2MusicCorsHeaders({
                'Content-Type': 'application/json;charset=utf-8',
                'Cache-Control': `public, max-age=${R2_MUSIC_LIST_CACHE_TTL_SECONDS}`,
                'X-Yaya-Cache': 'HIT'
            })
        });
    }
    const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
    const edgeCacheKey = new Request(new URL('/api/r2-music-cache-v7', request.url).toString(), { method: 'GET' });
    if (!bypassCache && edgeCache) {
        const cached = await edgeCache.match(edgeCacheKey);
        if (cached) {
            const body = await cached.text();
            r2MusicListCache = {
                body,
                expiresAt: now + R2_MUSIC_LIST_CACHE_TTL_MS
            };
            return new Response(body, {
                headers: getR2MusicCorsHeaders({
                    'Content-Type': 'application/json;charset=utf-8',
                    'Cache-Control': `public, max-age=${R2_MUSIC_LIST_CACHE_TTL_SECONDS}`,
                    'X-Yaya-Cache': 'HIT'
                })
            });
        }
    }

    let objects;
    let albumMetadata;
    let trackMetadata;
    try {
        [objects, albumMetadata, trackMetadata] = await Promise.all([
            listR2MusicObjects(musicBucket),
            loadR2MusicAlbumMetadata(musicBucket),
            loadR2MusicTrackMetadata(musicBucket)
        ]);
    } catch (error) {
        logWorkerEvent('error', 'r2_music_list_failed', {
            prefixCount: R2_MUSIC_PREFIXES.length,
            error: getErrorMessage(error)
        });
        throw error;
    }
    const imageByFolder = new Map();
    objects.forEach((object) => {
        const key = object.key || '';
        const ext = getR2ObjectExtension(key);
        if (!R2_IMAGE_EXTENSIONS.has(ext)) return;
        const folder = key.split('/').slice(0, -1).join('/');
        const current = imageByFolder.get(folder);
        const file = key.split('/').pop() || '';
        const isPreferred = /^(cover|folder|front|封面)\./i.test(file);
        if (!current || isPreferred) imageByFolder.set(folder, key);
    });

    const tracks = objects
        .filter((object) => R2_AUDIO_EXTENSIONS.has(getR2ObjectExtension(object.key || '')))
        .map((object, index) => {
            const key = object.key || '';
            const folder = key.split('/').slice(0, -1).join('/');
            const group = getR2MusicGroupInfo(key);
            const album = getR2MusicAlbum(key);
            const metadata = albumMetadata.get(`${group.groupLabel}/${album}`) || {};
            const trackOrder = trackMetadata.get(key) || {};
            const coverKey = imageByFolder.get(folder) || imageByFolder.get(key.split('/')[0]) || '';
            return {
                id: `R2-${key}`,
                key,
                title: parseR2MusicTitle(key),
                album,
                grouping: metadata.grouping || '',
                albumDate: metadata.date || '',
                trackNumber: trackOrder.trackNumber || parseR2MusicTrackNumberFromKey(key),
                discNumber: trackOrder.discNumber || 1,
                groupKey: group.groupKey,
                groupLabel: group.groupLabel,
                mp3: `${R2_MUSIC_PUBLIC_ORIGIN}/${encodeR2MusicPath(key)}`,
                coverUrl: coverKey ? `${R2_MUSIC_PUBLIC_ORIGIN}/${encodeR2MusicPath(coverKey)}` : '',
                size: object.size || 0,
                uploaded: object.uploaded ? object.uploaded.toISOString() : '',
                sourceIndex: 100000 + index,
                source: 'r2-performance'
            };
        });

    const body = JSON.stringify({ success: true, tracks });
    r2MusicListCache = {
        body,
        expiresAt: now + R2_MUSIC_LIST_CACHE_TTL_MS
    };
    const response = new Response(body, {
        headers: getR2MusicCorsHeaders({
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': `public, max-age=${R2_MUSIC_LIST_CACHE_TTL_SECONDS}`,
            'X-Yaya-Cache': 'MISS'
        })
    });
    logWorkerEvent('info', 'r2_music_index_refreshed', {
        prefixCount: R2_MUSIC_PREFIXES.length,
        objectCount: objects.length,
        trackCount: tracks.length
    });
    if (edgeCache) {
        const cacheWrite = edgeCache.put(edgeCacheKey, response.clone()).catch((error) => {
            logWorkerEvent('error', 'r2_music_cache_write_failed', {
                error: getErrorMessage(error)
            });
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(cacheWrite);
        } else {
            await cacheWrite;
        }
    }
    return response;
}

async function handleR2MusicObjectRequest(request, env, url) {
    if (request.method === 'OPTIONS') {
        return r2MusicOptionsResponse();
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
            status: 405,
            headers: getR2MusicCorsHeaders({
                'Content-Type': 'text/plain;charset=utf-8',
                'Cache-Control': 'no-store'
            })
        });
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/r2-music\/?/, '')).replace(/^\/+/, '');
    const ext = getR2ObjectExtension(key);
    if (!isAllowedR2MusicKey(key) || (!R2_AUDIO_EXTENSIONS.has(ext) && !R2_IMAGE_EXTENSIONS.has(ext))) {
        return new Response('Invalid music path', {
            status: 400,
            headers: getR2MusicCorsHeaders({
                'Content-Type': 'text/plain;charset=utf-8',
                'Cache-Control': 'no-store'
            })
        });
    }

    return new Response(null, {
        status: 307,
        headers: getR2MusicCorsHeaders({
            Location: `${R2_MUSIC_PUBLIC_ORIGIN}/${encodeR2MusicPath(key)}`,
            'Cache-Control': 'public, max-age=604800'
        })
    });
}

function withWebRuntimeHeaders(response, url = null) {
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    if (url) {
        const contentType = headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        } else if (url.pathname === '/service-worker.js') {
            headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        } else if (url.searchParams.has('v')) {
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (/\.(?:png|ico|svg|webp|wasm)$/i.test(url.pathname)) {
            headers.set('Cache-Control', 'public, max-age=86400');
        }
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

async function handleIpc(request, env) {
    if (request.method !== 'POST') {
        return json({ success: false, msg: 'Method Not Allowed' }, 405);
    }

    let channel = '';
    try {
        const body = await request.json();
        channel = String(body?.channel || '');
        if (!hasPocketChannel(channel)) {
            return json({ success: false, msg: `网页版暂不支持: ${channel}` }, 404);
        }

        const result = await invokePocketChannel(channel, body?.payload || {}, env);
        return json(result);
    } catch (error) {
        logWorkerEvent('error', 'ipc_request_failed', {
            channel,
            error: getErrorMessage(error)
        });
        return json({ success: false, msg: error?.message || 'API 错误' }, 500);
    }
}

async function handlePocketProxy(request) {
    if (request.method !== 'POST') {
        return json({ status: 405, message: 'Method Not Allowed', content: {} }, 405);
    }

    try {
        const body = await request.json();
        const apiPath = normalizePocketPath(body?.path);
        const postData = normalizePostData(body?.postData);
        const requestUrl = `https://pocketapi.48.cn${apiPath}`;
        let lastStatus = 502;

        for (let attempt = 0; attempt <= POCKET_PROXY_RETRY_DELAYS_MS.length; attempt += 1) {
            try {
                const response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        'User-Agent': 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)',
                        'Accept-Language': 'zh-Hans-CN;q=1',
                        appInfo: JSON.stringify({
                            vendor: 'apple',
                            deviceId: createProxyDeviceId(),
                            appVersion: '7.1.35',
                            appBuild: '25101021',
                            osVersion: '16.3.0',
                            osType: 'ios',
                            deviceName: 'iPhone 14 Pro',
                            os: 'ios'
                        })
                    },
                    body: JSON.stringify(postData)
                });

                const text = await response.text();
                lastStatus = response.status;
                let validJson = false;
                try {
                    if (text) JSON.parse(text);
                    validJson = Boolean(text);
                } catch (error) {
                    validJson = false;
                }

                const retryable = !validJson || response.status === 429 || response.status >= 500;
                if (retryable && attempt < POCKET_PROXY_RETRY_DELAYS_MS.length) {
                    await new Promise((resolve) => setTimeout(resolve, POCKET_PROXY_RETRY_DELAYS_MS[attempt]));
                    continue;
                }

                if (!validJson) {
                    return json({
                        status: 502,
                        message: '口袋 API 暂时返回了网页内容，请稍后重试。',
                        content: {}
                    }, 502);
                }

                return new Response(text, {
                    status: response.ok ? 200 : response.status,
                    headers: {
                        'Content-Type': 'application/json;charset=utf-8',
                        'Cache-Control': 'no-store'
                    }
                });
            } catch (error) {
                if (attempt < POCKET_PROXY_RETRY_DELAYS_MS.length) {
                    await new Promise((resolve) => setTimeout(resolve, POCKET_PROXY_RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                throw error;
            }
        }

        return json({ status: lastStatus, message: 'Pocket API 请求失败', content: {} }, lastStatus);
    } catch (error) {
        logWorkerEvent('error', 'pocket_proxy_failed', {
            error: getErrorMessage(error)
        });
        return json({ status: 500, message: error?.message || 'Pocket API 请求失败', content: {} }, 500);
    }
}

async function handleTextProxy(request) {
    if (request.method !== 'GET') {
        return textResponse('Method Not Allowed', 405);
    }

    const requestUrl = new URL(request.url);
    const targetValue = requestUrl.searchParams.get('url') || '';

    let targetUrl;
    try {
        targetUrl = new URL(targetValue);
    } catch (error) {
        return textResponse('Bad Request', 400);
    }

    const allowedHosts = new Set([
        'source.48.cn',
        'source2.48.cn'
    ]);

    if (targetUrl.protocol !== 'https:' || !allowedHosts.has(targetUrl.hostname)) {
        return textResponse('Forbidden', 403);
    }

    try {
        const response = await fetch(targetUrl.toString(), {
            headers: {
                'User-Agent': 'PocketFans201807/7.1.35 (iPhone; iOS 16.3; Scale/3.00)',
                'Accept': 'text/plain,*/*'
            }
        });

        const text = await response.text();
        return new Response(text, {
            status: response.status,
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
                'Cache-Control': 'no-store'
            }
        });
    } catch (error) {
        logWorkerEvent('error', 'text_proxy_failed', {
            host: targetUrl.hostname,
            error: getErrorMessage(error)
        });
        return textResponse(error?.message || 'Proxy Error', 502);
    }
}

async function handleMediaProxy(request) {
    if (request.method !== 'GET') {
        return textResponse('Method Not Allowed', 405);
    }

    const requestUrl = new URL(request.url);
    const targetValue = requestUrl.searchParams.get('url') || '';
    let targetUrl;
    try {
        targetUrl = new URL(targetValue);
    } catch (error) {
        return textResponse('Bad Request', 400);
    }

    const hostname = targetUrl.hostname.toLowerCase();
    const isAllowedHost = hostname === 'source.48.cn'
        || hostname === 'source2.48.cn'
        || hostname.endsWith('.48.cn');
    if (!['http:', 'https:'].includes(targetUrl.protocol) || !isAllowedHost) {
        return textResponse('Forbidden', 403);
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 PocketFans201807/7.1.35',
        'Accept': '*/*',
        'Referer': 'https://h5.48.cn/'
    };
    const range = request.headers.get('range');
    if (range) headers.Range = range;

    try {
        const response = await fetch(targetUrl.toString(), { headers });
        const responseHeaders = new Headers();
        const passthroughHeaders = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'last-modified',
            'etag'
        ];
        for (const key of passthroughHeaders) {
            const value = response.headers.get(key);
            if (value) responseHeaders.set(key, value);
        }
        if (!responseHeaders.has('content-type')) {
            responseHeaders.set('content-type', 'application/octet-stream');
        }
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');
        return new Response(response.body, {
            status: response.status,
            headers: responseHeaders
        });
    } catch (error) {
        logWorkerEvent('error', 'media_proxy_failed', {
            host: targetUrl.hostname,
            error: getErrorMessage(error)
        });
        return textResponse(error?.message || 'Proxy Error', 502);
    }
}

function normalizePocketPath(value) {
    const apiPath = String(value || '').trim();
    if (!apiPath.startsWith('/') || apiPath.includes('://') || apiPath.includes('..')) {
        throw new Error('无效的 Pocket API 路径');
    }
    return apiPath;
}

function normalizePostData(value) {
    if (value && typeof value === 'object') {
        return value;
    }
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function textResponse(text, status = 200) {
    return new Response(text, {
        status,
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}
