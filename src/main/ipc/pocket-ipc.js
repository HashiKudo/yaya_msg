const { ipcMain } = require('electron');
const pocketService = require('../services/pocket-service');
const settingsService = require('../services/settings-service');

const YAYA_API_PROXY_SETTING_KEY = 'useYayaApiProxy';
const DEFAULT_YAYA_API_BASE = 'https://api.gnz.hk';
const MEET48_CHANNELS = new Set([
    'fetch-meet48-live-list',
    'fetch-meet48-live-one'
]);

function readYayaApiProxySettings() {
    const settings = settingsService.readSettings();
    return {
        enabled: settings[YAYA_API_PROXY_SETTING_KEY] === true,
        baseUrl: String(settings.yayaApiProxyBaseUrl || DEFAULT_YAYA_API_BASE).trim() || DEFAULT_YAYA_API_BASE
    };
}

function withLocalMeet48Auth(channel, payload) {
    if (!MEET48_CHANNELS.has(channel) || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.meet48Auth) {
        return payload;
    }

    const meet48Auth = settingsService.readSettings().meet48Auth || {};
    const hasAuth = meet48Auth.token || meet48Auth.cookie || meet48Auth.deviceId;
    if (!hasAuth) return payload;

    return {
        ...payload,
        meet48Auth: {
            token: String(meet48Auth.token || ''),
            cookie: String(meet48Auth.cookie || ''),
            deviceId: String(meet48Auth.deviceId || '')
        }
    };
}

function getYayaApiProxyUrl(baseUrl) {
    return new URL('/api/ipc', baseUrl).toString();
}

function getYayaPocketApiProxyUrl(baseUrl) {
    return new URL('/api/pocket', baseUrl).toString();
}

async function invokeYayaApiProxy(channel, payload, baseUrl) {
    const requestPayload = withLocalMeet48Auth(channel, payload);
    const response = await fetch(getYayaApiProxyUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, payload: requestPayload || {} })
    });

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (error) {
        return {
            success: false,
            msg: /^\s*</.test(text || '')
                ? 'Yaya API 代理返回了网页内容，请稍后重试。'
                : 'Yaya API 代理返回内容不是 JSON'
        };
    }

    if (!response.ok) {
        return data || { success: false, msg: `Yaya API 代理请求失败: ${response.status}` };
    }

    return data || { success: false, msg: 'Yaya API 代理返回为空' };
}

async function invokeYayaPocketApiProxy(payload, baseUrl) {
    const response = await fetch(getYayaPocketApiProxyUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            path: payload?.path,
            postData: payload?.postData || {}
        })
    });

    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (error) {
        return {
            status: 500,
            content: {},
            message: /^\s*</.test(text || '')
                ? 'Yaya API 代理返回了网页内容，请稍后重试。'
                : 'Yaya API 代理返回内容不是 JSON'
        };
    }

    if (!response.ok) {
        return data || {
            status: response.status,
            content: {},
            message: `Yaya API 代理请求失败: ${response.status}`
        };
    }

    return data || { status: 500, content: {}, message: 'Yaya API 代理返回为空' };
}

async function handlePocketRequest(channel, payload, localHandler) {
    const proxySettings = readYayaApiProxySettings();
    if (proxySettings.enabled) {
        try {
            const proxyResult = await invokeYayaApiProxy(channel, payload, proxySettings.baseUrl);
            const proxyMessage = String(proxyResult?.msg || proxyResult?.message || '');
            if (!proxyResult?.success && proxyMessage.includes(`网页版暂不支持: ${channel}`)) {
                return localHandler(payload);
            }
            return proxyResult;
        } catch (error) {
            return {
                success: false,
                msg: `Yaya API 代理请求失败：${error.message || error}`
            };
        }
    }

    return localHandler(payload);
}

async function handlePocketApiPathRequest(payload) {
    const proxySettings = readYayaApiProxySettings();
    if (proxySettings.enabled) {
        try {
            return await invokeYayaPocketApiProxy(payload, proxySettings.baseUrl);
        } catch (error) {
            return {
                status: 500,
                content: {},
                message: `Yaya API 代理请求失败：${error.message || error}`
            };
        }
    }

    return pocketService.fetchPocketApiPath(payload);
}

function registerPocketIpc() {
    const handle = (channel, localHandler) => {
        ipcMain.handle(channel, (event, payload) => handlePocketRequest(channel, payload, localHandler));
    };

    ipcMain.handle('fetch-pocket-api', (event, payload) => handlePocketApiPathRequest(payload));
    handle('login-send-sms', (payload) => pocketService.loginSendSms(payload));
    handle('login-by-code', (payload) => pocketService.loginByCode(payload));
    handle('login-check-token', (payload) => pocketService.loginCheckToken(payload));
    handle('pocket-checkin', (payload) => pocketService.checkIn(payload));
    handle('switch-big-small', (payload) => pocketService.switchBigSmall(payload));
    handle('fetch-room-messages', (payload) => pocketService.fetchRoomMessages(payload));
    handle('fetch-private-message-list', (payload) => pocketService.fetchPrivateMessageList(payload));
    handle('fetch-private-message-info', (payload) => pocketService.fetchPrivateMessageInfo(payload));
    handle('delete-private-message', (payload) => pocketService.deletePrivateMessage(payload));
    handle('send-private-message-reply', (payload) => pocketService.sendPrivateMessageReply(payload));
    handle('fetch-flip-list', (payload) => pocketService.fetchFlipList(payload));
    handle('fetch-star-archives', (payload) => pocketService.fetchStarArchives(payload));
    handle('fetch-star-history', (payload) => pocketService.fetchStarHistory(payload));
    handle('fetch-open-live', (payload) => pocketService.fetchOpenLive(payload));
    handle('fetch-open-live-one', (payload) => pocketService.fetchOpenLiveOne(payload));
    handle('fetch-open-live-public-list', (payload) => pocketService.fetchOpenLivePublicList(payload));
    handle('fetch-meet48-live-list', (payload) => pocketService.fetchMeet48LiveList(payload));
    handle('fetch-meet48-live-one', (payload) => pocketService.fetchMeet48LiveOne(payload));
    handle('fetch-open-live-participants', (payload) => pocketService.fetchOpenLiveParticipants(payload));
    handle('fetch-flip-prices', (payload) => pocketService.fetchFlipPrices(payload));
    handle('send-flip-question', (payload) => pocketService.sendFlipQuestion(payload));
    handle('operate-flip-question', (payload) => pocketService.operateFlipQuestion(payload));
    handle('fetch-member-photos', (payload) => pocketService.fetchMemberPhotos(payload));
    handle('fetch-user-money', (payload) => pocketService.fetchUserMoney(payload));
    handle('fetch-invoice-tips', (payload) => pocketService.fetchInvoiceTips(payload));
    handle('fetch-invoice-config', (payload) => pocketService.fetchInvoiceConfig(payload));
    handle('fetch-invoice-order-list', (payload) => pocketService.fetchInvoiceOrderList(payload));
    handle('apply-electronic-invoice', (payload) => pocketService.applyElectronicInvoice(payload));
    handle('fetch-checkin-today', (payload) => pocketService.fetchCheckinToday(payload));
    handle('fetch-unread-message-count', (payload) => pocketService.fetchUnreadMessageCount(payload));
    handle('edit-user-info', (payload) => pocketService.editUserInfo(payload));
    handle('upload-user-avatar', (payload) => pocketService.uploadUserAvatar(payload));
    handle('upload-private-message-image', (payload) => pocketService.uploadPrivateMessageImage(payload));
    handle('fetch-user-rename-count', (payload) => pocketService.fetchUserRenameCount(payload));
    handle('fetch-user-picture-frames', (payload) => pocketService.fetchUserPictureFrames(payload));
    handle('fetch-client-group-team-star-update', (payload) => pocketService.fetchClientGroupTeamStarUpdate(payload));
    handle('fetch-star-server-map', (payload) => pocketService.fetchStarServerMap(payload));
    handle('fetch-media-collection-total-count', (payload) => pocketService.fetchMediaCollectionTotalCount(payload));
    handle('send-live-gift', (payload) => pocketService.sendLiveGift(payload));
    handle('fetch-gift-list', (payload) => pocketService.fetchGiftList(payload));
    handle('get-nim-login-info', (payload) => pocketService.getNimLoginInfo(payload));
    handle('fetch-room-album', (payload) => pocketService.fetchRoomAlbum(payload));
    handle('fetch-room-radio', (payload) => pocketService.fetchRoomRadio(payload));
    handle('fetch-seine-server-detail', (payload) => pocketService.fetchSeineServerDetail(payload));
    handle('fetch-live-rank', (payload) => pocketService.fetchLiveRank(payload));
    handle('fetch-friends-ids', (payload) => pocketService.fetchFriendsIds(payload));
    handle('fetch-last-messages', (payload) => pocketService.fetchLastMessages(payload));
    handle('follow-member', (payload) => pocketService.followMember(payload));
    handle('unfollow-member', (payload) => pocketService.unfollowMember(payload));
    handle('fetch-live-list', (payload) => pocketService.fetchLiveList(payload));
    handle('fetch-live-one', (payload) => pocketService.fetchLiveOne(payload));
    handle('fetch-live-result', (payload) => pocketService.fetchLiveResult(payload));
    handle('fetch-trip-list', (payload) => pocketService.fetchTripList(payload));
    handle('fetch-album-list', (payload) => pocketService.fetchAlbumList(payload));
    handle('fetch-melee-week-rank', (payload) => pocketService.fetchMeleeWeekRank(payload));
    handle('fetch-melee-rank-page', (payload) => pocketService.fetchMeleeRankPage(payload));
    handle('fetch-melee-year-rank-page', (payload) => pocketService.fetchMeleeYearRankPage(payload));
    handle('fetch-person-melee-rank-page', (payload) => pocketService.fetchPersonMeleeRankPage(payload));
    handle('fetch-post-image-list', (payload) => pocketService.fetchPostImageList(payload));
    handle('fetch-chatroom-homeowner-messages', (payload) => pocketService.fetchChatroomHomeownerMessages(payload));
    handle('fetch-member-weibo', (payload) => pocketService.fetchMemberWeiboMessages(payload));
    handle('fetch-member-dynamic', (payload) => pocketService.fetchMemberDynamicMessages(payload));
    handle('fetch-conversation-page', (payload) => pocketService.fetchConversationPage(payload));
    handle('fetch-user-home-info', (payload) => pocketService.fetchUserHomeInfo(payload));
    handle('fetch-flip-custom-index-v1', (payload) => pocketService.fetchFlipCustomIndexV1(payload));
    handle('fetch-area48-newest', (payload) => pocketService.fetchArea48Newest(payload));
    handle('fetch-area48-recommend', (payload) => pocketService.fetchArea48Recommend(payload));
    handle('fetch-area48-topic-info', (payload) => pocketService.fetchArea48TopicInfo(payload));
    handle('fetch-area48-topic-hot-posts', (payload) => pocketService.fetchArea48TopicHotPosts(payload));
    handle('fetch-area48-topic-newest-posts', (payload) => pocketService.fetchArea48TopicNewestPosts(payload));
    handle('fetch-area48-comments', (payload) => pocketService.fetchArea48Comments(payload));
    handle('fetch-area48-post-details', (payload) => pocketService.fetchArea48PostDetails(payload));
    handle('add-area48-comment', (payload) => pocketService.addArea48Comment(payload));
    handle('delete-area48-comment', (payload) => pocketService.deleteArea48Comment(payload));
    handle('create-area48-post', (payload) => pocketService.createArea48Post(payload));
    handle('fetch-pocket-mask-words', (payload) => pocketService.fetchPocketMaskWords(payload));
    handle('score-vote-login', (payload) => pocketService.loginElectionVote(payload));
    handle('score-vote-status', (payload) => pocketService.fetchElectionVoteStatus(payload));
    handle('score-act-status', (payload) => pocketService.fetchElectionActStatus(payload));
    handle('score-userinfo', (payload) => pocketService.fetchElectionUserInfo(payload));
    handle('score-vote-history', (payload) => pocketService.fetchElectionVoteHistory(payload));
    handle('score-code-act-history', (payload) => pocketService.fetchElectionCodeActHistory(payload));
    handle('score-check-sg-bind', (payload) => pocketService.fetchElectionSgBindStatus(payload));
    handle('score-bind-sg', (payload) => pocketService.bindElectionSg(payload));
    handle('score-rare-treasure-list', (payload) => pocketService.fetchPageantryRareTreasures(payload));
    handle('score-buy-star-list', (payload) => pocketService.fetchPageantryBuyStarList(payload));
    handle('fetch-score-official-bundle', (payload) => pocketService.fetchScoreOfficialBundle(payload));
    handle('score-official-action', (payload) => pocketService.runScoreOfficialAction(payload));
}

module.exports = {
    registerPocketIpc
};
