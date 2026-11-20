(function () {
    if (!window.desktop || window.desktop.platform === 'web') return;
    window.YayaRendererFeatures = window.YayaRendererFeatures || {};

    const MAX_HOME_IMAGE_BYTES = 50 * 1024 * 1024;
    const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i;
    const FIT_MODES = [
        { value: 'contain', label: '适应页面', shortLabel: '适应' },
        { value: 'cover', label: '铺满页面', shortLabel: '铺满' },
        { value: 'original', label: '原始尺寸', shortLabel: '原图' }
    ];
    const FIT_LABEL_MAP = new Map(FIT_MODES.map(item => [item.value, item.label]));

    function normalizeFitMode(value) {
        return FIT_LABEL_MAP.has(value) ? value : 'contain';
    }

    function normalizeState(raw) {
        const custom = Boolean(raw?.custom && raw?.url);
        return {
            custom,
            url: custom ? String(raw.url) : '',
            fileName: custom ? String(raw.fileName || '').trim() || '自定义图片' : '',
            fitMode: normalizeFitMode(raw?.fitMode)
        };
    }

    function isSupportedImageFile(file) {
        if (!file) return false;
        if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
        return IMAGE_EXT_RE.test(String(file.name || ''));
    }

    function verifyImageFile(file) {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Image !== 'function') {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const probe = new Image();
            const cleanup = () => URL.revokeObjectURL(objectUrl);
            probe.onload = () => {
                cleanup();
                resolve();
            };
            probe.onerror = () => {
                cleanup();
                reject(new Error('无法读取该图片文件，请选择有效的图片'));
            };
            probe.src = objectUrl;
        });
    }

    function ensureHomeHost(homeView) {
        const host = homeView.querySelector('.desktop-custom-home') || document.createElement('section');
        host.className = 'desktop-custom-home';
        host.setAttribute('aria-label', '主页');
        host.hidden = false;
        if (!host.parentElement) homeView.appendChild(host);

        let image = host.querySelector('.desktop-custom-home-image');
        if (!image) {
            image = document.createElement('img');
            image.className = 'desktop-custom-home-image';
            image.alt = '主页展示图片';
            image.draggable = false;
            image.hidden = true;
            host.appendChild(image);
        }

        let toolbar = host.querySelector('.desktop-custom-home-toolbar');
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.className = 'desktop-custom-home-toolbar';
            toolbar.setAttribute('role', 'toolbar');
            toolbar.setAttribute('aria-label', '主页图片操作');
            const chooseBtn = document.createElement('button');
            chooseBtn.type = 'button';
            chooseBtn.className = 'desktop-custom-home-btn';
            chooseBtn.dataset.homeAction = 'choose';
            chooseBtn.textContent = '选择图片';
            const fitBtn = document.createElement('button');
            fitBtn.type = 'button';
            fitBtn.className = 'desktop-custom-home-btn';
            fitBtn.dataset.homeAction = 'fit';
            fitBtn.hidden = true;
            fitBtn.textContent = '适应页面';
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'desktop-custom-home-btn desktop-custom-home-btn-danger';
            clearBtn.dataset.homeAction = 'clear';
            clearBtn.hidden = true;
            clearBtn.textContent = '清除';
            toolbar.append(chooseBtn, fitBtn, clearBtn);
            host.appendChild(toolbar);
        }

        let dropHint = host.querySelector('.desktop-custom-home-drop-hint');
        if (!dropHint) {
            dropHint = document.createElement('div');
            dropHint.className = 'desktop-custom-home-drop-hint';
            dropHint.hidden = true;
            dropHint.setAttribute('aria-hidden', 'true');
            dropHint.textContent = '松开以在主页展示该图片';
            host.appendChild(dropHint);
        }

        let menu = host.querySelector('.desktop-custom-home-menu');
        if (!menu) {
            menu = document.createElement('div');
            menu.className = 'desktop-custom-home-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', '主页图片菜单');
            menu.hidden = true;
            host.appendChild(menu);
        }

        return {
            host,
            image,
            toolbar,
            chooseButton: toolbar.querySelector('[data-home-action="choose"]'),
            fitButton: toolbar.querySelector('[data-home-action="fit"]'),
            clearButton: toolbar.querySelector('[data-home-action="clear"]'),
            dropHint,
            menu
        };
    }

    window.YayaRendererFeatures.createDesktopCustomHome = function ({
        homeView,
        appSettings = window.desktop?.appSettings,
        notify = message => window.showToast?.(message)
    } = {}) {
        if (!homeView) return null;

        const elements = ensureHomeHost(homeView);
        const { host, image, toolbar, chooseButton, fitButton, clearButton, dropHint, menu } = elements;
        let state = normalizeState(appSettings?.getHomeImageInfoSync?.());
        let busy = false;
        let disposed = false;
        let dragDepth = 0;
        let idleTimer = null;

        function setBusy(nextBusy) {
            busy = nextBusy;
            host.setAttribute('aria-busy', String(nextBusy));
            chooseButton.disabled = nextBusy;
            fitButton.disabled = nextBusy;
            clearButton.disabled = nextBusy;
        }

        function emitChange() {
            window.dispatchEvent(new CustomEvent('yaya:home-image-changed', {
                detail: { ...state }
            }));
        }

        function renderState() {
            host.dataset.hasImage = String(state.custom);
            host.dataset.fitMode = state.fitMode;
            if (state.custom) {
                if (image.getAttribute('src') !== state.url) {
                    image.src = state.url;
                }
                image.alt = state.fileName ? `主页展示图片：${state.fileName}` : '主页展示图片';
                image.hidden = false;
            } else {
                image.hidden = true;
                image.removeAttribute('src');
            }

            chooseButton.textContent = state.custom ? '更换图片' : '选择图片';
            chooseButton.title = state.custom ? '更换主页展示图片' : '选择图片在空白主页展示';
            fitButton.hidden = !state.custom;
            clearButton.hidden = !state.custom;
            const fitLabel = FIT_LABEL_MAP.get(state.fitMode) || '适应页面';
            fitButton.textContent = fitLabel;
            fitButton.title = `切换显示模式（当前：${fitLabel}）`;
        }

        function applyState(nextRaw, { emit = true } = {}) {
            state = normalizeState(nextRaw);
            renderState();
            if (emit) emitChange();
            return { ...state };
        }

        function clearIdleTimer() {
            clearTimeout(idleTimer);
            idleTimer = null;
        }

        function hideControls() {
            clearIdleTimer();
            host.classList.remove('is-controls-visible');
        }

        function revealControls() {
            if (disposed) return;
            host.classList.add('is-controls-visible');
            clearIdleTimer();
            if (toolbar.matches(':hover') || toolbar.contains(document.activeElement) || host.classList.contains('is-menu-open')) {
                return;
            }
            idleTimer = setTimeout(() => {
                if (disposed || toolbar.matches(':hover') || toolbar.contains(document.activeElement)) return;
                host.classList.remove('is-controls-visible');
            }, 2200);
        }

        function closeMenu() {
            if (menu.hidden) return;
            menu.hidden = true;
            menu.replaceChildren();
            host.classList.remove('is-menu-open');
        }

        function addMenuItem(label, handler, { checked = false, danger = false, role = 'menuitem' } = {}) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'desktop-custom-home-menu-item';
            if (danger) button.classList.add('is-danger');
            button.setAttribute('role', role);
            if (role === 'menuitemradio') {
                button.setAttribute('aria-checked', String(checked));
            }
            const mark = document.createElement('span');
            mark.className = 'desktop-custom-home-menu-mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = checked ? '✓' : '';
            const text = document.createElement('span');
            text.textContent = label;
            button.append(mark, text);
            button.addEventListener('click', () => {
                closeMenu();
                void handler();
            });
            menu.appendChild(button);
            return button;
        }

        function addMenuSeparator() {
            const separator = document.createElement('div');
            separator.className = 'desktop-custom-home-menu-separator';
            separator.setAttribute('role', 'separator');
            menu.appendChild(separator);
        }

        function openMenuAt(clientX, clientY) {
            if (disposed || busy) return;
            menu.replaceChildren();
            addMenuItem(state.custom ? '更换图片...' : '选择图片...', () => chooseImage());
            if (state.custom) {
                addMenuSeparator();
                for (const mode of FIT_MODES) {
                    addMenuItem(mode.label, () => setFitMode(mode.value), {
                        checked: state.fitMode === mode.value,
                        role: 'menuitemradio'
                    });
                }
                addMenuSeparator();
                addMenuItem('恢复空白页', () => clearImage(), { danger: true });
            }

            const rect = host.getBoundingClientRect();
            menu.hidden = false;
            host.classList.add('is-menu-open');
            const menuWidth = menu.offsetWidth || 176;
            const menuHeight = menu.offsetHeight || 120;
            const maxLeft = Math.max(8, rect.width - menuWidth - 8);
            const maxTop = Math.max(8, rect.height - menuHeight - 8);
            const left = Math.max(8, Math.min(clientX - rect.left, maxLeft));
            const top = Math.max(8, Math.min(clientY - rect.top, maxTop));
            menu.style.left = `${Math.round(left)}px`;
            menu.style.top = `${Math.round(top)}px`;
            menu.querySelector('button')?.focus({ preventScroll: true });
        }

        async function runAction(task, fallbackErrorMessage) {
            if (disposed || busy) return { ...state };
            setBusy(true);
            try {
                const result = await task();
                if (disposed || !result) return { ...state };
                if (result.canceled) return { ...state };
                if (!result.success) {
                    throw new Error(result.msg || fallbackErrorMessage);
                }
                return applyState(result);
            } catch (error) {
                notify?.(error?.message || fallbackErrorMessage);
                return { ...state };
            } finally {
                if (!disposed) setBusy(false);
            }
        }

        function chooseImage() {
            if (!appSettings?.chooseHomeImage) return Promise.resolve({ ...state });
            return runAction(() => appSettings.chooseHomeImage(), '选择主页图片失败');
        }

        async function saveImageFile(file) {
            if (!file) return { ...state };
            if (!isSupportedImageFile(file)) {
                notify?.('请拖入有效的图片文件');
                return { ...state };
            }
            if (file.size <= 0) {
                notify?.('图片文件为空，请选择有效的图片');
                return { ...state };
            }
            if (file.size > MAX_HOME_IMAGE_BYTES) {
                notify?.('图片文件不能超过 50 MB');
                return { ...state };
            }
            if (!appSettings?.saveHomeImage) return { ...state };

            return runAction(async () => {
                await verifyImageFile(file);
                const bytes = new Uint8Array(await file.arrayBuffer());
                return appSettings.saveHomeImage({
                    bytes,
                    fileName: file.name || '',
                    mimeType: file.type || ''
                });
            }, '保存主页图片失败');
        }

        function setFitMode(fitMode) {
            const normalized = normalizeFitMode(fitMode);
            if (!appSettings?.setHomeImageFit) {
                return Promise.resolve(applyState({ ...state, fitMode: normalized }));
            }
            return runAction(() => appSettings.setHomeImageFit(normalized), '更新图片显示模式失败');
        }

        function cycleFitMode() {
            const index = FIT_MODES.findIndex(item => item.value === state.fitMode);
            const next = FIT_MODES[(index + 1) % FIT_MODES.length];
            return setFitMode(next.value);
        }

        function clearImage() {
            if (!state.custom) return Promise.resolve({ ...state });
            if (!appSettings?.clearHomeImage) {
                return Promise.resolve(applyState({ custom: false, url: '', fileName: '', fitMode: state.fitMode }));
            }
            return runAction(() => appSettings.clearHomeImage(), '清除主页图片失败');
        }

        async function refresh() {
            if (disposed || !appSettings?.getHomeImage) return { ...state };
            try {
                const result = await appSettings.getHomeImage();
                if (!disposed && result?.success) return applyState(result);
            } catch (_) {}
            return { ...state };
        }

        function setDragOver(active) {
            host.classList.toggle('is-dragover', active);
            dropHint.hidden = !active;
        }

        const onImageError = () => {
            if (disposed || !state.custom) return;
            notify?.('图片无法正常显示，已恢复空白页');
            void clearImage();
        };

        const onChooseClick = () => {
            closeMenu();
            void chooseImage();
        };
        const onFitClick = () => {
            closeMenu();
            void cycleFitMode();
        };
        const onClearClick = () => {
            closeMenu();
            void clearImage();
        };
        const onPointerMove = () => revealControls();
        const onPointerLeave = () => {
            if (!toolbar.contains(document.activeElement) && !host.classList.contains('is-menu-open')) {
                hideControls();
            }
        };
        const onToolbarFocusIn = () => revealControls();
        const onToolbarFocusOut = () => {
            setTimeout(() => {
                if (!disposed && !toolbar.matches(':hover') && !toolbar.contains(document.activeElement)) {
                    revealControls();
                }
            }, 0);
        };
        const onContextMenu = event => {
            event.preventDefault();
            openMenuAt(event.clientX, event.clientY);
        };
        const onDocumentPointerDown = event => {
            if (!menu.hidden && !menu.contains(event.target)) closeMenu();
        };
        const onDocumentKeyDown = event => {
            if (event.key === 'Escape' && !menu.hidden) {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
            }
        };
        const onDragEnter = event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            dragDepth += 1;
            setDragOver(true);
        };
        const onDragOver = event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        };
        const onDragLeave = event => {
            if (!host.classList.contains('is-dragover')) return;
            event.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) setDragOver(false);
        };
        const onDrop = event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            dragDepth = 0;
            setDragOver(false);
            closeMenu();
            const file = event.dataTransfer?.files?.[0];
            if (file) void saveImageFile(file);
        };
        const onViewChanged = () => {
            closeMenu();
            dragDepth = 0;
            setDragOver(false);
        };
        const onBlur = () => closeMenu();
        const onResize = () => closeMenu();

        image.addEventListener('error', onImageError);
        chooseButton.addEventListener('click', onChooseClick);
        fitButton.addEventListener('click', onFitClick);
        clearButton.addEventListener('click', onClearClick);
        host.addEventListener('pointermove', onPointerMove);
        host.addEventListener('pointerleave', onPointerLeave);
        toolbar.addEventListener('focusin', onToolbarFocusIn);
        toolbar.addEventListener('focusout', onToolbarFocusOut);
        host.addEventListener('contextmenu', onContextMenu);
        host.addEventListener('dragenter', onDragEnter);
        host.addEventListener('dragover', onDragOver);
        host.addEventListener('dragleave', onDragLeave);
        host.addEventListener('drop', onDrop);
        document.addEventListener('pointerdown', onDocumentPointerDown, { capture: true });
        document.addEventListener('keydown', onDocumentKeyDown, { capture: true });
        window.addEventListener('yaya:view-changed', onViewChanged);
        window.addEventListener('blur', onBlur);
        window.addEventListener('resize', onResize);

        renderState();
        emitChange();

        function destroy() {
            disposed = true;
            clearIdleTimer();
            closeMenu();
            image.removeEventListener('error', onImageError);
            chooseButton.removeEventListener('click', onChooseClick);
            fitButton.removeEventListener('click', onFitClick);
            clearButton.removeEventListener('click', onClearClick);
            host.removeEventListener('pointermove', onPointerMove);
            host.removeEventListener('pointerleave', onPointerLeave);
            toolbar.removeEventListener('focusin', onToolbarFocusIn);
            toolbar.removeEventListener('focusout', onToolbarFocusOut);
            host.removeEventListener('contextmenu', onContextMenu);
            host.removeEventListener('dragenter', onDragEnter);
            host.removeEventListener('dragover', onDragOver);
            host.removeEventListener('dragleave', onDragLeave);
            host.removeEventListener('drop', onDrop);
            document.removeEventListener('pointerdown', onDocumentPointerDown, { capture: true });
            document.removeEventListener('keydown', onDocumentKeyDown, { capture: true });
            window.removeEventListener('yaya:view-changed', onViewChanged);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pagehide', destroy);
            if (window.YayaDesktopHomeImage === controller) {
                delete window.YayaDesktopHomeImage;
            }
            host.remove();
        }
        window.addEventListener('pagehide', destroy);

        const controller = {
            FIT_MODES,
            getState: () => ({ ...state }),
            refresh,
            chooseImage,
            saveImageFile,
            setFitMode,
            clearImage,
            destroy
        };
        window.YayaDesktopHomeImage = controller;
        return controller;
    };
})();
