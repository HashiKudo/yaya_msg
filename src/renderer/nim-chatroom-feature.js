(function () {
    window.YayaRendererFeatures = window.YayaRendererFeatures || {};

    window.YayaRendererFeatures.createNimChatroomFeature = function createNimChatroomFeature(deps) {
        const {
            getNimAuth,
            getNimInstance,
            setNimInstance,
            showToast
        } = deps;

        const NIM_CHATROOM_SDK_URL = './src/renderer/vendor/NIM_Web_Chatroom.js';
        const CHATROOM_ADDRESSES = ['chatweblink01.netease.im:443'];
        const CHATROOM_APP_KEY = '632feff1f4c838541ab75195d1ceb3fa';
        const LIVE_DANMU_ENABLED = false;
        const BARRAGE_TYPES = new Set([
            'BARRAGE_NORMAL',
            'BARRAGE_MEMBER',
            'BARRAGE_PAY',
            'BARRAGE_SUPERMAN'
        ]);
        const GIFT_TYPES = new Set([
            'PRESENT_NORMAL',
            'PRESENT_FULLSCREEN',
            'PRESENT_FULLSCREEN_TWO'
        ]);
        const DANMU_COLORS = {
            BARRAGE_MEMBER: '#ff9ac5',
            BARRAGE_PAY: '#ffd166',
            BARRAGE_SUPERMAN: '#6ee7ff',
            gift: '#ffb86c',
            system: '#c4b5fd',
            normal: '#ffffff'
        };

        let nimSdkLoadPromise = null;
        let sessionSequence = 0;
        let laneSequence = 0;

        function reportIgnoredError(error) {
            if (window.YayaRendererUtils?.reportIgnoredError) {
                window.YayaRendererUtils.reportIgnoredError(error, 'src/renderer/nim-chatroom-feature.js');
            }
        }

        function normalizeNimChatroomGlobal() {
            if (window.NIM && window.NIM.Chatroom) return window.NIM;
            if (window.SDK && window.SDK.Chatroom) {
                window.NIM = window.SDK;
                return window.NIM;
            }
            if (window.Chatroom) {
                window.NIM = window.NIM || {};
                window.NIM.Chatroom = window.Chatroom;
                return window.NIM;
            }
            return null;
        }

        function loadNimChatroomScript(src) {
            return new Promise((resolve, reject) => {
                const existing = document.querySelector(`script[data-nim-chatroom-sdk="${src}"]`);
                if (existing) {
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => reject(new Error(`加载云信聊天室 SDK 失败: ${src}`)), { once: true });
                    if (normalizeNimChatroomGlobal()) resolve();
                    return;
                }

                const script = document.createElement('script');
                script.src = src;
                script.async = true;
                script.dataset.nimChatroomSdk = src;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error(`加载云信聊天室 SDK 失败: ${src}`));
                document.head.appendChild(script);
            });
        }

        async function ensureNimChatroomSdkLoaded() {
            const existing = normalizeNimChatroomGlobal();
            if (existing) return existing;

            if (!nimSdkLoadPromise) {
                nimSdkLoadPromise = (async () => {
                    await loadNimChatroomScript(NIM_CHATROOM_SDK_URL);
                    const sdk = normalizeNimChatroomGlobal();
                    if (sdk && sdk.Chatroom) return sdk;
                    throw new Error('本地云信聊天室 SDK 无效');
                })().catch(error => {
                    nimSdkLoadPromise = null;
                    throw error;
                });
            }

            return nimSdkLoadPromise;
        }

        function parseJsonObject(value) {
            if (!value) return null;
            if (typeof value === 'object' && !Array.isArray(value)) return value;
            if (typeof value !== 'string') return null;
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
            } catch (error) {
                return null;
            }
        }

        function readRawJsonId(value, key) {
            if (typeof value !== 'string') return '';
            const pattern = new RegExp(`"${key}"\\s*:\\s*(?:"([^"]+)"|(-?\\d+))`, 'i');
            const match = value.match(pattern);
            return String(match?.[1] || match?.[2] || '').trim();
        }

        function parseMessageExtension(msg) {
            const candidates = [msg?.custom, msg?.remoteExtension, msg?.ext, msg?.attach?.custom];
            let extension = null;
            for (const candidate of candidates) {
                extension = parseJsonObject(candidate);
                if (extension) break;
            }
            extension = extension || {};

            const nested = parseJsonObject(extension.data)
                || parseJsonObject(extension.ext)
                || parseJsonObject(extension.custom);
            if (nested) extension = { ...extension, ...nested };

            const rawCustom = candidates.find(value => typeof value === 'string') || '';
            const rawSourceId = readRawJsonId(rawCustom, 'sourceId');
            if (rawSourceId) extension.__rawSourceId = rawSourceId;
            return extension;
        }

        function getMessageUser(msg, extension) {
            const user = parseJsonObject(extension.user) || extension.user || {};
            return {
                nick: String(
                    user.nickName
                    || user.nickname
                    || user.nick
                    || user.name
                    || extension.nickName
                    || extension.nickname
                    || msg?.fromNick
                    || msg?.nick
                    || ''
                ).trim(),
                userId: String(user.userId || user.id || extension.userId || '').trim()
            };
        }

        function normalizeComparableId(value) {
            const text = String(value == null ? '' : value).trim();
            if (!text) return '';
            return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
        }

        function belongsToLive(extension, liveId) {
            const expected = normalizeComparableId(liveId);
            const sourceId = normalizeComparableId(
                extension.__rawSourceId || extension.sourceId || extension.liveId || ''
            );
            return !expected || !sourceId || expected === sourceId;
        }

        function parseGiftText(extension, user) {
            const giftInfo = parseJsonObject(extension.giftInfo) || extension.giftInfo || {};
            const gift = parseJsonObject(giftInfo.gift) || giftInfo.gift || {};
            const giftName = String(
                giftInfo.giftName
                || giftInfo.name
                || gift.name
                || extension.giftName
                || '礼物'
            ).trim();
            const giftNum = Number(
                giftInfo.giftNum
                || giftInfo.num
                || giftInfo.count
                || giftInfo.quantity
                || extension.giftNum
                || extension.num
                || 1
            ) || 1;
            const sender = user.nick || '用户';
            return `${sender} 赠送 ${giftNum} × ${giftName}`;
        }

        function normalizeChatroomMessage(msg, liveId) {
            if (!msg || typeof msg !== 'object') return null;
            const extension = parseMessageExtension(msg);
            if (!belongsToLive(extension, liveId)) return null;

            const messageType = String(
                extension.messageType
                || extension.msgType
                || extension.type
                || ''
            ).trim().toUpperCase();
            const user = getMessageUser(msg, extension);
            const isGift = GIFT_TYPES.has(messageType)
                || messageType.startsWith('PRESENT_')
                || messageType.startsWith('GIFT_');
            const isBarrage = BARRAGE_TYPES.has(messageType)
                || messageType.startsWith('BARRAGE_')
                || msg.type === 'text';

            if (isGift) {
                return {
                    kind: 'gift',
                    messageType,
                    text: parseGiftText(extension, user),
                    nick: user.nick,
                    userId: user.userId,
                    color: DANMU_COLORS.gift,
                    time: Number(msg.time || extension.time || Date.now())
                };
            }

            if (messageType === 'CLOSELIVE') {
                return {
                    kind: 'system',
                    messageType,
                    text: '直播已结束',
                    nick: '',
                    userId: '',
                    color: DANMU_COLORS.system,
                    time: Date.now()
                };
            }

            if (messageType === 'LIVEUPDATE' || messageType === 'DISABLE_SPEAK') {
                return null;
            }

            const text = String(extension.text || msg.text || '').trim();
            if (!isBarrage || !text) return null;
            return {
                kind: 'barrage',
                messageType,
                text,
                nick: user.nick,
                userId: user.userId,
                color: DANMU_COLORS[messageType] || DANMU_COLORS.normal,
                time: Number(msg.time || extension.time || Date.now())
            };
        }

        function ensureDanmuStyle() {
            if (document.getElementById('yaya-live-danmu-style')) return;
            const style = document.createElement('style');
            style.id = 'yaya-live-danmu-style';
            style.textContent = `
                #yaya-live-danmu-overlay {
                    position: absolute;
                    inset: 0;
                    overflow: hidden;
                    pointer-events: none;
                    z-index: 35;
                }
                .yaya-live-danmu-item {
                    position: absolute;
                    left: 100%;
                    white-space: nowrap;
                    font-weight: 700;
                    font-size: clamp(16px, 2vw, 24px);
                    line-height: 1.25;
                    text-shadow: -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000, 1px 1px 3px #000;
                    will-change: transform;
                    animation-name: yaya-live-danmu-move;
                    animation-timing-function: linear;
                    animation-fill-mode: forwards;
                }
                .yaya-live-danmu-item[data-kind="gift"] {
                    padding: 4px 10px;
                    border-radius: 999px;
                    background: rgba(82, 44, 12, 0.72);
                    box-shadow: 0 0 12px rgba(255, 184, 108, 0.45);
                }
                @keyframes yaya-live-danmu-move {
                    from { transform: translateX(0); }
                    to { transform: translateX(calc(-100vw - 100%)); }
                }
            `;
            document.head.appendChild(style);
        }

        function ensureDanmuOverlay() {
            const container = document.getElementById('dplayer-container')
                || document.querySelector('#live-player-container .artplayer-app')
                || document.getElementById('live-player-container');
            if (!container) return null;
            ensureDanmuStyle();
            if (window.getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            let overlay = document.getElementById('yaya-live-danmu-overlay');
            if (!overlay || overlay.parentElement !== container) {
                if (overlay) overlay.remove();
                overlay = document.createElement('div');
                overlay.id = 'yaya-live-danmu-overlay';
                overlay.setAttribute('aria-hidden', 'true');
                container.appendChild(overlay);
            }
            return overlay;
        }

        function drawLiveDanmu(item) {
            if (!item?.text) return;
            const overlay = ensureDanmuOverlay();
            if (!overlay) return;

            while (overlay.childElementCount >= 60) {
                overlay.firstElementChild?.remove();
            }

            const element = document.createElement('span');
            element.className = 'yaya-live-danmu-item';
            element.dataset.kind = item.kind || 'barrage';
            element.textContent = item.kind === 'barrage' && item.nick
                ? `${item.nick}：${item.text}`
                : item.text;
            element.style.color = item.color || DANMU_COLORS.normal;
            element.style.top = `${7 + (laneSequence % 8) * 9.5}%`;
            element.style.animationDuration = `${Math.min(16, Math.max(8, 8 + element.textContent.length * 0.11))}s`;
            laneSequence += 1;
            element.addEventListener('animationend', () => element.remove(), { once: true });
            overlay.appendChild(element);

            window.dispatchEvent(new CustomEvent('yaya:live-chat-message', { detail: item }));
        }

        function clearDanmuOverlay() {
            document.getElementById('yaya-live-danmu-overlay')?.remove();
        }

        function ensureStatusBadge() {
            let badge = document.getElementById('live-danmu-status');
            if (badge) return badge;
            const actions = document.querySelector('#live-player-view .player-top-actions');
            if (!actions) return null;
            badge = document.createElement('span');
            badge.id = 'live-danmu-status';
            badge.style.cssText = 'font-size:12px;padding:5px 9px;border-radius:999px;white-space:nowrap;border:1px solid currentColor;';
            actions.insertBefore(badge, actions.firstChild);
            return badge;
        }

        function setConnectionStatus(status, text) {
            const badge = ensureStatusBadge();
            if (!badge) return;
            const colors = {
                connecting: '#d48806',
                connected: '#389e0d',
                reconnecting: '#d48806',
                disconnected: '#cf1322'
            };
            const color = colors[status] || '#666';
            badge.dataset.status = status;
            badge.textContent = text;
            badge.style.color = color;
            badge.style.background = `${color}14`;
        }

        function clearConnectionStatus() {
            document.getElementById('live-danmu-status')?.remove();
        }

        function notifyPlayer(player, text) {
            try {
                if (player?.notice && 'show' in player.notice) {
                    player.notice.show = text;
                    return;
                }
                if (typeof player?.notice === 'function') player.notice(text);
            } catch (error) {
                reportIgnoredError(error);
            }
        }

        function teardownCurrentInstance() {
            const currentInstance = getNimInstance ? getNimInstance() : null;
            if (!currentInstance) return;
            try {
                if (typeof currentInstance.destroy === 'function') currentInstance.destroy();
                else if (typeof currentInstance.disconnect === 'function') currentInstance.disconnect();
            } catch (error) {
                reportIgnoredError(error);
            }
            setNimInstance(null);
        }

        function disconnectLiveDanmu({ clearUi = true } = {}) {
            sessionSequence += 1;
            teardownCurrentInstance();
            if (clearUi) {
                clearDanmuOverlay();
                clearConnectionStatus();
            }
        }

        async function resolveLoginOptions() {
            if (typeof getNimAuth === 'function') {
                try {
                    const auth = await getNimAuth();
                    const account = String(auth?.account || auth?.accid || '').trim();
                    const token = String(auth?.token || '').trim();
                    if (auth?.success !== false && account && token) {
                        return { account, token, isAnonymous: false };
                    }
                    if (auth?.msg) console.warn('[直播弹幕] 云信账号不可用:', auth.msg);
                } catch (error) {
                    console.warn('[直播弹幕] 读取云信账号失败:', error?.message || error);
                }
            }
            return {
                isAnonymous: true,
                chatroomNick: `guest_${Math.floor(Math.random() * 100000)}`
            };
        }

        async function connectLiveDanmu(chatroomId, player, options = {}) {
            if (!LIVE_DANMU_ENABLED) return null;

            const normalizedRoomId = String(chatroomId || '').trim();
            if (!normalizedRoomId) return null;

            const sessionId = ++sessionSequence;
            teardownCurrentInstance();
            clearDanmuOverlay();
            setConnectionStatus('connecting', '实时弹幕连接中');

            try {
                const [nimSdk, loginOptions] = await Promise.all([
                    ensureNimChatroomSdkLoaded(),
                    resolveLoginOptions()
                ]);
                if (sessionId !== sessionSequence) return null;

                const instance = nimSdk.Chatroom.getInstance({
                    appKey: CHATROOM_APP_KEY,
                    chatroomId: normalizedRoomId,
                    chatroomAddresses: CHATROOM_ADDRESSES,
                    secure: true,
                    needReconnect: true,
                    quickReconnect: true,
                    reconnectionAttempts: 12,
                    logLevel: 'error',
                    ...loginOptions,
                    onconnect: () => {
                        if (sessionId !== sessionSequence) return;
                        ensureDanmuOverlay();
                        setConnectionStatus('connected', '实时弹幕已连接');
                        notifyPlayer(player, '实时弹幕已连接');
                    },
                    onwillreconnect: () => {
                        if (sessionId !== sessionSequence) return;
                        setConnectionStatus('reconnecting', '实时弹幕重连中');
                    },
                    ondisconnect: data => {
                        if (sessionId !== sessionSequence) return;
                        const message = String(data?.message || '').trim();
                        const permissionDenied = /非法操作|没有权限|login error/i.test(message);
                        setConnectionStatus(
                            'disconnected',
                            permissionDenied ? '服务端拒绝 Web 弹幕' : '实时弹幕已断开'
                        );
                        if (permissionDenied) {
                            showToast?.('口袋48服务端拒绝 Web 端进入直播聊天室');
                        }
                        if (message) console.warn('[直播弹幕] 连接断开:', message);
                    },
                    onmsgs: messages => {
                        if (sessionId !== sessionSequence) return;
                        const list = Array.isArray(messages) ? messages : [messages];
                        list.forEach(message => {
                            const item = normalizeChatroomMessage(message, options.liveId);
                            if (item) drawLiveDanmu(item);
                        });
                    }
                });
                if (sessionId !== sessionSequence) {
                    if (typeof instance.destroy === 'function') instance.destroy();
                    else if (typeof instance.disconnect === 'function') instance.disconnect();
                    return null;
                }
                setNimInstance(instance);
                return instance;
            } catch (error) {
                if (sessionId !== sessionSequence) return null;
                console.error('[直播弹幕] 连接失败:', error);
                setConnectionStatus('disconnected', '实时弹幕连接失败');
                showToast?.('实时弹幕连接失败');
                return null;
            }
        }

        async function initLiveDanmu(chatroomId, options = {}) {
            return connectLiveDanmu(chatroomId, deps.getDp?.(), options);
        }

        async function initArtLiveDanmu(chatroomId, art, options = {}) {
            if (!art) return null;
            return connectLiveDanmu(chatroomId, art, options);
        }

        async function initDanmuForDPlayer(chatroomId, options = {}) {
            return initLiveDanmu(chatroomId, options);
        }

        return {
            disconnectLiveDanmu,
            ensureNimChatroomSdkLoaded,
            initLiveDanmu,
            initArtLiveDanmu,
            initDanmuForDPlayer,
            parseChatroomMessage: normalizeChatroomMessage
        };
    };
})();
