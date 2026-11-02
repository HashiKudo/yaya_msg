(function () {
    window.YayaRendererFeatures = window.YayaRendererFeatures || {};

    window.YayaRendererFeatures.createThemeFeature = function createThemeFeature() {
        function readThemeSetting() {
            if (typeof window.readStoredStringSetting === 'function') {
                return window.readStoredStringSetting('theme', 'light');
            }
            const settingsApi = window.desktop && window.desktop.appSettings ? window.desktop.appSettings : null;
            if (settingsApi && typeof settingsApi.getSettingValueSync === 'function') {
                return String(settingsApi.getSettingValueSync('theme', 'light') || 'light');
            }
            return localStorage.getItem('theme') || 'light';
        }

        function writeThemeSetting(value) {
            if (typeof window.writeStoredStringSetting === 'function') {
                return window.writeStoredStringSetting('theme', value);
            }
            localStorage.setItem('theme', value);
            return value;
        }

        function applyCustomBackground(bgData) {
            if (typeof window.__applyYayaCustomBackground === 'function') {
                window.__applyYayaCustomBackground(bgData || '');
            }

            document.body.style.backgroundImage = '';
        }

        function initAppIconSetting(settingsApi) {
            const row = document.getElementById('app-icon-setting');
            if (!row || !settingsApi || typeof settingsApi.getAppIcon !== 'function') return;
            row.style.display = '';
            if (row.dataset.iconInitialized === 'true') return;
            row.dataset.iconInitialized = 'true';

            const preview = document.getElementById('app-icon-preview');
            const status = document.getElementById('app-icon-status');
            const chooseButton = document.getElementById('app-icon-choose');
            const resetButton = document.getElementById('app-icon-reset');
            let custom = false;
            let busy = false;

            async function updateIcon(method) {
                if (busy) return;
                busy = true;
                row.setAttribute('aria-busy', 'true');
                chooseButton.disabled = true;
                resetButton.disabled = true;
                try {
                    const result = await settingsApi[method]();
                    if (!result || !result.success) {
                        throw new Error(result?.msg || '图标更新失败');
                    }
                    if (result.canceled) return;
                    custom = result.custom === true;
                    if (result.previewUrl) {
                        preview.src = result.previewUrl;
                    } else {
                        preview.removeAttribute('src');
                    }
                    preview.style.visibility = result.previewUrl ? 'visible' : 'hidden';
                    status.textContent = custom ? '自定义图标' : '默认图标';
                } catch (error) {
                    status.textContent = `图标更新失败：${error.message || '未知错误'}`;
                } finally {
                    busy = false;
                    row.setAttribute('aria-busy', 'false');
                    chooseButton.disabled = false;
                    resetButton.disabled = !custom;
                }
            }

            chooseButton.addEventListener('click', () => updateIcon('chooseAppIcon'));
            resetButton.addEventListener('click', () => updateIcon('resetAppIcon'));
            updateIcon('getAppIcon');
        }

        function initTheme() {
            const savedTheme = readThemeSetting();
            const settingsApi = window.desktop && window.desktop.appSettings ? window.desktop.appSettings : null;
            document.documentElement.setAttribute('data-theme', savedTheme);
            if (typeof window.__applyYayaThemeBootStyle === 'function') {
                window.__applyYayaThemeBootStyle(savedTheme);
            }
            updateThemeBtn(savedTheme);

            const savedBg = settingsApi && typeof settingsApi.getBackgroundUrlSync === 'function'
                ? settingsApi.getBackgroundUrlSync()
                : localStorage.getItem('custom_bg_data');
            applyCustomBackground(savedBg || '');
            initAppIconSetting(settingsApi);
        }

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            writeThemeSetting(next);
            if (typeof window.__applyYayaThemeBootStyle === 'function') {
                window.__applyYayaThemeBootStyle(next);
            }
            updateThemeBtn(next);
        }

        function updateThemeBtn(theme) {
            const compactLabel = theme === 'dark' ? '🌙 深色模式' : '🌞 浅色模式';
            const settingsLabel = theme === 'dark' ? '深色模式' : '浅色模式';
            document.querySelectorAll('[data-theme-toggle-label]').forEach(buttonEl => {
                const variant = buttonEl.getAttribute('data-theme-toggle-label');
                buttonEl.textContent = variant === 'settings' ? settingsLabel : compactLabel;
            });
        }

        return {
            applyCustomBackground,
            initTheme,
            toggleTheme,
            updateThemeBtn
        };
    };
})();
