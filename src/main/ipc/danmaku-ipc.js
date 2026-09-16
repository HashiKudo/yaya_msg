'use strict';

const { ipcMain } = require('electron');
const danmakuService = require('../services/danmaku-service');

function registerDanmakuIpc() {
    ipcMain.handle('connect-live-danmaku', (event, payload) => (
        danmakuService.connectLiveDanmaku(event.sender, payload)
    ));
    ipcMain.handle('disconnect-live-danmaku', (event, payload = {}) => ({
        success: true,
        disconnected: danmakuService.disconnectLiveDanmaku(event.sender.id, payload.connectionId)
    }));
    ipcMain.handle('send-live-danmaku', (event, payload) => (
        danmakuService.sendLiveDanmaku(event.sender.id, payload)
    ));
    ipcMain.handle('send-live-gift-event', (event, payload) => (
        danmakuService.sendLiveGiftEvent(event.sender.id, payload)
    ));
}

module.exports = {
    registerDanmakuIpc
};
