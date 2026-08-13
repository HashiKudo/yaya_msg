(function initWebNavigation() {
    if (!window.desktop || window.desktop.platform !== 'web') return;

    const APP_TITLE = '牙牙消息';
    const routeMap = {
        home: { view: 'home', mode: null, title: '' },
        messages: { view: 'messages', mode: null, title: '消息检索' },
        fetch: { view: 'fetch', mode: null, title: '抓取消息' },
        live: { view: 'media', mode: 'live', title: '正在直播' },
        vod: { view: 'media', mode: 'vod', title: '直播回放' },
        replay: { view: 'media', mode: 'vod', title: '直播回放' },
        'meet48-live': { view: 'media', mode: 'meet-live', title: '海外直播' },
        'meet48-vod': { view: 'media', mode: 'meet-vod', title: '海外回放' },
        room: { view: 'followed-rooms', mode: null, title: '口袋房间' },
        'followed-rooms': { view: 'followed-rooms', mode: null, title: '口袋房间' },
        message: { view: 'private-messages', mode: null, title: '私信列表' },
        '48qu': { view: 'community', mode: null, title: '社区' },
        community: { view: 'community', mode: null, title: '社区' },
        pbc: { view: 'pbc', mode: null, title: '屏蔽词检测' },
        img: { view: 'room-album', mode: null, title: '房间相册' },
        dynamic: { view: 'member-dynamic', mode: null, title: '成员动态' },
        weibo: { view: 'member-weibo', mode: null, title: '成员微博' },
        openlive: { view: 'openlive', mode: null, title: '公演记录' },
        'send-flip': { view: 'send-flip', mode: null, title: '翻牌提问' },
        flip: { view: 'flip', mode: null, title: '翻牌记录' },
        nft: { view: 'photos', mode: null, title: '个人相册' },
        video: { view: 'video-library', mode: null, title: '视频' },
        music: { view: 'official-site-music', mode: null, title: '音乐' },
        'official-site-music': { view: 'official-site-music', mode: null, title: '音乐' },
        audio: { view: 'audio-programs', mode: null, title: '电台' },
        profile: { view: 'profile', mode: null, title: '成员档案' },
        database: { view: 'database', mode: null, title: '数据库' },
        invoice: { view: 'invoice', mode: null, title: '开具发票' },
        melee: { view: 'melee-rank', mode: null, title: '鸡腿榜' },
        trip: { view: 'trip', mode: null, title: '成员行程' },
        login: { view: 'login', mode: null, title: '账号登录' },
        settings: { view: 'settings', mode: null, title: '页面设置' },
        voice: { view: 'room-radio', mode: null, title: '房间上麦' }
    };

    const viewToSlug = new Map([
        ['home:', 'home'],
        ['messages:', 'messages'],
        ['fetch:', 'fetch'],
        ['media:live', 'live'],
        ['media:vod', 'vod'],
        ['media:meet-live', 'meet48-live'],
        ['media:meet-vod', 'meet48-vod'],
        ['followed-rooms:', 'room'],
        ['private-messages:', 'message'],
        ['community:', '48qu'],
        ['pbc:', 'pbc'],
        ['room-album:', 'img'],
        ['member-dynamic:', 'dynamic'],
        ['member-weibo:', 'weibo'],
        ['openlive:', 'openlive'],
        ['send-flip:', 'send-flip'],
        ['flip:', 'flip'],
        ['photos:', 'nft'],
        ['video-library:', 'video'],
        ['official-site-music:', 'music'],
        ['audio-programs:', 'audio'],
        ['profile:', 'profile'],
        ['database:', 'database'],
        ['invoice:', 'invoice'],
        ['melee-rank:', 'melee'],
        ['trip:', 'trip'],
        ['login:', 'login'],
        ['settings:', 'settings'],
        ['room-radio:', 'voice']
    ]);

    let applyingRoute = false;

    function getViewKey(viewName, mode) {
        return `${viewName || 'home'}:${mode || ''}`;
    }

    function getLocationRoute() {
        const hashPath = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0];
        const path = hashPath || decodeURIComponent(String(window.location.pathname || '/'));
        const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        const slug = parts[0] && parts[0] !== 'index.html' ? parts[0] : 'home';
        const route = routeMap[slug] || routeMap.home;
        if ((slug === 'live' || slug === 'vod' || slug === 'replay') && parts[1]) {
            return { ...route, liveId: parts[1] };
        }
        return route;
    }

    function updatePageState(viewName, mode) {
        const slug = viewToSlug.get(getViewKey(viewName, mode));
        const title = slug && routeMap[slug] ? routeMap[slug].title : '';
        document.title = title ? `${APP_TITLE} - ${title}` : APP_TITLE;
        document.body.classList.toggle('web-secondary-page', Boolean(title));
        document.body.classList.toggle('web-message-page', viewName === 'messages');
        if (!title) document.documentElement.classList.remove('web-secondary-route-boot');
    }

    function updateUrl(viewName, mode, options = {}) {
        let slug = viewToSlug.get(getViewKey(viewName, mode)) || 'home';
        const liveId = String(options.liveId || '').trim();
        if (viewName === 'media' && (mode === 'live' || mode === 'vod') && liveId) {
            slug = `${mode}/${encodeURIComponent(liveId)}`;
        }
        const nextPath = slug === 'home' ? '/' : `/${slug}`;
        const currentPath = decodeURIComponent(window.location.pathname || '/').replace(/\/+$/, '') || '/';
        if (!window.location.hash && currentPath === nextPath) return;
        const state = liveId ? { viewName, mode, liveId } : { viewName, mode };
        history[options.replace ? 'replaceState' : 'pushState'](state, '', nextPath);
    }

    function onViewChanged(viewName, mode) {
        updatePageState(viewName, mode);
        if (!applyingRoute) updateUrl(viewName, mode, { replace: false });
    }

    function createMediaRouteItem(liveId, mode) {
        const isLive = mode === 'live';
        return {
            liveId,
            userInfo: { nickname: isLive ? '直播' : '录播' },
            nickname: isLive ? '直播' : '录播',
            title: isLive ? '正在直播' : '直播回放',
            liveTitle: isLive ? '正在直播' : '直播回放',
            startTime: 0,
            ctime: 0
        };
    }

    function playMediaRoute(liveId, mode) {
        const normalizedId = String(liveId || '').trim();
        if (!normalizedId) return;
        const attempt = () => {
            if (typeof window.playLiveStream !== 'function') {
                setTimeout(attempt, 80);
                return;
            }
            currentMediaRoute = { liveId: normalizedId, mode };
            window.playLiveStream(createMediaRouteItem(normalizedId, mode), mode);
            document.documentElement.classList.remove('web-route-pending');
        };
        setTimeout(attempt, 0);
    }

    function applyLocationRoute() {
        if (typeof window.switchView !== 'function' || window.switchView.__yayaPendingStub) return false;
        const route = getLocationRoute();
        applyingRoute = true;
        try {
            window.switchView(route.view, route.mode);
            updatePageState(route.view, route.mode);
            updateUrl(route.view, route.mode, { replace: true, liveId: route.liveId });
        } finally {
            applyingRoute = false;
        }
        if (route.liveId && (route.mode === 'live' || route.mode === 'vod')) {
            playMediaRoute(route.liveId, route.mode);
        } else {
            document.documentElement.classList.remove('web-route-pending');
        }
        return true;
    }

    function syncMediaRoute(mode, item, options = {}) {
        const liveId = String(item?.liveId || '').trim();
        if (!liveId) return;
        updatePageState('media', mode);
        updateUrl('media', mode, { ...options, liveId });
    }

    function syncMediaListRoute(mode) {
        updatePageState('media', mode);
        updateUrl('media', mode, { replace: true });
    }

    window.YayaPlatformAdapter = Object.freeze({ onViewChanged });
    window.openWebHomeRoute = function openWebHomeRoute(slug) {
        const route = routeMap[slug] || routeMap.home;
        const path = slug === 'home' ? '/' : `/${slug}`;
        window.open(path, '_blank', 'noopener');
        return route;
    };
    window.syncWebLiveRoute = (item, options = {}) => syncMediaRoute('live', item, options);
    window.syncWebVodRoute = (item, options = {}) => syncMediaRoute('vod', item, options);
    window.syncWebLiveListRoute = () => syncMediaListRoute('live');
    window.syncWebVodListRoute = () => syncMediaListRoute('vod');

    function boot() {
        if (!applyLocationRoute()) {
            setTimeout(boot, 30);
            return;
        }
        window.addEventListener('popstate', applyLocationRoute);
        window.addEventListener('hashchange', () => {
            if (!applyingRoute) applyLocationRoute();
        });
        const pending = Array.isArray(window.__yayaPendingSwitchView) ? window.__yayaPendingSwitchView : null;
        window.__yayaPendingSwitchView = null;
        if (pending) window.switchView(...pending);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
