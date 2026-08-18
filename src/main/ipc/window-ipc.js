const { ipcMain } = require('electron');
const { getMainWindow, requestWindowClose } = require('../window');

function registerWindowIpc() {
    ipcMain.on('window-min', () => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.minimize();
        }
    });

    ipcMain.on('window-max', () => {
        const mainWindow = getMainWindow();
        if (!mainWindow) {
            return;
        }

        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
            return;
        }

        mainWindow.maximize();
    });

    ipcMain.on('window-close', () => {
        requestWindowClose();
    });
}

module.exports = {
    registerWindowIpc
};
