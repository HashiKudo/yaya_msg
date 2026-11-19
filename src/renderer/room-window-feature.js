(function () {
    'use strict';
    if (!window.desktop || window.desktop.platform === 'web') return;
    const ipc = window.desktop.ipcRenderer;

    window.openFollowedRoomWindow = async function (room, options = {}) {
        const active = window.getActiveFollowedRoomWindowContext?.();
        const sameRoom = active && String(active.mainChannelId) === String(room.mainChannelId || room.channelId)
            && String(active.serverId) === String(room.serverId);
        const context = sameRoom ? {
            ...room, ...active,
            smallChannelId: active.smallChannelId || room.smallChannelId,
            memberId: active.memberId || room.memberId,
            avatarUrl: active.avatarUrl || room.avatarUrl,
            compact: room.compact === true || options.compact === true
        } : { ...room, compact: room.compact === true || options.compact === true };
        if (options.fromDrag) context.dragOutsideHalf = options.detachEligible === true;
        try {
            const result = await ipc.invoke(options.fromDrag ? 'open-room-window-from-drag' : 'open-room-window', context);
            if (!result?.success) {
                if (!result?.cancelled) window.showToast?.(result?.msg || '独立窗口打开失败，请重试');
            }
            return result;
        } catch (_) {
            window.showToast?.('独立窗口打开失败，请重试');
            return { success: false };
        }
    };

    window.installDetachedWindowPinButton = function installDetachedWindowPinButton() {
        const customTitleBar = document.querySelector('.custom-title-bar');
        if (!customTitleBar || document.getElementById('btn-popup-pin')) return null;
        const pinContainer = document.createElement('div');
        pinContainer.className = 'room-popup-top-actions';
        pinContainer.innerHTML = `
            <button id="btn-popup-pin" class="popup-top-btn" type="button" title="窗口置顶" aria-label="窗口置顶" aria-pressed="false">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="12" y1="17" x2="12" y2="22"></line>
                    <path d="M5 17h14v-2l-3-3V5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7l-3 3v2z"></path>
                </svg>
                <span class="popup-pin-text">置顶</span>
            </button>
        `;
        const windowControls = customTitleBar.querySelector('.window-controls');
        if (windowControls) customTitleBar.insertBefore(pinContainer, windowControls);
        else customTitleBar.appendChild(pinContainer);

        const pinBtn = document.getElementById('btn-popup-pin');
        const applyPinState = isPinned => {
            const pinned = Boolean(isPinned);
            pinBtn.classList.toggle('is-pinned', pinned);
            pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
            pinBtn.title = pinned ? '取消置顶' : '窗口置顶';
            pinBtn.setAttribute('aria-label', pinBtn.title);
        };
        if (pinBtn) {
            pinBtn.addEventListener('click', async event => {
                event.stopPropagation();
                try {
                    const isPinned = await ipc.invoke('toggle-window-always-on-top');
                    applyPinState(isPinned);
                } catch (err) {
                    console.warn('[room-window] 置顶切换失败:', err);
                }
            });
            ipc.invoke('is-window-always-on-top').then(applyPinState).catch(() => {});
        }
        return pinBtn;
    };

    if (!window.desktop.isRoomWindow || window.desktop.isLiveWindow) return;

    async function startRoomWindow() {
        const root = document.documentElement;
        const body = document.body;
        root.dataset.roomWindow = 'true';
        body.classList.add('room-window');
        body.dataset.desktopView = 'followed-rooms';
        document.querySelectorAll('#mainContentArea > [id^="view-"]').forEach(page => {
            page.classList.add('desktop-page');
            page.style.display = page.id === 'view-followed-rooms' ? 'block' : 'none';
        });
        document.getElementById('view-followed-rooms').classList.add('desktop-conversations', 'is-chat-open');

        const title = document.querySelector('.title-info > span');
        if (title) title.textContent = '牙牙消息 · 房间';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'room-window-back';
        back.textContent = '‹ 返回房间';
        back.hidden = true;
        back.addEventListener('click', () => window.switchView('followed-rooms'));
        document.querySelector('.custom-title-bar').appendChild(back);
        window.installDetachedWindowPinButton?.();
        window.addEventListener('yaya:view-changed', event => {
            const view = event.detail?.view || 'followed-rooms';
            body.dataset.desktopView = view;
            back.hidden = view === 'followed-rooms';
            syncTitle();
        });
        const heading = document.getElementById('followed-chat-title');
        const syncTitle = () => {
            const view = body.dataset.desktopView || 'followed-rooms';
            const isRoom = view === 'followed-rooms';
            const pageTitle = view === 'send-flip' ? '提问'
                : view === 'flip' ? '历史'
                : ['room-album', 'photos'].includes(view) ? '相册'
                : document.getElementById('topbar-page-title')?.textContent.trim() || '详情';
            const label = `牙牙消息 · ${isRoom ? '房间' : pageTitle}`;
            if (title) title.textContent = label;
            const name = heading.textContent.trim();
            document.title = isRoom && name ? `${name} · 牙牙消息` : label;
        };
        new MutationObserver(syncTitle).observe(heading, { childList: true, subtree: true, characterData: true });

        try {
            const context = await ipc.invoke('get-room-window-context');
            if (!context?.channelId || !context.serverId) throw new Error('房间信息已失效，请关闭窗口后重新打开');
            if (!window.getAppToken?.()) throw new Error('请先在主窗口登录，然后重新打开房间');
            if (context.compact === true) root.dataset.roomPopup = 'true';
            window.switchView('followed-rooms');
            window.openFollowedChat(context.ownerName, context.channelId, context.serverId, context);
            void Promise.resolve(window.loadMemberData?.()).catch(() => {});
            syncTitle();
            window.__appStartupComplete = true;
            window.dispatchEvent(new CustomEvent('yaya:app-startup-complete'));
        } catch (error) {
            const box = document.getElementById('followed-chat-messages');
            box.textContent = error.message || '房间打开失败，请关闭窗口后重试';
            box.classList.add('room-window-error');
        } finally {
            root.classList.remove('desktop-workspace-pending');
            ipc.send('desktop-workspace-ready');
        }
    }

    void startRoomWindow();
})();
