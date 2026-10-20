(function () {
    const urlParams = new URLSearchParams(window.location.search);
    const windowType = urlParams.get('windowType');
    const isRoomPopup = windowType === 'room-popup';

    if (!isRoomPopup) return;

    window.__isRoomPopupWindow = true;
    document.documentElement.classList.add('is-room-popup-window');

    const channelId = String(urlParams.get('channelId') || '').trim();
    const serverId = String(urlParams.get('serverId') || '').trim();
    const ownerName = String(urlParams.get('ownerName') || '成员房间').trim();
    const memberId = String(urlParams.get('memberId') || '').trim();
    const roomType = String(urlParams.get('roomType') || 'big').trim();

    document.title = `${ownerName} - 牙牙消息`;

    function escapeHtmlSafe(value) {
        if (window.YayaRendererUtils && typeof window.YayaRendererUtils.escapeHtml === 'function') {
            return window.YayaRendererUtils.escapeHtml(value);
        }
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setupPopupTitleBar() {
        const titleInfo = document.querySelector('.custom-title-bar .title-info');
        if (titleInfo) {
            titleInfo.innerHTML = `
                <div class="popup-title-badge">
                    <span class="popup-title-name">${escapeHtmlSafe(ownerName)}</span>
                    <span class="popup-title-tag">独立窗口</span>
                </div>
            `;
        }

        const customTitleBar = document.querySelector('.custom-title-bar');
        if (customTitleBar && !document.getElementById('btn-popup-pin')) {
            const pinContainer = document.createElement('div');
            pinContainer.className = 'room-popup-top-actions';
            pinContainer.innerHTML = `
                <button id="btn-popup-pin" class="popup-top-btn" type="button" title="窗口置顶" aria-label="窗口置顶" aria-pressed="false">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="17" x2="12" y2="22"></line>
                        <path d="M5 17h14v-2l-3-3V5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7l-3 3v2z"></path>
                    </svg>
                    <span class="popup-pin-text">置顶</span>
                </button>
            `;

            const windowControls = customTitleBar.querySelector('.window-controls');
            if (windowControls) {
                customTitleBar.insertBefore(pinContainer, windowControls);
            } else {
                customTitleBar.appendChild(pinContainer);
            }

            const pinBtn = document.getElementById('btn-popup-pin');
            if (pinBtn && window.desktop && window.desktop.ipcRenderer) {
                pinBtn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    try {
                        const isPinned = await window.desktop.ipcRenderer.invoke('toggle-window-always-on-top');
                        pinBtn.classList.toggle('is-pinned', Boolean(isPinned));
                        pinBtn.setAttribute('aria-pressed', Boolean(isPinned) ? 'true' : 'false');
                        pinBtn.title = isPinned ? '取消置顶' : '窗口置顶';
                    } catch (err) {
                        console.warn('[room-popup] 置顶切换失败:', err);
                    }
                });

                window.desktop.ipcRenderer.invoke('is-window-always-on-top').then((isPinned) => {
                    pinBtn.classList.toggle('is-pinned', Boolean(isPinned));
                    pinBtn.setAttribute('aria-pressed', Boolean(isPinned) ? 'true' : 'false');
                    pinBtn.title = isPinned ? '取消置顶' : '窗口置顶';
                }).catch(() => {});
            }
        }
    }

    function initPopupRoom() {
        if (typeof window.switchView === 'function') {
            window.switchView('followed-rooms');
        }

        let attempts = 0;
        const maxAttempts = 100;
        const timer = setInterval(() => {
            attempts++;
            if (typeof window.openFollowedChat === 'function') {
                clearInterval(timer);
                window.openFollowedChat(ownerName, channelId, serverId, {
                    roomType,
                    memberId
                });
            } else if (attempts >= maxAttempts) {
                clearInterval(timer);
                console.error('[room-popup] 打开房间聊天超时');
            }
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setupPopupTitleBar();
            initPopupRoom();
        }, { once: true });
    } else {
        setupPopupTitleBar();
        initPopupRoom();
    }
})();
