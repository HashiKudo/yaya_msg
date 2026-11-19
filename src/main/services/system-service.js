const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const axios = require('axios');
const { app, BrowserWindow, dialog, nativeImage, Notification: ElectronNotification, screen, session, shell } = require('electron');
const { ensureStoragePaths } = require('../../common/storage-paths');
const { reportIgnoredError } = require('../../common/error-utils');
const { getSettingValue } = require('./settings-service');
const { getAppIconPath } = require('./app-icon-service');

const IMAGE_THUMB_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
const imageThumbInflight = new Map();
const jsonlKeyCache = new Map();
const activeDesktopToasts = [];
const DESKTOP_TOAST_WIDTH = 456;
const DESKTOP_TOAST_HEIGHT = 126;
const DESKTOP_TOAST_GAP = 10;
const DESKTOP_TOAST_MARGIN = 16;
const DESKTOP_TOAST_DURATION_MS = 8000;
const DESKTOP_TOAST_MAX_VISIBLE = 1;
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
let cachedForegroundFullscreenState = { checkedAt: 0, isForegroundFullscreen: false };
let nativeNotificationUnavailable = false;
let nativeNotificationFailureCount = 0;
let nativeNotificationRetryAfter = 0;
let nativeNotificationFallbackLogged = false;

const WINDOWS_FULLSCREEN_CHECK_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YayaFullscreenCheck {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$window = [YayaFullscreenCheck]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero -or $window -eq [YayaFullscreenCheck]::GetShellWindow()) { Write-Output '0|0'; exit }
$rect = New-Object YayaFullscreenCheck+RECT
if (-not [YayaFullscreenCheck]::GetWindowRect($window, [ref]$rect)) { Write-Output '0|0'; exit }
$monitor = [YayaFullscreenCheck]::MonitorFromWindow($window, 2)
$info = New-Object YayaFullscreenCheck+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
if (-not [YayaFullscreenCheck]::GetMonitorInfo($monitor, [ref]$info)) { Write-Output '0|0'; exit }
[uint32]$ownerProcessId = 0
[void][YayaFullscreenCheck]::GetWindowThreadProcessId($window, [ref]$ownerProcessId)
$tolerance = 2
$isFullscreen = $rect.Left -le ($info.rcMonitor.Left + $tolerance) -and
    $rect.Top -le ($info.rcMonitor.Top + $tolerance) -and
    $rect.Right -ge ($info.rcMonitor.Right - $tolerance) -and
    $rect.Bottom -ge ($info.rcMonitor.Bottom - $tolerance)
Write-Output (([int]$isFullscreen).ToString() + '|' + $ownerProcessId.ToString())
`;

function runHiddenPowerShell(script, timeout = 1800) {
    return new Promise((resolve) => {
        execFile('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command', script
        ], {
            windowsHide: true,
            timeout,
            encoding: 'utf8'
        }, (error, stdout) => resolve(error ? '' : String(stdout || '').trim()));
    });
}

async function getForegroundFullscreenState() {
    if (process.platform !== 'win32') return { isForegroundFullscreen: false };
    const now = Date.now();
    if (now - cachedForegroundFullscreenState.checkedAt < 750) {
        return cachedForegroundFullscreenState;
    }

    const output = await runHiddenPowerShell(WINDOWS_FULLSCREEN_CHECK_SCRIPT);
    const [fullscreenFlag] = output.split('|');
    cachedForegroundFullscreenState = {
        checkedAt: Date.now(),
        isForegroundFullscreen: fullscreenFlag === '1'
    };
    return cachedForegroundFullscreenState;
}

function getNativeWindowHandleNumber(window) {
    const handle = window.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length < 4) return '';
    return handle.length >= 8
        ? handle.readBigUInt64LE(0).toString()
        : handle.readUInt32LE(0).toString();
}

async function placeToastBehindForegroundWindow(toastWindow) {
    if (process.platform !== 'win32' || !toastWindow || toastWindow.isDestroyed()) return;
    const toastHandle = getNativeWindowHandleNumber(toastWindow);
    if (!/^\d+$/.test(toastHandle)) return;
    const script = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YayaToastLayer {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
'@
$toast = [IntPtr]::new([Int64]::Parse('${toastHandle}'))
$foreground = [YayaToastLayer]::GetForegroundWindow()
if ($foreground -ne [IntPtr]::Zero) {
    [void][YayaToastLayer]::SetWindowPos($toast, $foreground, 0, 0, 0, 0, 0x0053)
}
`;
    await runHiddenPowerShell(script);
}

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
    if (payload.kind === 'private-message') {
        const targetUserId = String(payload.targetUserId || '').trim();
        if (/^\d{1,32}$/.test(targetUserId)) {
            mainWindow.webContents.send('open-private-message-from-notification', {
                targetUserId, memberName: String(payload.memberName || '私信'), iconUrl: String(payload.iconUrl || ''),
                accountGeneration: payload.accountGeneration
            });
        }
        return;
    }
    mainWindow.webContents.send('open-followed-room-from-notification', {
        memberName: String(payload.memberName || title),
        channelId: String(payload.channelId || ''),
        mainChannelId: String(payload.mainChannelId || payload.channelId || ''),
        serverId: String(payload.serverId || ''),
        roomType: payload.roomType === 'small' ? 'small' : 'big'
    });
}

function getDesktopToastMemberKey(payload = {}, title = '') {
    if (payload.kind === 'private-message') return `private:${String(payload.targetUserId || '').trim()}`;
    return String(
        payload.mainChannelId
        || payload.memberId
        || payload.memberName
        || payload.channelId
        || title
    ).trim();
}

function getDesktopToastRenderPayload(title, body, avatarUrl, appIconDataUrl, theme) {
    return JSON.stringify({ title, body, avatarUrl, appIconDataUrl, theme })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');
}

function getDesktopToastDisplay(mainWindow) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            return screen.getDisplayMatching(mainWindow.getBounds());
        }
    } catch (error) { reportIgnoredError(error, 'src/main/services/system-service.js'); }
    return screen.getPrimaryDisplay();
}

function repositionDesktopToasts(mainWindow) {
    if (!screen) return;
    const display = getDesktopToastDisplay(mainWindow);
    const workArea = display.workArea;
    const aliveEntries = activeDesktopToasts.filter(entry => !entry.window.isDestroyed());

    aliveEntries.forEach((entry, index) => {
        const distanceFromBottom = aliveEntries.length - index - 1;
        const x = workArea.x + workArea.width - DESKTOP_TOAST_WIDTH - DESKTOP_TOAST_MARGIN;
        const y = workArea.y + workArea.height - DESKTOP_TOAST_HEIGHT - DESKTOP_TOAST_MARGIN
            - distanceFromBottom * (DESKTOP_TOAST_HEIGHT + DESKTOP_TOAST_GAP);
        entry.window.setBounds({
            x: Math.round(x),
            y: Math.round(y),
            width: DESKTOP_TOAST_WIDTH,
            height: DESKTOP_TOAST_HEIGHT
        }, true);
    });
}

function removeDesktopToast(toastWindow, mainWindow) {
    const index = activeDesktopToasts.findIndex(entry => entry.window === toastWindow);
    if (index >= 0) {
        const [entry] = activeDesktopToasts.splice(index, 1);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
    }
    repositionDesktopToasts(mainWindow);
}

function fadeOutDesktopToast(entry) {
    const toastWindow = entry?.window;
    if (!toastWindow || toastWindow.isDestroyed() || entry.closing) return;
    entry.closing = true;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }

    toastWindow.webContents.executeJavaScript("window.dismissYayaNotification('close')")
        .catch(() => {
            if (!toastWindow.isDestroyed()) toastWindow.close();
        });
    entry.closeTimer = setTimeout(() => {
        if (!toastWindow.isDestroyed()) toastWindow.close();
    }, 360);
}

async function showDesktopToastNotification({ payload = {}, mainWindow, title, body, avatarIcon, appIcon, theme }) {
    if (!BrowserWindow || !screen) {
        return { success: false, msg: '当前系统不支持桌面通知弹窗' };
    }

    const resolvedAppIcon = (appIcon && !appIcon.isEmpty())
        ? appIcon
        : nativeImage.createFromPath(path.join(__dirname, '../../../icon.png'));
    const appIconDataUrl = resolvedAppIcon && !resolvedAppIcon.isEmpty() ? resolvedAppIcon.toDataURL() : '';
    const rawAvatarUrl = String(payload.iconUrl || '').trim();
    const avatarUrl = (avatarIcon && !avatarIcon.isEmpty())
        ? avatarIcon.toDataURL()
        : (/^(?:https?:\/\/|data:image\/)/i.test(rawAvatarUrl) ? rawAvatarUrl : appIconDataUrl);
    const { isForegroundFullscreen } = await getForegroundFullscreenState();
    const memberKey = getDesktopToastMemberKey(payload, title);
    const existingEntry = activeDesktopToasts.find(entry => (
        !entry.closing
        && !entry.window.isDestroyed()
    ));

    if (existingEntry) {
        const existingWindow = existingEntry.window;
        existingEntry.memberKey = memberKey;
        existingEntry.payload = payload;
        existingEntry.title = title;
        if (existingEntry.timer) clearTimeout(existingEntry.timer);
        const renderPayload = getDesktopToastRenderPayload(title, body, avatarUrl, appIconDataUrl, theme);
        try {
            await existingWindow.webContents.executeJavaScript(`window.renderYayaNotification(${renderPayload})`);
            existingWindow.setAlwaysOnTop(!isForegroundFullscreen, isForegroundFullscreen ? 'normal' : 'pop-up-menu');
            if (isForegroundFullscreen) {
                await placeToastBehindForegroundWindow(existingWindow);
            } else {
                existingWindow.showInactive();
            }
            existingEntry.timer = setTimeout(() => {
                fadeOutDesktopToast(existingEntry);
            }, DESKTOP_TOAST_DURATION_MS);
            return { success: true, merged: true };
        } catch (error) {
            console.warn('[系统通知] 更新已有弹窗失败:', error.message);
            if (!existingWindow.isDestroyed()) existingWindow.close();
        }
    }

    const display = getDesktopToastDisplay(mainWindow);
    const workArea = display.workArea;
    const toastWindow = new BrowserWindow({
        x: Math.round(workArea.x + workArea.width - DESKTOP_TOAST_WIDTH - DESKTOP_TOAST_MARGIN),
        y: Math.round(workArea.y + workArea.height - DESKTOP_TOAST_HEIGHT - DESKTOP_TOAST_MARGIN),
        width: DESKTOP_TOAST_WIDTH,
        height: DESKTOP_TOAST_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: !isForegroundFullscreen,
        focusable: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    if (!isForegroundFullscreen) {
        toastWindow.setAlwaysOnTop(true, 'pop-up-menu');
    }
    toastWindow.setMenuBarVisibility(false);
    const entry = {
        window: toastWindow,
        timer: null,
        closeTimer: null,
        closing: false,
        memberKey,
        payload,
        title
    };
    activeDesktopToasts.push(entry);
    while (activeDesktopToasts.length > DESKTOP_TOAST_MAX_VISIBLE) {
        const oldest = activeDesktopToasts.shift();
        fadeOutDesktopToast(oldest);
    }
    repositionDesktopToasts(mainWindow);

    toastWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('yaya-notification://')) return;
        event.preventDefault();
        if (url.startsWith('yaya-notification://open')) {
            openNotificationTarget(entry.payload, entry.title, mainWindow);
        }
        if (!toastWindow.isDestroyed()) toastWindow.close();
    });
    toastWindow.on('closed', () => removeDesktopToast(toastWindow, mainWindow));
    try {
        await toastWindow.loadFile(path.join(__dirname, '../notification-toast.html'));
        if (toastWindow.isDestroyed()) {
            return { success: false, msg: '软件通知弹窗已关闭' };
        }

        const renderPayload = getDesktopToastRenderPayload(title, body, avatarUrl, appIconDataUrl, theme);
        await toastWindow.webContents.executeJavaScript(`window.renderYayaNotification(${renderPayload})`);
        if (isForegroundFullscreen) {
            await placeToastBehindForegroundWindow(toastWindow);
        } else {
            toastWindow.showInactive();
        }
        entry.timer = setTimeout(() => {
            fadeOutDesktopToast(entry);
        }, DESKTOP_TOAST_DURATION_MS);
        return { success: true };
    } catch (error) {
        console.warn('[系统通知] 弹窗加载失败:', error.message);
        if (!toastWindow.isDestroyed()) toastWindow.close();
        return { success: false, msg: '软件通知弹窗加载失败' };
    }
}

function canAttemptNativeNotification() {
    if (!ElectronNotification || (typeof ElectronNotification.isSupported === 'function' && !ElectronNotification.isSupported())) {
        return false;
    }
    if (nativeNotificationUnavailable) return false;
    return Date.now() >= nativeNotificationRetryAfter;
}

function markNativeNotificationFailed() {
    nativeNotificationFailureCount += 1;
    if (nativeNotificationFailureCount >= 2) {
        nativeNotificationUnavailable = true;
    } else {
        nativeNotificationRetryAfter = Date.now() + 15_000;
    }
    if (!nativeNotificationFallbackLogged) {
        nativeNotificationFallbackLogged = true;
        console.info('[系统通知] 原生通知未获系统授权或不可用，已自动切换为桌面悬浮通知');
    }
}

function tryShowNativeNotification({ payload, mainWindow, title, body, avatarIcon, appIcon, theme }) {
    if (!canAttemptNativeNotification()) {
        return Promise.resolve(null);
    }

    if (process.platform === 'win32') {
        ensureWindowsNotificationRegistration();
    }

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

        return new Promise((resolve) => {
            let settled = false;
            let fallbackTriggered = false;
            const settleTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve({ success: true, native: true });
            }, 220);

            notification.once('show', () => {
                clearTimeout(settleTimer);
                nativeNotificationFailureCount = 0;
                nativeNotificationRetryAfter = 0;
                if (!settled) {
                    settled = true;
                    resolve({ success: true, native: true });
                }
            });

            notification.once('click', () => {
                activeNativeNotifications.delete(notification);
                openNotificationTarget(payload, title, mainWindow);
            });

            notification.once('close', () => {
                activeNativeNotifications.delete(notification);
            });

            notification.once('failed', () => {
                clearTimeout(settleTimer);
                activeNativeNotifications.delete(notification);
                markNativeNotificationFailed();
                if (!settled) {
                    settled = true;
                    fallbackTriggered = true;
                    resolve(null);
                    return;
                }
                if (!fallbackTriggered) {
                    fallbackTriggered = true;
                    void showDesktopToastNotification({
                        payload,
                        mainWindow,
                        title,
                        body,
                        avatarIcon,
                        appIcon,
                        theme
                    });
                }
            });

            notification.show();
        });
    } catch (error) {
        markNativeNotificationFailed();
        return Promise.resolve(null);
    }
}

async function showSystemNotification(payload = {}, mainWindow) {
    const title = truncateNotificationText(payload.title || '牙牙消息', 80);
    const body = truncateNotificationText(payload.body || '收到一条新消息', 220);
    const theme = payload.theme === 'dark' ? 'dark' : 'light';
    const avatarIcon = await resolveNotificationAvatarIcon(payload.iconUrl);
    const appIcon = getAppNotificationIcon();

    const nativeResult = await tryShowNativeNotification({
        payload,
        mainWindow,
        title,
        body,
        avatarIcon,
        appIcon,
        theme
    });
    if (nativeResult) {
        return nativeResult;
    }

    return showDesktopToastNotification({
        payload,
        mainWindow,
        title,
        body,
        avatarIcon,
        appIcon,
        theme
    });
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
    return String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .trim().replace(/[. ]+$/, '') || fallback;
}

const MEDIA_DOWNLOAD_BYTE_LIMIT = 16 * 1024 * 1024;
const MEDIA_DOWNLOAD_CHUNK_LIMIT = 1024 * 1024;
const MEDIA_DOWNLOAD_STREAM_LIMIT = 512 * 1024 * 1024;
const MEDIA_DOWNLOAD_IDLE_MS = 60_000;
const mediaDownloadSessions = new Map();

async function resolveMediaDownload({ filename, dlType, subFolder }) {
    if (!['media', 'flip'].includes(dlType)) throw new Error('下载类型无效');
    const fileName = safeFileName(filename, '');
    const extension = path.extname(fileName);
    if (!/^\.(?:png|jpe?g|gif|webp|bmp|avif|mp3|mp4|m4a|aac|wav|webm|mov)$/i.test(extension)) {
        throw new Error('不支持保存此文件类型');
    }
    const configuredDir = getSettingValue(`yaya_path_${dlType}`).value;
    if (typeof configuredDir !== 'string' || !path.isAbsolute(configuredDir)) {
        throw new Error('请在设置中选择有效的下载目录');
    }

    await fs.promises.mkdir(configuredDir, { recursive: true });
    const root = await fs.promises.realpath(configuredDir);
    const dir = path.join(root, safeFileName(subFolder, ''));
    if (dir !== root) {
        await fs.promises.mkdir(dir).catch(error => {
            if (error.code !== 'EEXIST') throw error;
        });
        if (!(await fs.promises.lstat(dir)).isDirectory()) throw new Error('下载子目录无效');
    }

    return { dir, fileName, extension, base: path.basename(fileName, extension) };
}

async function saveToAvailableMediaPath({ dir, fileName, extension, base }, write) {
    for (let suffix = 0; ; suffix += 1) {
        const destination = path.join(dir, suffix ? `${base}_${suffix}${extension}` : fileName);
        try {
            await write(destination);
            return { success: true };
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
}

async function saveMediaDownload({ bytes, ...metadata } = {}) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('下载文件数据无效');
    if (bytes.length > MEDIA_DOWNLOAD_BYTE_LIMIT) throw new Error('文件超过单次保存上限，请使用分段下载');
    const target = await resolveMediaDownload(metadata);
    return saveToAvailableMediaPath(target, async destination => {
        const file = await fs.promises.open(destination, 'wx');
        try {
            try { await file.writeFile(bytes); }
            finally { await file.close(); }
        } catch (error) {
            await fs.promises.rm(destination, { force: true });
            throw error;
        }
    });
}

function disposeMediaDownload(download) {
    mediaDownloadSessions.delete(download.id);
    clearTimeout(download.timer);
    download.owner.removeListener('destroyed', download.cancel);
    download.owner.removeListener('render-process-gone', download.cancel);
}

async function removePartialMedia(download) {
    try { await download.file.close(); }
    finally { await fs.promises.rm(download.partial, { force: true }); }
}

function refreshMediaDownloadTimeout(download) {
    clearTimeout(download.timer);
    download.timer = setTimeout(download.cancel, MEDIA_DOWNLOAD_IDLE_MS);
    download.timer.unref();
}

async function beginMediaDownload(owner, { contentLength, ...metadata } = {}) {
    if (Number(contentLength) > MEDIA_DOWNLOAD_STREAM_LIMIT) throw new Error('下载文件超过 512 MiB');
    const target = await resolveMediaDownload(metadata);
    const id = crypto.randomUUID();
    const partial = path.join(target.dir, `.yaya-${id}.part`);
    const download = { id, owner, target, partial, size: 0, busy: false };
    download.file = await fs.promises.open(partial, 'wx');
    if (owner.isDestroyed()) {
        await removePartialMedia(download);
        throw new Error('下载窗口已关闭');
    }
    download.cancel = () => {
        abortMediaDownload(owner, { id }).catch(error => reportIgnoredError(error, 'media-download-cleanup'));
    };
    mediaDownloadSessions.set(id, download);
    owner.once('destroyed', download.cancel);
    owner.once('render-process-gone', download.cancel);
    refreshMediaDownloadTimeout(download);
    return { id };
}

function findMediaDownload(owner, id) {
    const download = mediaDownloadSessions.get(id);
    if (!download || download.owner !== owner || download.busy) throw new Error('下载会话无效或正在写入');
    return download;
}

async function appendMediaDownload(owner, { id, bytes } = {}) {
    const download = findMediaDownload(owner, id);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MEDIA_DOWNLOAD_CHUNK_LIMIT) {
        throw new Error('下载分段数据无效');
    }
    if (download.size + bytes.length > MEDIA_DOWNLOAD_STREAM_LIMIT) {
        await abortMediaDownload(owner, { id });
        throw new Error('下载文件超过 512 MiB');
    }
    download.busy = true;
    refreshMediaDownloadTimeout(download);
    try {
        await download.file.writeFile(bytes);
        download.size += bytes.length;
    } catch (error) {
        await abortMediaDownload(owner, { id });
        throw error;
    } finally {
        download.busy = false;
    }
}

async function finishMediaDownload(owner, { id } = {}) {
    const download = findMediaDownload(owner, id);
    disposeMediaDownload(download);
    try {
        if (!download.size) throw new Error('下载文件为空');
        await download.file.close();
        return await saveToAvailableMediaPath(download.target, async destination => {
            try {
                await fs.promises.link(download.partial, destination);
            } catch (error) {
                if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
                await fs.promises.copyFile(download.partial, destination, fs.constants.COPYFILE_EXCL);
            }
        });
    } finally {
        await removePartialMedia(download);
    }
}

async function abortMediaDownload(owner, { id } = {}) {
    const download = mediaDownloadSessions.get(id);
    if (!download || download.owner !== owner) return;
    disposeMediaDownload(download);
    await removePartialMedia(download);
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
    saveMediaDownload,
    beginMediaDownload,
    appendMediaDownload,
    finishMediaDownload,
    abortMediaDownload,
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
