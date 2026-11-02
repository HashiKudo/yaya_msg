const { app, ipcMain } = require('electron');
const systemService = require('../services/system-service');
const settingsService = require('../services/settings-service');
const { getMainWindow } = require('../window');
const appIconService = require('../services/app-icon-service');
const { updateTrayIcon } = require('../tray');

function registerSystemIpc() {
    ipcMain.on('settings-sync', (event, payload) => {
        try {
            event.returnValue = {
                success: true,
                data: settingsService.handleSyncRequest(payload)
            };
        } catch (error) {
            event.returnValue = {
                success: false,
                msg: error.message
            };
        }
    });
    ipcMain.handle('get-app-icon', () => appIconService.getAppIconInfo());
    ipcMain.handle('choose-app-icon', async () => {
        const result = await appIconService.chooseAppIcon(getMainWindow());
        if (result.success && !result.canceled) {
            updateTrayIcon();
            systemService.ensureWindowsNotificationRegistration();
        }
        return result;
    });
    ipcMain.handle('reset-app-icon', () => {
        const result = appIconService.resetAppIcon();
        if (result.success) {
            updateTrayIcon();
            systemService.ensureWindowsNotificationRegistration();
        }
        return result;
    });
    ipcMain.handle('save-export-jsonl', (event, payload) => systemService.saveExportJsonl(payload));
    ipcMain.handle('dialog-open-directory', () => systemService.openDirectoryDialog(getMainWindow()));
    ipcMain.handle('get-default-download-path', () => app.getPath('downloads'));
    ipcMain.handle('open-message-data-folder', () => systemService.openMessageDataFolder());
    ipcMain.handle('fetch-remote-image-data-url', (event, payload) => systemService.fetchRemoteImageDataUrl(payload));
    ipcMain.handle('cache-image-thumbnail', (event, payload) => systemService.createCachedImageThumbnail(payload));
    ipcMain.handle('show-system-notification', (event, payload) => systemService.showSystemNotification(payload, getMainWindow()));
    ipcMain.handle('check-ip-info', () => systemService.checkIpInfo());
    ipcMain.handle('check-ip-domestic', () => systemService.checkIpDomestic());
    ipcMain.handle('check-ip-foreign', () => systemService.checkIpForeign());
    ipcMain.handle('check-ip-google', () => systemService.checkIpGoogle());
    ipcMain.handle('open-external-player', (event, payload) => systemService.openExternalPlayer(payload));
}

module.exports = {
    registerSystemIpc
};
