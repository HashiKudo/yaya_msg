const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');
const { dialog } = require('electron');
const { ensureStoragePaths } = require('../../common/storage-paths');
const { reportIgnoredError } = require('../../common/error-utils');
const settingsService = require('./settings-service');

const CUSTOM_HOME_IMAGE_PREFIX = 'custom-home-image-';
const CUSTOM_HOME_IMAGE_FILE_RE = /^custom-home-image-[a-f0-9-]+\.[a-z0-9]{1,8}$/i;
const MAX_HOME_IMAGE_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.ico']);
const DIALOG_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico'];
const VALID_FIT_MODES = new Set(['contain', 'cover', 'original']);

const MIME_TO_EXT = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/jpg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
    ['image/bmp', '.bmp'],
    ['image/x-ms-bmp', '.bmp'],
    ['image/svg+xml', '.svg'],
    ['image/avif', '.avif'],
    ['image/x-icon', '.ico'],
    ['image/vnd.microsoft.icon', '.ico']
]);

function normalizeFitMode(value) {
    return VALID_FIT_MODES.has(value) ? value : 'contain';
}

function sanitizeDisplayFileName(fileName) {
    return path.basename(String(fileName || ''))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255);
}

function resolveImageExtension(fileName = '', mimeType = '') {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
        return ext;
    }

    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    return MIME_TO_EXT.get(normalizedMime) || '';
}

function getManagedHomeImageFileName(settings = settingsService.readSettings()) {
    const fileName = settings.customHomeImageFile;
    if (typeof fileName !== 'string' || !CUSTOM_HOME_IMAGE_FILE_RE.test(fileName)) {
        return '';
    }
    return fileName;
}

function removeOtherHomeImageFiles(exceptFileName = '') {
    try {
        const { internalDataDir } = ensureStoragePaths();
        for (const entry of fs.readdirSync(internalDataDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (!entry.name.startsWith(CUSTOM_HOME_IMAGE_PREFIX)) continue;
            if (exceptFileName && entry.name === exceptFileName) continue;
            fs.rmSync(path.join(internalDataDir, entry.name), { force: true });
        }
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/home-image-service.js');
    }
}

function getHomeImageInfo() {
    const settings = settingsService.readSettings();
    const fitMode = normalizeFitMode(settings.desktopHomeImageFit);
    const fileName = getManagedHomeImageFileName(settings);
    if (!fileName) {
        return {
            success: true,
            custom: false,
            url: '',
            fileName: '',
            fitMode
        };
    }

    const { internalDataDir } = ensureStoragePaths();
    const filePath = path.join(internalDataDir, fileName);
    if (!fs.existsSync(filePath)) {
        settingsService.updateSettings((current) => {
            delete current.customHomeImageFile;
            delete current.customHomeImageName;
            return current;
        });
        return {
            success: true,
            custom: false,
            url: '',
            fileName: '',
            fitMode
        };
    }

    const mtimeMs = Math.floor(fs.statSync(filePath).mtimeMs);
    return {
        success: true,
        custom: true,
        url: `${pathToFileURL(filePath).href}?v=${mtimeMs}`,
        fileName: sanitizeDisplayFileName(settings.customHomeImageName) || '自定义图片',
        fitMode
    };
}

function persistHomeImageBuffer(buffer, ext, displayName) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('图片文件为空，请选择有效的图片');
    }
    if (buffer.length > MAX_HOME_IMAGE_BYTES) {
        throw new Error('图片文件不能超过 50 MB');
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error('不支持的图片格式');
    }

    const { internalDataDir } = ensureStoragePaths();
    const targetFileName = `${CUSTOM_HOME_IMAGE_PREFIX}${randomUUID()}${ext}`;
    const targetPath = path.join(internalDataDir, targetFileName);
    const safeDisplayName = sanitizeDisplayFileName(displayName) || `自定义图片${ext}`;

    try {
        fs.writeFileSync(targetPath, buffer);
        settingsService.updateSettings((current) => {
            current.customHomeImageFile = targetFileName;
            current.customHomeImageName = safeDisplayName;
            return current;
        });
    } catch (error) {
        try {
            fs.rmSync(targetPath, { force: true });
        } catch (cleanupError) {
            reportIgnoredError(cleanupError, 'src/main/services/home-image-service.js');
        }
        throw error;
    }

    removeOtherHomeImageFiles(targetFileName);
    return getHomeImageInfo();
}

async function chooseHomeImage(parentWindow) {
    try {
        const options = {
            title: '选择主页展示图片',
            properties: ['openFile'],
            filters: [{
                name: '图片文件',
                extensions: DIALOG_EXTENSIONS
            }]
        };
        const selection = parentWindow && !parentWindow.isDestroyed()
            ? await dialog.showOpenDialog(parentWindow, options)
            : await dialog.showOpenDialog(options);
        if (selection.canceled || !selection.filePaths.length) {
            return { success: true, canceled: true };
        }

        const sourcePath = selection.filePaths[0];
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) {
            return { success: false, msg: '请选择有效的图片文件' };
        }
        if (stat.size <= 0) {
            return { success: false, msg: '图片文件为空，请选择有效的图片' };
        }
        if (stat.size > MAX_HOME_IMAGE_BYTES) {
            return { success: false, msg: '图片文件不能超过 50 MB' };
        }

        const ext = resolveImageExtension(sourcePath);
        if (!ext) {
            return { success: false, msg: '不支持的图片格式' };
        }

        const buffer = fs.readFileSync(sourcePath);
        return persistHomeImageBuffer(buffer, ext, path.basename(sourcePath));
    } catch (error) {
        return { success: false, msg: error.message || '设置主页图片失败' };
    }
}

function saveHomeImage(payload = {}) {
    try {
        const { bytes, fileName, mimeType } = payload || {};
        if (!bytes) {
            return { success: false, msg: '未接收到图片数据' };
        }

        const buffer = Buffer.isBuffer(bytes)
            ? bytes
            : bytes instanceof ArrayBuffer
                ? Buffer.from(bytes)
                : ArrayBuffer.isView(bytes)
                    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                    : null;
        if (!buffer) {
            return { success: false, msg: '无效的图片数据' };
        }

        const ext = resolveImageExtension(fileName, mimeType);
        if (!ext) {
            return { success: false, msg: '不支持的图片格式' };
        }

        return persistHomeImageBuffer(buffer, ext, fileName);
    } catch (error) {
        return { success: false, msg: error.message || '保存主页图片失败' };
    }
}

function setHomeImageFitMode(fitMode) {
    try {
        const normalized = normalizeFitMode(fitMode);
        settingsService.setSettingValue('desktopHomeImageFit', normalized);
        return getHomeImageInfo();
    } catch (error) {
        return { success: false, msg: error.message || '保存图片显示模式失败' };
    }
}

function clearHomeImage() {
    try {
        settingsService.updateSettings((current) => {
            delete current.customHomeImageFile;
            delete current.customHomeImageName;
            return current;
        });
        removeOtherHomeImageFiles();
        return getHomeImageInfo();
    } catch (error) {
        return { success: false, msg: error.message || '清除主页图片失败' };
    }
}

module.exports = {
    CUSTOM_HOME_IMAGE_FILE_RE,
    VALID_FIT_MODES,
    normalizeFitMode,
    getHomeImageInfo,
    chooseHomeImage,
    saveHomeImage,
    setHomeImageFitMode,
    clearHomeImage
};
