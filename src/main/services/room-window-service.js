'use strict';

const { BrowserWindow, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { reportIgnoredError } = require('../../common/error-utils');
const { getAppIconPath } = require('./app-icon-service');

const roomWindows = new Map();
const preloadPath = path.join(__dirname, '../preload.js');
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const PAGE_ZOOM_FACTOR = 1;

function resetPageZoom(webContents) {
    if (!webContents || webContents.isDestroyed()) return;
    try {
        webContents.setZoomLevel(0);
        webContents.setZoomFactor(PAGE_ZOOM_FACTOR);
    } catch (error) {
        reportIgnoredError(error, 'room-window-service.resetPageZoom');
    }
}

function isSafeExternalUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol);
    } catch {
        return false;
    }
}

function openRoomWindow(payload = {}) {
    const channelId = String(payload.channelId || '').trim();
    if (!channelId) {
        throw new Error('缺少有效的房间频道 ID');
    }

    const existingWin = roomWindows.get(channelId);
    if (existingWin && !existingWin.isDestroyed()) {
        if (existingWin.isMinimized()) existingWin.restore();
        existingWin.show();
        existingWin.focus();
        return { success: true, alreadyOpen: true };
    }

    const isMac = process.platform === 'darwin';
    const ownerName = String(payload.ownerName || '成员房间').trim();

    const win = new BrowserWindow({
        width: 440,
        height: 720,
        minWidth: 320,
        minHeight: 460,
        frame: isMac,
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        trafficLightPosition: isMac ? { x: 14, y: 10 } : undefined,
        icon: getAppIconPath(),
        title: `${ownerName} - 牙牙消息`,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            webSecurity: false,
            backgroundThrottling: false
        }
    });

    roomWindows.set(channelId, win);

    const queryParams = new URLSearchParams({
        windowType: 'room-popup',
        channelId,
        serverId: String(payload.serverId || '').trim(),
        ownerName,
        memberId: String(payload.memberId || '').trim(),
        roomType: String(payload.roomType || 'big').trim()
    });

    const indexHtmlPath = path.join(__dirname, '../../../index.html');
    const targetUrl = `${pathToFileURL(indexHtmlPath).href}?${queryParams.toString()}`;

    win.loadURL(targetUrl);
    resetPageZoom(win.webContents);

    win.webContents.on('did-finish-load', () => {
        resetPageZoom(win.webContents);
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file://')) {
            event.preventDefault();
        }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    win.on('closed', () => {
        roomWindows.delete(channelId);
    });

    return { success: true, alreadyOpen: false };
}

function toggleWindowAlwaysOnTop(sender) {
    if (!sender) return false;
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return false;
    const nextState = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(nextState);
    return nextState;
}

function isWindowAlwaysOnTop(sender) {
    if (!sender) return false;
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed()) return false;
    return win.isAlwaysOnTop();
}

function closeAllRoomWindows() {
    for (const win of roomWindows.values()) {
        try {
            if (win && !win.isDestroyed()) {
                win.close();
            }
        } catch (error) {
            reportIgnoredError(error, 'room-window-service.closeAllRoomWindows');
        }
    }
    roomWindows.clear();
}

function getOpenRoomCount() {
    return roomWindows.size;
}

module.exports = {
    openRoomWindow,
    toggleWindowAlwaysOnTop,
    isWindowAlwaysOnTop,
    closeAllRoomWindows,
    getOpenRoomCount
};
