(function initWebShell() {
    if (!window.desktop || window.desktop.platform !== 'web') return;

    const utils = window.YayaRendererUtils;
    const PROFILE_KEY = 'yaya_web_account_profile_v1';

    function createElement(tagName, options = {}) {
        const element = document.createElement(tagName);
        if (options.className) element.className = options.className;
        if (options.id) element.id = options.id;
        if (options.text != null) element.textContent = String(options.text);
        if (options.attributes) {
            Object.entries(options.attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
        }
        return element;
    }

    function createTopbarButton(label, route, className = '') {
        const button = createElement('button', {
            className: `web-topbar-btn ${className}`.trim(),
            text: label,
            attributes: { type: 'button', title: label, 'aria-label': label }
        });
        if (route) button.addEventListener('click', () => window.openWebHomeRoute(route));
        return button;
    }

    function createWebTopbar() {
        const appContainer = document.querySelector('.app-container');
        if (!appContainer || document.querySelector('.web-app-topbar')) return;

        const topbar = createElement('header', {
            className: 'web-app-topbar',
            attributes: { 'aria-label': '网页快捷操作' }
        });
        const brand = createElement('div', {
            className: 'web-topbar-brand',
            attributes: { 'aria-label': '牙牙消息' }
        });
        const logo = createElement('img', { attributes: { src: './web-icon.png', alt: '' } });
        const brandText = createElement('span', { className: 'web-topbar-brand-text' });
        brandText.append(
            createElement('span', { className: 'web-topbar-title', text: '牙牙消息' }),
            createElement('span', { className: 'web-topbar-subtitle', text: 'by yk1z' })
        );
        brand.append(logo, brandText);

        const actions = createElement('nav', {
            className: 'web-topbar-actions',
            attributes: { 'aria-label': '页面设置' }
        });
        actions.append(
            createTopbarButton('屏蔽词检测', 'pbc', 'web-pbc-btn'),
            createTopbarButton('开具发票', 'invoice', 'web-invoice-btn')
        );

        const accountButton = createElement('button', {
            id: 'web-account-button',
            className: 'web-account-button',
            attributes: { type: 'button', title: '登录账号', 'aria-label': '登录账号' }
        });
        accountButton.addEventListener('click', () => window.openWebHomeRoute('login'));
        accountButton.append(
            createElement('span', { id: 'web-account-login-label', className: 'web-account-login-label', text: '登录' }),
            createElement('img', {
                id: 'web-account-avatar',
                className: 'web-account-avatar',
                attributes: { src: './web-icon.png', alt: '' }
            })
        );
        const themeButton = createTopbarButton('模式', null, 'web-theme-toggle');
        themeButton.addEventListener('click', () => {
            if (typeof window.toggleTheme === 'function') window.toggleTheme();
        });
        actions.append(accountButton, themeButton);
        topbar.append(brand, actions);
        appContainer.before(topbar);
    }

    function getStoredToken() {
        const settings = utils.parseJson(localStorage.getItem('yaya_web_settings') || '{}', {}, 'web_shell_settings');
        return String(settings?.yaya_p48_token || localStorage.getItem('yaya_p48_token') || '').trim();
    }

    function hydrateAccountButton() {
        if (!getStoredToken()) return;
        const profile = utils.parseJson(localStorage.getItem(PROFILE_KEY) || 'null', null, 'web_shell_profile');
        if (!profile || typeof profile !== 'object') return;

        const button = document.getElementById('web-account-button');
        const avatar = document.getElementById('web-account-avatar');
        if (!button || !avatar) return;
        const nickname = String(profile.nickname || '').trim();
        avatar.src = utils.normalize48Url(profile.avatarUrl || profile.avatar, 'https://source.48.cn') || './web-icon.png';
        avatar.addEventListener('error', () => { avatar.src = './web-icon.png'; }, { once: true });
        button.classList.add('is-logged-in');
        button.setAttribute('aria-label', `${nickname || '口袋用户'}，账号设置`);
        button.title = `${nickname || '口袋用户'} · 账号设置`;
    }

    function hideDesktopOnlyControls() {
        const selectors = [
            '.home-panel-messages',
            '.home-panel-settings',
            '.home-card[onclick*="bilibili-live"]',
            '.home-card[onclick*="downloads"]',
            '.home-card[onclick*="room-radio"]',
            '#btn-room-album-dl-all'
        ];
        document.querySelectorAll(selectors.join(',')).forEach((element) => element.classList.add('web-hidden'));

        document.querySelectorAll('.account-section-card').forEach((element) => {
            if (element.textContent.includes('B站登录')) element.classList.add('web-hidden');
        });
        document.querySelectorAll('.Box-row').forEach((element) => {
            if (/IP检测|下载路径/.test(element.textContent || '')) element.classList.add('web-hidden');
        });
    }

    function addDownloadNotice() {
        const footer = document.querySelector('.home-footer-credit');
        if (!footer || document.querySelector('.web-limit-notice')) return;
        const desktopVersion = 'v2.10';
        const releaseStamp = '20260815-fe62beb';
        const notice = createElement('div', { className: 'web-limit-notice' });
        notice.append(createElement('span', {
            className: 'web-limit-copy',
            text: `由于网页限制，使用完整功能请下载桌面端 ${desktopVersion}。`
        }));
        const actions = createElement('div', {
            className: 'web-download-actions',
            attributes: { 'aria-label': '桌面端下载' }
        });
        [
            ['Windows', `/downloads/yaya_msg-${desktopVersion}-win.zip?v=${releaseStamp}`],
            ['macOS', `/downloads/yaya_msg-${desktopVersion}-mac.zip?v=${releaseStamp}`],
            ['Linux', `/downloads/yaya_msg-${desktopVersion}-linux.tar.gz?v=${releaseStamp}`]
        ].forEach(([label, href]) => {
            actions.append(createElement('a', {
                className: 'web-desktop-download-btn',
                text: label,
                attributes: { href, download: '' }
            }));
        });
        notice.append(actions);
        footer.before(notice);
    }

    function syncViewport() {
        const root = document.documentElement;
        const isMobile = window.matchMedia?.('(max-width: 768px)').matches;
        if (!isMobile) {
            root.style.removeProperty('--web-mobile-bottom-reserve');
            root.style.removeProperty('--web-viewport-height');
            root.style.removeProperty('--web-secondary-shell-height');
            return;
        }
        const viewport = window.visualViewport;
        const viewportHeight = viewport?.height || window.innerHeight;
        const overlap = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
        root.style.setProperty('--web-viewport-height', `${Math.round(viewportHeight)}px`);
        root.style.setProperty('--web-mobile-bottom-reserve', `${Math.max(104, Math.round(overlap))}px`);
    }

    function boot() {
        createWebTopbar();
        hydrateAccountButton();
        hideDesktopOnlyControls();
        addDownloadNotice();
        syncViewport();
        document.title = '牙牙消息';
        window.requestAnimationFrame(() => {
            document.documentElement.classList.remove('web-shell-pending');
        });
    }

    window.addEventListener('resize', syncViewport, { passive: true });
    window.addEventListener('orientationchange', syncViewport, { passive: true });
    window.visualViewport?.addEventListener('resize', syncViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncViewport, { passive: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
