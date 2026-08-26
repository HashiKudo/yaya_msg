        (function () {
            const settingsApi = window.desktop && window.desktop.appSettings ? window.desktop.appSettings : null;
            const savedTheme = settingsApi && typeof settingsApi.getSettingValueSync === 'function'
                ? String(settingsApi.getSettingValueSync('theme', 'light') || 'light')
                : (localStorage.getItem('theme') || 'light');
            const savedBg = settingsApi && typeof settingsApi.getBackgroundUrlSync === 'function'
                ? settingsApi.getBackgroundUrlSync()
                : localStorage.getItem('custom_bg_data');
            const THEME_STYLE_ID = 'yaya-theme-init-style';
            const BG_STYLE_ID = 'yaya-custom-bg-style';

    function ensureStyleNode(id) {
        let styleEl = document.getElementById(id);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = id;
            document.head.appendChild(styleEl);
        }
        return styleEl;
    }

            function applyThemeBootStyle(theme) {
                const styleEl = ensureStyleNode(THEME_STYLE_ID);
                styleEl.textContent = theme === 'dark'
                    ? 'html, body { background-color: #1e1e1e !important; }'
                    : '';
            }

            async function recoverWebBackground(imageElement) {
                if (!imageElement || imageElement.dataset.fallbackAttempted === 'true') return;
                const sourceUrl = imageElement.currentSrc || imageElement.src;
                if (!sourceUrl || sourceUrl.startsWith('blob:')) return;

                imageElement.dataset.fallbackAttempted = 'true';
                try {
                    const response = await fetch(sourceUrl, {
                        cache: 'no-store',
                        credentials: 'omit'
                    });
                    if (!response.ok) throw new Error(`Background request failed: ${response.status}`);
                    imageElement.src = URL.createObjectURL(await response.blob());
                } catch (_) {
                    // Keep the theme background color as a safe fallback.
                }
            }

            function applyCustomBackground(bgData) {
                const styleEl = ensureStyleNode(BG_STYLE_ID);
                const nextBg = String(bgData || '').trim();
                window.__yayaCurrentBackgroundUrl = nextBg;

                const webBackgroundLayer = document.getElementById('web-background-layer');
                if (webBackgroundLayer) {
                    delete webBackgroundLayer.dataset.fallbackAttempted;
                    if (nextBg) {
                        webBackgroundLayer.src = nextBg;
                    } else {
                        webBackgroundLayer.removeAttribute('src');
                    }
                }

                if (!nextBg) {
                    document.documentElement.style.removeProperty('--yaya-background-image');
                    styleEl.textContent = 'html, body { background-image: none !important; }';
                    return;
                }

                const escapedBg = String(nextBg)
                    .replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"');
                document.documentElement.style.setProperty(
                    '--yaya-background-image',
                    `url("${escapedBg}")`
                );
                styleEl.textContent = `html, body { background-image: url("${escapedBg}") !important; background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; }`;
            }

            window.__applyYayaThemeBootStyle = applyThemeBootStyle;
            window.__applyYayaCustomBackground = applyCustomBackground;
            window.__recoverYayaWebBackground = recoverWebBackground;

    document.documentElement.setAttribute('data-theme', savedTheme);
    applyThemeBootStyle(savedTheme);
    applyCustomBackground(savedBg);
})();
