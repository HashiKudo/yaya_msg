(function () {
    window.YayaRendererFeatures = window.YayaRendererFeatures || {};

    window.YayaRendererFeatures.createNimChatroomFeature = function createNimChatroomFeature(deps) {
        const {
            getDp,
            getNimInstance,
            setNimInstance,
            handlePocketMessage,
            showToast
        } = deps;

        const NIM_CHATROOM_SDK_URL = './src/renderer/vendor/NIM_Web_Chatroom.js';
        const CHATROOM_ADDRESSES = ['chatweblink01.netease.im:443'];
        const CHATROOM_APP_KEY = '632feff1f4c838541ab75195d1ceb3fa';

        let nimSdkLoadPromise = null;

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

        function buildChatroomOptions(chatroomId, handlers = {}) {
            return {
                appKey: CHATROOM_APP_KEY,
                chatroomId,
                chatroomAddresses: CHATROOM_ADDRESSES,
                isAnonymous: true,
                chatroomNick: 'guest_' + Math.floor(Math.random() * 10000),
                ...handlers
            };
        }

        function parseNimDanmuText(msg) {
            try {
                if (msg.type === 'text') return msg.text || '';
                if (msg.custom) {
                    const custom = JSON.parse(msg.custom);
                    return custom.text || '';
                }
            } catch (error) { window.YayaRendererUtils.reportIgnoredError(error, 'src/renderer/nim-chatroom-feature.js'); }
            return '';
        }

        function drawDPlayerDanmu(msg) {
            const dp = getDp ? getDp() : null;
            const text = parseNimDanmuText(msg);
            if (text && dp && dp.danmaku) {
                dp.danmaku.draw({
                    text,
                    color: '#fff',
                    type: 'right'
                });
            }
        }

        async function getChatroomSdkOrNotify() {
            return ensureNimChatroomSdkLoaded().catch(error => {
                console.error(error);
                showToast('弹幕聊天室 SDK 加载失败');
                return null;
            });
        }

        async function initLiveDanmu(chatroomId) {
            if (!chatroomId) return;
            const nimSdk = await getChatroomSdkOrNotify();
            if (!nimSdk) return;

            const currentInstance = getNimInstance ? getNimInstance() : null;
            if (currentInstance) {
                currentInstance.disconnect();
                setNimInstance(null);
            }

            const instance = nimSdk.Chatroom.getInstance(buildChatroomOptions(chatroomId, {
                onconnect: () => {
                    const dp = getDp ? getDp() : null;
                    if (dp) dp.notice('弹幕服务器已连接');
                },
                onmsgs: msgs => {
                    msgs.forEach(drawDPlayerDanmu);
                }
            }));
            setNimInstance(instance);
        }

        async function initArtLiveDanmu(chatroomId, art) {
            if (!chatroomId || !art) return;
            const nimSdk = await getChatroomSdkOrNotify();
            if (!nimSdk) return;

            const instance = nimSdk.Chatroom.getInstance(buildChatroomOptions(chatroomId, {
                onconnect: () => {
                    if (art.notice) art.notice.show = '弹幕服务器已连接';
                },
                onmsgs: msgs => {
                    msgs.forEach(msg => handlePocketMessage(msg, art));
                }
            }));
            setNimInstance(instance);
        }

        async function initDanmuForDPlayer(chatroomId) {
            if (!chatroomId) return;
            const nimSdk = await getChatroomSdkOrNotify();
            if (!nimSdk) return;

            const instance = nimSdk.Chatroom.getInstance(buildChatroomOptions(chatroomId, {
                onconnect: () => {
                    const dp = getDp ? getDp() : null;
                    if (dp) dp.notice('弹幕服务器已连接');
                },
                onmsgs: msgs => {
                    msgs.forEach(drawDPlayerDanmu);
                }
            }));
            setNimInstance(instance);
        }

        return {
            ensureNimChatroomSdkLoaded,
            initLiveDanmu,
            initArtLiveDanmu,
            initDanmuForDPlayer
        };
    };
})();
