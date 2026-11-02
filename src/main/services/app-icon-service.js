const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app, BrowserWindow, dialog, nativeImage } = require('electron');
const { ensureStoragePaths } = require('../../common/storage-paths');
const { reportIgnoredError } = require('../../common/error-utils');
const settingsService = require('./settings-service');

const DEFAULT_APP_ICON_PATH = path.join(__dirname, '../../../icon.png');
const MAX_ICON_FILE_BYTES = 10 * 1024 * 1024;
const PLATFORM_ICON_VERSION = 2;

function createPlatformAppIcon(sourceImage) {
    const isMac = process.platform === 'darwin';
    const canvasSize = isMac ? 1024 : process.platform === 'win32' ? 256 : 512;
    const inset = isMac ? 100 : Math.round(canvasSize / 16);
    const artworkSize = canvasSize - inset * 2;
    let artwork = sourceImage;
    let sourceSize = artwork.getSize();

    if (isMac) {
        const cropSize = Math.min(sourceSize.width, sourceSize.height);
        artwork = artwork.crop({
            x: Math.floor((sourceSize.width - cropSize) / 2),
            y: Math.floor((sourceSize.height - cropSize) / 2),
            width: cropSize,
            height: cropSize
        });
        sourceSize = artwork.getSize();
    }

    const scale = Math.min(artworkSize / sourceSize.width, artworkSize / sourceSize.height);
    const width = Math.max(1, Math.round(sourceSize.width * scale));
    const height = Math.max(1, Math.round(sourceSize.height * scale));
    artwork = artwork.resize({ width, height, quality: 'best' });
    const sourceBitmap = artwork.toBitmap({ scaleFactor: 1 });
    const bitmap = Buffer.alloc(canvasSize * canvasSize * 4);
    const left = Math.floor((canvasSize - width) / 2);
    const top = Math.floor((canvasSize - height) / 2);

    for (let row = 0; row < height; row += 1) {
        const sourceOffset = row * width * 4;
        const targetOffset = ((top + row) * canvasSize + left) * 4;
        sourceBitmap.copy(bitmap, targetOffset, sourceOffset, sourceOffset + width * 4);
    }

    if (isMac) {
        const radius = artworkSize * 0.225;
        const straightHalfSize = artworkSize / 2 - radius;
        for (let row = 0; row < artworkSize; row += 1) {
            for (let column = 0; column < artworkSize; column += 1) {
                const distanceX = Math.max(Math.abs(column + 0.5 - artworkSize / 2) - straightHalfSize, 0);
                const distanceY = Math.max(Math.abs(row + 0.5 - artworkSize / 2) - straightHalfSize, 0);
                const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(distanceX, distanceY)));
                if (coverage === 1) continue;
                const offset = ((inset + row) * canvasSize + inset + column) * 4;
                for (let channel = 0; channel < 4; channel += 1) {
                    bitmap[offset + channel] = Math.round(bitmap[offset + channel] * coverage);
                }
            }
        }
    }

    return nativeImage.createFromBitmap(bitmap, { width: canvasSize, height: canvasSize, scaleFactor: 1 });
}

function createWindowsIconBuffer(image) {
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    const images = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let imageOffset = header.length;

    sizes.forEach((size, index) => {
        const entryOffset = 6 + index * 16;
        header.writeUInt8(size === 256 ? 0 : size, entryOffset);
        header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
        header.writeUInt16LE(1, entryOffset + 4);
        header.writeUInt16LE(32, entryOffset + 6);
        header.writeUInt32LE(images[index].length, entryOffset + 8);
        header.writeUInt32LE(imageOffset, entryOffset + 12);
        imageOffset += images[index].length;
    });

    return Buffer.concat([header, ...images]);
}

function getPlatformAppIconPath(sourcePath, sourceImage, cachePrefix) {
    const { internalDataDir } = ensureStoragePaths();
    const cacheName = `${cachePrefix}-${process.platform}-v${PLATFORM_ICON_VERSION}`;
    const pngPath = path.join(internalDataDir, `${cacheName}.png`);
    const iconPath = process.platform === 'win32'
        ? path.join(internalDataDir, `${cacheName}.ico`)
        : pngPath;
    if (fs.existsSync(iconPath)
        && fs.statSync(iconPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs
        && !nativeImage.createFromPath(iconPath).isEmpty()) {
        return iconPath;
    }

    const image = createPlatformAppIcon(sourceImage);
    fs.writeFileSync(pngPath, image.toPNG());
    if (process.platform === 'win32') {
        fs.writeFileSync(iconPath, createWindowsIconBuffer(image));
    }
    return iconPath;
}

function getCustomAppIconPath() {
    const fileName = settingsService.readSettings().customAppIconFile;
    if (typeof fileName !== 'string' || !/^custom-app-icon-[a-f0-9-]+\.png$/.test(fileName)) {
        return '';
    }
    return path.join(ensureStoragePaths().internalDataDir, fileName);
}

function getAppIconPath(defaultPath = DEFAULT_APP_ICON_PATH) {
    try {
        const customPath = getCustomAppIconPath();
        let sourcePath = defaultPath;
        let sourceImage = null;
        let cachePrefix = 'default-app-icon';

        if (customPath && fs.existsSync(customPath)) {
            const customImage = nativeImage.createFromPath(customPath);
            if (!customImage.isEmpty()) {
                sourcePath = customPath;
                sourceImage = customImage;
                cachePrefix = path.parse(customPath).name;
            }
        }

        if (!sourceImage) sourceImage = nativeImage.createFromPath(sourcePath);
        if (!sourceImage.isEmpty()) return getPlatformAppIconPath(sourcePath, sourceImage, cachePrefix);
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/app-icon-service.js');
    }
    return defaultPath;
}

function hasCustomAppIcon() {
    try {
        const customPath = getCustomAppIconPath();
        return !!customPath
            && fs.existsSync(customPath)
            && !nativeImage.createFromPath(customPath).isEmpty();
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/app-icon-service.js');
        return false;
    }
}

function getAppIconInfo() {
    const iconPath = getAppIconPath();
    const image = nativeImage.createFromPath(iconPath);
    return {
        success: true,
        custom: hasCustomAppIcon(),
        previewUrl: image.isEmpty() ? '' : image.resize({ width: 96, height: 96 }).toDataURL()
    };
}

function applyAppIcon(targetWindow) {
    try {
        const image = nativeImage.createFromPath(getAppIconPath());
        if (image.isEmpty()) return;
        if (process.platform === 'darwin') {
            app.dock?.setIcon(image);
            return;
        }
        const windows = targetWindow ? [targetWindow] : BrowserWindow.getAllWindows();
        for (const window of windows) {
            if (!window.isDestroyed()) window.setIcon(image);
        }
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/app-icon-service.js');
    }
}

function removeSavedIcon(iconPath) {
    if (!iconPath) return;
    try {
        const directory = path.dirname(iconPath);
        const fileName = path.basename(iconPath);
        const cachePrefix = `${path.parse(iconPath).name}-`;
        for (const entry of fs.readdirSync(directory)) {
            if (entry === fileName || (entry.startsWith(cachePrefix) && /\.(png|ico)$/.test(entry))) {
                fs.rmSync(path.join(directory, entry), { force: true });
            }
        }
    } catch (error) {
        reportIgnoredError(error, 'src/main/services/app-icon-service.js');
    }
}

async function chooseAppIcon(parentWindow) {
    try {
        const options = {
            title: '选择应用图标',
            properties: ['openFile'],
            filters: [{
                name: '图标图片',
                extensions: process.platform === 'win32' ? ['png', 'jpg', 'jpeg', 'ico'] : ['png', 'jpg', 'jpeg']
            }]
        };
        const selection = parentWindow && !parentWindow.isDestroyed()
            ? await dialog.showOpenDialog(parentWindow, options)
            : await dialog.showOpenDialog(options);
        if (selection.canceled || !selection.filePaths.length) {
            return { success: true, canceled: true };
        }

        const sourcePath = selection.filePaths[0];
        if (fs.statSync(sourcePath).size > MAX_ICON_FILE_BYTES) {
            return { success: false, msg: '图标图片不能超过 10 MB' };
        }
        let image = nativeImage.createFromPath(sourcePath);
        if (image.isEmpty()) {
            return { success: false, msg: '无法读取这张图片，请选择有效的图标图片' };
        }
        const size = image.getSize();
        if (Math.max(size.width, size.height) > 1024) {
            image = image.resize(size.width >= size.height
                ? { width: 1024, quality: 'best' }
                : { height: 1024, quality: 'best' });
        }

        const previousPath = getCustomAppIconPath();
        const fileName = `custom-app-icon-${randomUUID()}.png`;
        const targetPath = path.join(ensureStoragePaths().internalDataDir, fileName);
        try {
            fs.writeFileSync(targetPath, image.toPNG());
            getPlatformAppIconPath(targetPath, image);
            settingsService.setSettingValue('customAppIconFile', fileName);
        } catch (error) {
            removeSavedIcon(targetPath);
            throw error;
        }
        applyAppIcon();
        removeSavedIcon(previousPath);
        return getAppIconInfo();
    } catch (error) {
        return { success: false, msg: error.message };
    }
}

function resetAppIcon() {
    try {
        const previousPath = getCustomAppIconPath();
        settingsService.removeSettingValue('customAppIconFile');
        applyAppIcon();
        removeSavedIcon(previousPath);
        return getAppIconInfo();
    } catch (error) {
        return { success: false, msg: error.message };
    }
}

module.exports = {
    getAppIconPath,
    hasCustomAppIcon,
    getAppIconInfo,
    applyAppIcon,
    chooseAppIcon,
    resetAppIcon
};