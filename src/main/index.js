const { app, globalShortcut } = require('electron');
const {
    createWindow,
    getMainWindow,
    showMainWindow,
    markAppQuitting
} = require('./window');
const { createTray, destroyTray } = require('./tray');
const { ensureWasmLoaded } = require('./services/wasm-service');
const {
    cleanupMediaTasks,
    finalizeLiveRecordingsBeforeQuit,
    recoverInterruptedLiveRecordings
} = require('./services/media-service');
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

const MEDIA_KEY_SHORTCUTS = [
    ['MediaPlayPause', 'play-pause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous']
];
let quitCleanupStarted = false;
let quitCleanupFinished = false;
let finalCleanupPerformed = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function runLiveRecordingRecovery() {
    return recoverInterruptedLiveRecordings()
        .then((result) => {
            if (!result || (!result.recovered && !result.preserved && !result.failed)) return;
            console.log('[live-record-recovery]', result);
            const window = getMainWindow();
            if (window && !window.isDestroyed()) {
                window.webContents.send('live-recording-recovery', result);
            }
        })
        .catch(error => console.warn('[live-record-recovery] failed:', error));
}

function performFinalCleanup() {
    if (finalCleanupPerformed) return;
    finalCleanupPerformed = true;
    markAppQuitting();
    destroyTray();
    cleanupMediaTasks();
    closeMessageIndex();
}

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

if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', showMainWindow);
    app.whenReady().then(() => {
        ensureStoragePaths();
        createWindow();
        createTray();
        startMessageIndexWatcher((result) => {
            const window = getMainWindow();
            if (!window || window.isDestroyed()) return;
            window.webContents.send('message-index-updated', result);
        });
        registerMediaKeyShortcuts();
        ensureWasmLoaded();
        runLiveRecordingRecovery();
        setTimeout(runLiveRecordingRecovery, 20_000);
    });
}

app.on('activate', () => {
    showMainWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    showMainWindow();
});

app.on('before-quit', (event) => {
    if (!gotSingleInstanceLock) return;

    markAppQuitting();
    if (quitCleanupFinished) {
        performFinalCleanup();
        return;
    }

    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;

    finalizeLiveRecordingsBeforeQuit()
        .catch(error => console.warn('[app-quit] live recording finalize failed:', error))
        .finally(() => {
            quitCleanupFinished = true;
            performFinalCleanup();
            app.quit();
        });
});

app.on('will-quit', () => {
    MEDIA_KEY_SHORTCUTS.forEach(([accelerator]) => {
        globalShortcut.unregister(accelerator);
    });
});
