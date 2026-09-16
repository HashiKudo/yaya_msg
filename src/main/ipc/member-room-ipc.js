'use strict';

const { ipcMain } = require('electron');
const memberRoomService = require('../services/member-room-service');

function registerMemberRoomIpc() {
    ipcMain.handle('connect-member-room', (event, payload) => (
        memberRoomService.connectMemberRoom(event.sender, payload)
    ));
    ipcMain.handle('disconnect-member-room', (event, payload = {}) => ({
        success: true,
        disconnected: memberRoomService.disconnectMemberRoom(event.sender.id, payload.connectionId)
    }));
    ipcMain.handle('send-member-room-message', (event, payload) => (
        memberRoomService.sendMemberRoomMessage(event.sender.id, payload)
    ));
    ipcMain.handle('delete-member-room-message', (event, payload) => (
        memberRoomService.deleteMemberRoomMessage(event.sender.id, payload)
    ));
}

module.exports = {
    registerMemberRoomIpc
};
