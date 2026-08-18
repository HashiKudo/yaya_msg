const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayMenu', {
    action(action) {
        ipcRenderer.send('tray-menu-action', action);
    },
    onTheme(callback) {
        if (typeof callback !== 'function') return;
        ipcRenderer.on('tray-menu-theme', (_event, theme) => callback(theme));
    }
});
