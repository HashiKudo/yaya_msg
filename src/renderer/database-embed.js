(function initDatabaseEmbed() {
    const DATABASE_STYLES_PATH = 'src/renderer/database/styles.css';
    const DESKTOP_DATABASE_RUNTIME_PATH = './database/runtime.js';
    const WEB_DATABASE_RUNTIME_PATH = '/src/renderer/database/runtime.js';
    const WEB_DATABASE_STYLES_PATH = '/src/renderer/database/styles.css';
    const TAILWIND_URL = 'https://cdn.tailwindcss.com';
    const EMBED_SCRIPT_SRC = document.currentScript && document.currentScript.src ? document.currentScript.src : '';

    let runtimePromise = null;
    let mountPromise = null;

    function getDatabaseHost() {
        return document.getElementById('database-root');
    }

    function isWebRuntime() {
        return !!(window.desktop && window.desktop.platform === 'web');
    }

    function getWebDatabaseRuntimeUrl() {
        return getVersionedRuntimeUrl(WEB_DATABASE_RUNTIME_PATH);
    }

    function getDesktopDatabaseRuntimeUrl() {
        return getVersionedRuntimeUrl(DESKTOP_DATABASE_RUNTIME_PATH);
    }

    function getVersionedRuntimeUrl(runtimePath) {
        let version = '';
        try {
            version = new URL(EMBED_SCRIPT_SRC).searchParams.get('v') || '';
        } catch (error) { }
        return version
            ? `${runtimePath}?v=${encodeURIComponent(version)}`
            : runtimePath;
    }

    function setDatabaseState(html, className) {
        const host = getDatabaseHost();
        if (!host) return;
        host.innerHTML = `<div class="${className}">${html}</div>`;
    }

    function loadExternalScript(src, id) {
        const existing = id ? document.getElementById(id) : null;
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            if (id) script.id = id;
            script.onload = () => resolve(script);
            script.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
            document.head.appendChild(script);
        });
    }

    function ensureTailwindConfig() {
        if (document.getElementById('database-tailwind-config')) return;
        const script = document.createElement('script');
        script.id = 'database-tailwind-config';
        script.textContent = `
            window.tailwind = window.tailwind || {};
            window.tailwind.config = {
                darkMode: 'class',
                theme: {
                    extend: {
                        colors: {
                            gray: {
                                750: '#2d3748',
                                850: '#1a202c',
                                950: '#0d1117'
                            },
                            gold: {
                                500: '#EAB308',
                                100: '#FEF9C3'
                            },
                            silver: {
                                500: '#94A3B8',
                                100: '#F1F5F9'
                            },
                            bronze: {
                                500: '#B45309',
                                100: '#FFEDD5'
                            }
                        }
                    }
                }
            };
        `;
        document.head.appendChild(script);
    }

    async function ensureRuntime() {
        if (runtimePromise) return runtimePromise;

        runtimePromise = (async () => {
            ensureTailwindConfig();
            if (!document.getElementById('database-tailwind-runtime')) {
                await loadExternalScript(TAILWIND_URL, 'database-tailwind-runtime');
            }
        })();

        return runtimePromise;
    }

    async function readDatabaseAsset(desktopPath, webPath) {
        const desktop = window.desktop;
        if (desktop && desktop.platform === 'web') {
            const response = await fetch(webPath);
            if (!response.ok) {
                throw new Error(`数据库资源加载失败: ${response.status}`);
            }
            return response.text();
        }

        if (!desktop || !desktop.fs || !desktop.path || !desktop.appDir) {
            throw new Error('数据库运行环境未准备好');
        }

        const assetPath = desktop.path.join(desktop.appDir, desktopPath);
        return desktop.fs.readFileSync(assetPath, 'utf8');
    }

    function readDatabaseStyles() {
        return readDatabaseAsset(DATABASE_STYLES_PATH, WEB_DATABASE_STYLES_PATH);
    }

    function injectDatabaseStyles(styles) {
        if (document.getElementById('database-embed-style')) return;

        const style = document.createElement('style');
        style.id = 'database-embed-style';
        style.textContent = String(styles || '')
            .replace(/html\s*,\s*body\s*\{[\s\S]*?\}\s*/g, '')
            .replace(/body\s*\{[\s\S]*?\}\s*/g, '');
        document.head.appendChild(style);
    }

    async function mountDatabaseView() {
        const host = getDatabaseHost();
        if (!host) return;
        if (host.dataset.databaseMounted === 'true') return;
        if (mountPromise) return mountPromise;

        mountPromise = (async () => {
            try {
                const styles = await readDatabaseStyles();
                injectDatabaseStyles(styles);
                await ensureRuntime();

                if (isWebRuntime()) {
                    host.innerHTML = '';
                    await import(getWebDatabaseRuntimeUrl());
                    host.dataset.databaseMounted = 'true';
                    return;
                }

                host.innerHTML = '';
                await import(getDesktopDatabaseRuntimeUrl());
                host.dataset.databaseMounted = 'true';
            } catch (error) {
                console.error('数据库页面挂载失败:', error);
                setDatabaseState(`数据库加载失败<br>${error.message || error}`, 'database-error');
            } finally {
                mountPromise = null;
            }
        })();

        return mountPromise;
    }

    window.mountDatabaseView = mountDatabaseView;
})();
