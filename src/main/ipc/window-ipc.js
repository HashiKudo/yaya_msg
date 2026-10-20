const { ipcMain, BrowserWindow } = require('electron');
const { getMainWindow, requestWindowClose } = require('../window');
const roomWindowService = require('../services/room-window-service');

function registerWindowIpc() {
    ipcMain.on('window-min', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
        if (win && !win.isDestroyed()) {
            win.minimize();
        }
    });

    ipcMain.on('window-max', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
        if (!win || win.isDestroyed()) {
            return;
        }

        if (win.isMaximized()) {
            win.unmaximize();
            return;
        }

        win.maximize();
    });

    ipcMain.on('window-close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return;
        if (win === getMainWindow()) {
            requestWindowClose();
        } else {
            win.close();
        }
    });

    ipcMain.handle('open-room-window', (_event, payload) => {
        return roomWindowService.openRoomWindow(payload);
    });

    ipcMain.handle('toggle-window-always-on-top', (event) => {
        return roomWindowService.toggleWindowAlwaysOnTop(event.sender);
    });

    ipcMain.handle('is-window-always-on-top', (event) => {
        return roomWindowService.isWindowAlwaysOnTop(event.sender);
    });
}

module.exports = {
    registerWindowIpc
};
