const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const axios = require('axios');
const { app, dialog, nativeImage, Notification: ElectronNotification, session, shell } = require('electron');
const { ensureStoragePaths } = require('../../common/storage-paths');
const { reportIgnoredError } = require('../../common/error-utils');
const { getAppIconPath } = require('./app-icon-service');

const IMAGE_THUMB_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
const imageThumbInflight = new Map();
const jsonlKeyCache = new Map();
const activeNativeNotifications = new Set();
const MAX_ACTIVE_NATIVE_NOTIFICATIONS = 200;
const notificationAvatarMemoryCache = new Map();
const notificationAvatarInflight = new Map();
const MAX_NOTIFICATION_AVATAR_MEMORY_CACHE = 120;
const NOTIFICATION_AVATAR_SIZE = 128;
const WINDOWS_APP_USER_MODEL_ID = 'com.yaya.message';
const WINDOWS_APP_DISPLAY_NAME = '牙牙消息';
let windowsNotificationRegistered = false;
let windowsNotificationRegisteredIconPath = '';

function truncateNotificationText(value, maxLength) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function getAppNotificationIcon() {
    try {
        const defaultIconPath = path.join(
            __dirname,
            process.platform === 'win32' ? '../../../icon.ico' : '../../../icon.png'
        );
        const iconPath = getAppIconPath(defaultIconPath);
        const image = nativeImage.createFromPath(iconPath);
        return image && !image.isEmpty() ? image : null;
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/system-service.js');
        return null;
    }
}

function getWindowsNotificationIconPath() {
    try {
        const defaultIconPath = path.join(__dirname, '../../../icon.ico');
        return getAppIconPath(defaultIconPath);
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/system-service.js');
        return '';
    }
}

function ensureWindowsNotificationRegistration() {
    if (process.platform !== 'win32') return;
    const iconPath = getWindowsNotificationIconPath();
    if (windowsNotificationRegistered && windowsNotificationRegisteredIconPath === iconPath) return;
    windowsNotificationRegistered = true;
    windowsNotificationRegisteredIconPath = iconPath;

    try {
        app?.setAppUserModelId?.(WINDOWS_APP_USER_MODEL_ID);
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/system-service.js');
    }

    const regKey = `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_USER_MODEL_ID}`;
    execFile('reg', ['add', regKey, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', WINDOWS_APP_DISPLAY_NAME, '/f'], {
        windowsHide: true,
        timeout: 3000
    }, (error) => {
        if (error) reportIgnoredError(error, 'src/main/services/system-service.js');
    });
    if (iconPath) {
        execFile('reg', ['add', regKey, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconPath, '/f'], {
            windowsHide: true,
            timeout: 3000
        }, (error) => {
            if (error) reportIgnoredError(error, 'src/main/services/system-service.js');
        });
    }
}

function rememberNotificationAvatar(cacheKey, image) {
    if (!cacheKey || !image || image.isEmpty()) return;
    if (notificationAvatarMemoryCache.has(cacheKey)) {
        notificationAvatarMemoryCache.delete(cacheKey);
    }
    notificationAvatarMemoryCache.set(cacheKey, image);
    while (notificationAvatarMemoryCache.size > MAX_NOTIFICATION_AVATAR_MEMORY_CACHE) {
        const oldestKey = notificationAvatarMemoryCache.keys().next().value;
        notificationAvatarMemoryCache.delete(oldestKey);
    }
}

async function resolveNotificationAvatarIcon(rawIconUrl) {
    const iconUrl = String(rawIconUrl || '').trim();
    if (!iconUrl) return null;

    if (/^data:image\//i.test(iconUrl)) {
        try {
            const image = nativeImage.createFromDataURL(iconUrl);
            if (!image || image.isEmpty()) return null;
            return image.resize({ width: NOTIFICATION_AVATAR_SIZE, height: NOTIFICATION_AVATAR_SIZE, quality: 'good' });
        } catch (error) {
            reportIgnoredError(error, 'src/main/services/system-service.js');
            return null;
        }
    }

    if (!/^https?:\/\//i.test(iconUrl)) return null;

    const cachedMemory = notificationAvatarMemoryCache.get(iconUrl);
    if (cachedMemory && !cachedMemory.isEmpty()) {
        return cachedMemory;
    }

    const { internalDataDir } = ensureStoragePaths();
    const cacheDir = path.join(internalDataDir, 'notification-avatar-cache');
    const hash = crypto.createHash('sha1').update(iconUrl).digest('hex');
    const diskPath = path.join(cacheDir, `${hash}.png`);

    try {
        if (fs.existsSync(diskPath) && fs.statSync(diskPath).size > 64) {
            const diskImage = nativeImage.createFromPath(diskPath);
            if (diskImage && !diskImage.isEmpty()) {
                rememberNotificationAvatar(iconUrl, diskImage);
                return diskImage;
            }
        }
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/system-service.js');
    }

    if (notificationAvatarInflight.has(iconUrl)) {
        return notificationAvatarInflight.get(iconUrl);
    }

    const promise = (async () => {
        const response = await axios.get(iconUrl, {
            responseType: 'arraybuffer',
            timeout: 2500,
            maxContentLength: 10 * 1024 * 1024,
            headers: {
                Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                Referer: 'https://h5.48.cn/',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        const decoded = nativeImage.createFromBuffer(Buffer.from(response.data || []));
        if (!decoded || decoded.isEmpty()) return null;

        const resized = decoded.resize({
            width: NOTIFICATION_AVATAR_SIZE,
            height: NOTIFICATION_AVATAR_SIZE,
            quality: 'good'
        });
        try {
            const pngBytes = resized.toPNG();
            if (pngBytes && pngBytes.length > 64) {
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(diskPath, pngBytes);
            }
        } catch (error) {
            reportIgnoredError(error, 'src/main/services/system-service.js');
        }
        rememberNotificationAvatar(iconUrl, resized);
        return resized;
    })().catch((error) => {
        reportIgnoredError(error, 'src/main/services/system-service.js');
        return null;
    }).finally(() => {
        notificationAvatarInflight.delete(iconUrl);
    });

    notificationAvatarInflight.set(iconUrl, promise);
    return promise;
}

function openNotificationTarget(payload, title, mainWindow) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    if (process.platform === 'darwin') {
        try {
            app?.focus?.({ steal: true });
        } catch (error) {
            reportIgnoredError(error, 'src/main/services/system-service.js');
        }
    }
    mainWindow.focus();
    mainWindow.webContents.send('open-followed-room-from-notification', {
        memberName: String(payload.memberName || title),
        channelId: String(payload.channelId || ''),
        mainChannelId: String(payload.mainChannelId || payload.channelId || ''),
        serverId: String(payload.serverId || ''),
        roomType: payload.roomType === 'small' ? 'small' : 'big'
    });
}

async function showSystemNotification(payload = {}, mainWindow) {
    if (!ElectronNotification || (typeof ElectronNotification.isSupported === 'function' && !ElectronNotification.isSupported())) {
        return { success: false, msg: '当前系统不支持原生通知' };
    }

    if (process.platform === 'win32') {
        ensureWindowsNotificationRegistration();
    }

    const title = truncateNotificationText(payload.title || '牙牙消息', 80);
    const body = truncateNotificationText(payload.body || '收到一条新消息', 220);
    const avatarIcon = await resolveNotificationAvatarIcon(payload.iconUrl);
    const appIcon = getAppNotificationIcon();
    const notificationIcon = process.platform === 'darwin'
        ? avatarIcon
        : (avatarIcon || appIcon);

    try {
        const notificationOptions = {
            title,
            body,
            silent: false
        };
        if (notificationIcon && !notificationIcon.isEmpty()) {
            notificationOptions.icon = notificationIcon;
        }
        if (process.platform === 'win32' || process.platform === 'linux') {
            notificationOptions.timeoutType = 'default';
        }
        if (process.platform === 'linux') {
            notificationOptions.urgency = 'normal';
        }

        const notification = new ElectronNotification(notificationOptions);
        activeNativeNotifications.add(notification);
        while (activeNativeNotifications.size > MAX_ACTIVE_NATIVE_NOTIFICATIONS) {
            const oldest = activeNativeNotifications.values().next().value;
            if (!oldest) break;
            activeNativeNotifications.delete(oldest);
        }

        notification.once('click', () => {
            activeNativeNotifications.delete(notification);
            openNotificationTarget(payload, title, mainWindow);
        });
        notification.once('failed', (_event, error) => {
            console.warn('[系统通知] 原生通知发送失败:', error || 'unknown error');
            activeNativeNotifications.delete(notification);
        });
        notification.show();
        return { success: true, native: true };
    } catch (error) {
        console.warn('[系统通知] 原生通知创建失败:', error.message || error);
        return {
            success: false,
            msg: error.message || '系统通知发送失败'
        };
    }
}

function normalizeIncomingEntries(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }

    return entries
        .filter((entry) => entry && entry.key)
        .map((entry) => ({
            ...entry,
            key: String(entry.key),
            sortTime: Number(entry.sortTime) || 0
        }));
}

function loadExistingJsonlKeys(filePath) {
    if (!fs.existsSync(filePath)) {
        return new Set();
    }

    const stat = fs.statSync(filePath);
    const cached = jsonlKeyCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return new Set(cached.keys);
    }

    const keys = new Set();
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const record = JSON.parse(trimmed);
            if (record && record.key) keys.add(String(record.key));
        } catch (error) {
            console.warn(`[JSONL 跳过] 无法解析消息记录: ${filePath}`);
        }
    }

    jsonlKeyCache.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        keys
    });
    return new Set(keys);
}

function fileEndsWithNewline(filePath) {
    const size = fs.statSync(filePath).size;
    if (size === 0) return true;

    const descriptor = fs.openSync(filePath, 'r');
    try {
        const lastByte = Buffer.alloc(1);
        fs.readSync(descriptor, lastByte, 0, 1, size - 1);
        return lastByte[0] === 10 || lastByte[0] === 13;
    } finally {
        fs.closeSync(descriptor);
    }
}

function safeFileName(value, fallback = '未命名成员') {
    return String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim() || fallback;
}

function normalizeImageContentType(value) {
    const contentType = String(value || '').split(';')[0].trim().toLowerCase();
    return /^image\/[a-z0-9.+-]+$/.test(contentType) ? contentType : 'image/jpeg';
}

async function fetchRemoteImageDataUrl({ url } = {}) {
    const remoteUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(remoteUrl)) {
        return { success: false, msg: '图片地址无效' };
    }

    try {
        const response = await axios.get(remoteUrl, {
            responseType: 'arraybuffer',
            timeout: 20000,
            maxContentLength: 30 * 1024 * 1024,
            headers: {
                Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                Referer: 'https://h5.48.cn/',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const contentType = normalizeImageContentType(response.headers?.['content-type']);
        const body = Buffer.from(response.data || []);
        if (!body.length) {
            return { success: false, msg: '图片内容为空' };
        }

        return {
            success: true,
            dataUrl: `data:${contentType};base64,${body.toString('base64')}`
        };
    } catch (error) {
        return {
            success: false,
            msg: error.message || '图片加载失败'
        };
    }
}

function normalizeThumbnailWidth(value) {
    const width = Number(value) || 520;
    return Math.max(160, Math.min(900, Math.round(width)));
}

function getImageThumbnailCachePath(url, width) {
    const { internalDataDir } = ensureStoragePaths();
    const cacheDir = path.join(internalDataDir, 'image-thumb-cache');
    const key = crypto.createHash('sha1').update(`${width}:${url}`).digest('hex');
    return {
        cacheDir,
        filePath: path.join(cacheDir, `${key}.jpg`)
    };
}

function readCachedThumbnail(filePath) {
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 128) {
            return {
                success: true,
                cached: true,
                url: pathToFileURL(filePath).href
            };
        }
    } catch (error) { reportIgnoredError(error, 'src/main/services/system-service.js'); }

    return null;
}

function cleanupImageThumbnailCache(cacheDir) {
    try {
        if (!fs.existsSync(cacheDir)) return;

        const entries = fs.readdirSync(cacheDir)
            .filter(name => /\.jpg$/i.test(name))
            .map((name) => {
                const filePath = path.join(cacheDir, name);
                const stat = fs.statSync(filePath);
                return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
            });

        let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (totalSize <= IMAGE_THUMB_CACHE_LIMIT_BYTES) return;

        entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
        for (const entry of entries) {
            if (totalSize <= IMAGE_THUMB_CACHE_LIMIT_BYTES) break;
            try {
                fs.unlinkSync(entry.filePath);
                totalSize -= entry.size;
            } catch (error) { reportIgnoredError(error, 'src/main/services/system-service.js'); }
        }
    } catch (error) { reportIgnoredError(error, 'src/main/services/system-service.js'); }
}

async function createCachedImageThumbnail({ url, width } = {}) {
    const remoteUrl = String(url || '').trim();
    const targetWidth = normalizeThumbnailWidth(width);

    if (!/^https?:\/\//i.test(remoteUrl)) {
        return { success: false, msg: '图片地址无效' };
    }

    const { cacheDir, filePath } = getImageThumbnailCachePath(remoteUrl, targetWidth);
    const cached = readCachedThumbnail(filePath);
    if (cached) return cached;

    const cacheKey = `${targetWidth}:${remoteUrl}`;
    if (imageThumbInflight.has(cacheKey)) {
        return imageThumbInflight.get(cacheKey);
    }

    const promise = (async () => {
        fs.mkdirSync(cacheDir, { recursive: true });

        const response = await axios.get(remoteUrl, {
            responseType: 'arraybuffer',
            timeout: 20000,
            maxContentLength: 30 * 1024 * 1024,
            headers: {
                Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                Referer: 'https://h5.48.cn/',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const image = nativeImage.createFromBuffer(Buffer.from(response.data || []));
        if (image.isEmpty()) {
            return { success: false, msg: '图片解码失败' };
        }

        const size = image.getSize();
        const resizeWidth = Math.min(targetWidth, size.width || targetWidth);
        const resized = image.resize({ width: resizeWidth, quality: 'good' });
        const bytes = resized.toJPEG(78);
        if (!bytes || bytes.length <= 128) {
            return { success: false, msg: '缩略图生成失败' };
        }

        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempPath, bytes);
        try {
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(tempPath);
            } else {
                throw error;
            }
        }

        cleanupImageThumbnailCache(cacheDir);

        return {
            success: true,
            cached: false,
            url: pathToFileURL(filePath).href
        };
    })().catch((error) => ({
        success: false,
        msg: error.message || '缩略图缓存失败'
    })).finally(() => {
        imageThumbInflight.delete(cacheKey);
    });

    imageThumbInflight.set(cacheKey, promise);
    return promise;
}

function saveExportJsonl({ memberName, fileName, entries }) {
    try {
        const { htmlDir: baseDir } = ensureStoragePaths();
        const safeMemberName = safeFileName(memberName, '未命名成员');
        const memberDir = path.join(baseDir, safeMemberName);

        if (!fs.existsSync(memberDir)) {
            fs.mkdirSync(memberDir, { recursive: true });
        }

        const safeJsonlFileName = safeFileName(fileName || 'yaya_export.jsonl', 'yaya_export.jsonl')
            .replace(/\.(?:html|jsonl|json)$/i, '') + '.jsonl';
        const filePath = path.join(memberDir, safeJsonlFileName);
        const incomingEntries = normalizeIncomingEntries(entries);
        const existingKeys = loadExistingJsonlKeys(filePath);
        const newEntries = [];

        for (const entry of incomingEntries) {
            if (existingKeys.has(entry.key)) continue;
            existingKeys.add(entry.key);
            newEntries.push(entry);
        }

        if (newEntries.length === 0) {
            console.log(`[导出跳过] 没有新增消息: ${filePath}`);
            return {
                success: true,
                changed: false,
                path: filePath,
                addedCount: 0,
                totalCount: existingKeys.size
            };
        }

        const jsonlContent = newEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
            const prefix = fileEndsWithNewline(filePath) ? '' : '\n';
            fs.appendFileSync(filePath, prefix + jsonlContent, 'utf8');
        } else {
            fs.writeFileSync(filePath, jsonlContent, 'utf8');
        }
        const updatedStat = fs.statSync(filePath);
        jsonlKeyCache.set(filePath, {
            size: updatedStat.size,
            mtimeMs: updatedStat.mtimeMs,
            keys: existingKeys
        });
        console.log(`[导出成功] ${filePath}`);
        return {
            success: true,
            changed: true,
            path: filePath,
            addedCount: newEntries.length,
            totalCount: existingKeys.size
        };
    } catch (error) {
        console.error('[导出失败]', error);
        return {
            success: false,
            msg: error.message
        };
    }
}

async function openDirectoryDialog(mainWindow) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: '选择保存路径'
    });

    if (canceled) {
        return null;
    }

    return filePaths[0];
}

async function openMessageDataFolder() {
    try {
        const { htmlDir } = ensureStoragePaths();
        const result = await shell.openPath(htmlDir);
        if (result) {
            return { success: false, msg: result };
        }

        return { success: true, path: htmlDir };
    } catch (error) {
        return { success: false, msg: error.message };
    }
}

async function checkIpInfo() {
    try {
        const response = await axios.get('http://ip-api.com/json/?lang=zh-CN', { timeout: 5000 });
        if (response.data && response.data.status === 'success') {
            return { success: true, data: response.data };
        }

        return { success: false, msg: '获取失败' };
    } catch (error) {
        return { success: false, msg: error.message || '网络请求超时' };
    }
}

async function checkIpDomestic() {
    try {
        const response = await axios.get('https://myip.ipip.net', { timeout: 5000 });
        return { success: true, data: response.data.replace(/\s+/g, ' ').trim() };
    } catch (error) {
        return { success: false, msg: '连接失败' };
    }
}

async function checkIpForeign() {
    try {
        const response = await axios.get('http://ip-api.com/json/?lang=zh-CN', { timeout: 8000 });
        if (response.data && response.data.status === 'success') {
            return { success: true, data: response.data };
        }

        return { success: false, msg: '获取失败' };
    } catch (error) {
        return { success: false, msg: '连接失败' };
    }
}

async function fetchGoogleInfo(port, sourceName) {
    try {
        const response = await axios.get('http://ip-api.com/json/?lang=zh-CN', {
            timeout: 5000,
            proxy: { host: '127.0.0.1', port }
        });

        if (response.data && response.data.status === 'success') {
            return { success: true, data: response.data, usedProxy: sourceName };
        }
    } catch (error) {
        return { success: false, msg: `端口${port}能通Google，但查IP失败` };
    }

    return {
        success: true,
        data: { query: '连接成功', country: 'Google', regionName: '通畅', isp: 'Google Services' }
    };
}

async function checkIpGoogle() {
    const commonPorts = [
        ...Array.from({ length: 10 }, (_, index) => 7890 + index),
        ...Array.from({ length: 10 }, (_, index) => 10800 + index),
        8888,
        1080
    ];
    const googleTestUrl = 'http://www.google.com/generate_204';

    const checkPort = async (port) => {
        try {
            await axios.get(googleTestUrl, {
                timeout: 1500,
                proxy: { host: '127.0.0.1', port },
                validateStatus: (status) => status === 204 || status === 200
            });

            return port;
        } catch (error) {
            return null;
        }
    };

    console.log('[Google检测] 开始扫描代理端口...');

    try {
        const proxyStr = await session.defaultSession.resolveProxy(googleTestUrl);
        const match = proxyStr.match(/PROXY\s+([^\s:]+):(\d+)/i);
        if (match) {
            const port = parseInt(match[2], 10);
            const result = await checkPort(port);
            if (result) {
                return fetchGoogleInfo(port, '系统代理');
            }
        }
    } catch (error) { reportIgnoredError(error, 'src/main/services/system-service.js'); }

    try {
        const workingPort = await Promise.any(
            commonPorts.map(async (port) => {
                const result = await checkPort(port);
                if (!result) {
                    throw new Error('fail');
                }

                return result;
            })
        );

        console.log(`[Google检测] 发现可用端口: ${workingPort}`);
        return fetchGoogleInfo(workingPort, `端口${workingPort}`);
    } catch (error) {
        console.error('所有端口扫描均失败');
        return {
            success: false,
            msg: '连接失败。\n已扫描端口: 7890-7899, 10800-10809\n请确认已开启 HTTP 代理。'
        };
    }
}

function spawnDetached(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore'
        });

        let settled = false;

        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });

        child.once('spawn', () => {
            if (settled) return;
            settled = true;
            child.unref();
            resolve();
        });
    });
}

function stripWindowsCommandValue(value) {
    return String(value || '')
        .trim()
        .replace(/^"([^"]+)".*$/, '$1')
        .replace(/\s*"%1".*$/i, '')
        .replace(/^([^"]+?\.exe).*$/i, '$1')
        .trim();
}

function queryRegistryDefaultValue(key) {
    try {
        const output = execFileSync('reg', ['query', key, '/ve'], {
            encoding: 'utf8',
            windowsHide: true
        });
        const line = output.split(/\r?\n/).find(item => /\sREG_\w+\s/.test(item));
        if (!line) return '';
        return line.replace(/^\s*\(Default\)\s+REG_\w+\s+/i, '').trim();
    } catch (error) {
        return '';
    }
}

function getRegisteredWindowsPotPlayerPaths() {
    const registryKeys = [
        'HKCU\\Software\\Classes\\potplayer\\shell\\open\\command',
        'HKCR\\potplayer\\shell\\open\\command',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini64.exe',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini.exe',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini64.exe',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\PotPlayerMini.exe'
    ];

    return [...new Set(registryKeys
        .map(key => stripWindowsCommandValue(queryRegistryDefaultValue(key)))
        .filter(playerPath => playerPath && /\.exe$/i.test(playerPath) && fs.existsSync(playerPath)))];
}

function getExternalPlayerCandidates(mediaUrl) {
    if (process.platform === 'win32') {
        const registeredPlayers = getRegisteredWindowsPotPlayerPaths()
            .map(command => ({ command, args: [mediaUrl], needsPathCheck: true }));
        return [
            ...registeredPlayers,
            { command: 'C:\\PotPlayer\\PotPlayerMini64.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'C:\\PotPlayer\\PotPlayerMini.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'C:\\Program Files\\PotPlayer\\PotPlayerMini64.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe', args: [mediaUrl], needsPathCheck: true },
            { command: 'PotPlayerMini64.exe', args: [mediaUrl] },
            { command: 'PotPlayerMini.exe', args: [mediaUrl] }
        ];
    }

    if (process.platform === 'darwin') {
        return [
            { command: '/Applications/VLC.app/Contents/MacOS/VLC', args: [mediaUrl], needsPathCheck: true },
            { command: 'open', args: ['-a', 'VLC', mediaUrl] }
        ];
    }

    return [
        { command: 'vlc', args: [mediaUrl] },
        { command: '/snap/bin/vlc', args: [mediaUrl], needsPathCheck: true },
        { command: 'flatpak', args: ['run', 'org.videolan.VLC', mediaUrl] }
    ];
}

async function openExternalPlayer({ url }) {
    const mediaUrl = String(url || '').trim();
    if (!mediaUrl) {
        return { success: false, msg: '媒体地址不能为空' };
    }

    const candidates = getExternalPlayerCandidates(mediaUrl);
    const errors = [];

    for (const candidate of candidates) {
        try {
            if (candidate.needsPathCheck && !fs.existsSync(candidate.command)) {
                continue;
            }

            await spawnDetached(candidate.command, candidate.args);
            return {
                success: true,
                player: process.platform === 'win32' ? 'PotPlayer' : 'VLC'
            };
        } catch (error) {
            errors.push(`${candidate.command}: ${error.message}`);
        }
    }

    if (process.platform === 'win32') {
        try {
            await shell.openExternal(`potplayer://${mediaUrl}`);
            return { success: true, player: 'PotPlayer' };
        } catch (error) {
            errors.push(`potplayer:// ${error.message}`);
        }
    }

    return {
        success: false,
        msg: process.platform === 'win32'
            ? '未找到可用的 PotPlayer，请先安装 PotPlayer'
            : '未找到可用的 VLC，请先安装 VLC',
        detail: errors.join('\n')
    };
}

module.exports = {
    ensureWindowsNotificationRegistration,
    showSystemNotification,
    saveExportJsonl,
    openDirectoryDialog,
    openMessageDataFolder,
    fetchRemoteImageDataUrl,
    createCachedImageThumbnail,
    checkIpInfo,
    checkIpDomestic,
    checkIpForeign,
    checkIpGoogle,
    openExternalPlayer
};
