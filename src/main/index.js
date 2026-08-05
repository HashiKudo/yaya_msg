const { app, globalShortcut } = require('electron');
const { createWindow } = require('./window');
const { getMainWindow } = require('./window');
const { ensureWasmLoaded } = require('./services/wasm-service');
const { cleanupMediaTasks } = require('./services/media-service');
const { registerWindowIpc } = require('./ipc/window-ipc');
const { registerMediaIpc } = require('./ipc/media-ipc');
const { registerBilibiliIpc } = require('./ipc/bilibili-ipc');
const { registerPocketIpc } = require('./ipc/pocket-ipc');
const { registerSystemIpc } = require('./ipc/system-ipc');
const { registerMessageIndexIpc } = require('./ipc/message-index-ipc');
const { closeMessageIndex, startMessageIndexWatcher } = require('./services/message-index-service');
const { ensureStoragePaths } = require('../common/storage-paths');

registerWindowIpc();
registerMediaIpc();
registerBilibiliIpc();
registerPocketIpc();
registerSystemIpc();
registerMessageIndexIpc();

let isQuitting = false;

const MEDIA_KEY_SHORTCUTS = [
    ['MediaPlayPause', 'play-pause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous']
];

function sendMediaKeyAction(action) {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send('system-media-key', action);
}

function registerMediaKeyShortcuts() {
    MEDIA_KEY_SHORTCUTS.forEach(([accelerator, action]) => {
        try {
            globalShortcut.register(accelerator, () => sendMediaKeyAction(action));
        } catch (error) {
            console.warn(`[media-key] register failed: ${accelerator}`, error);
        }
    });
}

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-setuid-sandbox');
}

if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.yaya.message' : 'electron.app.Electron');
}

app.whenReady().then(() => {
    ensureStoragePaths();
    createWindow();
    startMessageIndexWatcher((result) => {
        const window = getMainWindow();
        if (!window || window.isDestroyed()) return;
        window.webContents.send('message-index-updated', result);
    });
    registerMediaKeyShortcuts();
    ensureWasmLoaded();
});

app.on('activate', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
        createWindow();
    } else {
        win.show();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    app.isQuitting = true;
    cleanupMediaTasks();
    closeMessageIndex();
});

app.on('will-quit', () => {
    MEDIA_KEY_SHORTCUTS.forEach(([accelerator]) => {
        globalShortcut.unregister(accelerator);
    });
});
