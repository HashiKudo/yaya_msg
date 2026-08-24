const fs = require('fs');
const path = require('path');

function copyLinuxDesktopIntegrationFiles(projectDir, appOutDir) {
    const files = [
        {
            source: path.join(projectDir, 'icon.png'),
            target: path.join(appOutDir, 'icon.png'),
            mode: 0o644
        },
        {
            source: path.join(projectDir, 'packaging', 'linux', 'install-to-app-menu.sh'),
            target: path.join(appOutDir, '安装到应用菜单.sh'),
            mode: 0o755
        },
        {
            source: path.join(projectDir, 'packaging', 'linux', 'uninstall.sh'),
            target: path.join(appOutDir, '卸载.sh'),
            mode: 0o755
        }
    ];

    for (const file of files) {
        if (!fs.existsSync(file.source)) {
            throw new Error(`Linux desktop integration file not found: ${file.source}`);
        }
        fs.copyFileSync(file.source, file.target);
        fs.chmodSync(file.target, file.mode);
        console.log(`[afterPack] Copied Linux desktop integration file: ${file.target}`);
    }
}

exports.default = async function copyFfmpeg(context) {
    const platform = context.electronPlatformName || process.platform;
    const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const projectDir = context.appDir || context.packager?.projectDir || process.cwd();
    const sourcePath = path.join(projectDir, 'node_modules', 'ffmpeg-static', ffmpegName);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`FFmpeg binary not found for platform ${platform}: ${sourcePath}`);
    }

    let resourcesDir;

    if (platform === 'darwin') {
        const productFilename = context.packager?.appInfo?.productFilename;
        if (!productFilename) {
            throw new Error('Unable to determine the macOS app bundle name');
        }

        // On macOS appOutDir is the directory containing the .app bundle, not
        // the bundle itself. Copying directly under appOutDir leaves FFmpeg
        // outside the archive produced by electron-builder.
        resourcesDir = path.join(
            context.appOutDir,
            `${productFilename}.app`,
            'Contents',
            'Resources'
        );
    } else {
        resourcesDir = path.join(context.appOutDir, 'resources');
    }

    if (!fs.existsSync(resourcesDir)) {
        throw new Error(`Application resources directory not found: ${resourcesDir}`);
    }

    const targetPath = path.join(resourcesDir, ffmpegName);
    fs.copyFileSync(sourcePath, targetPath);

    if (platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
    }

    if (!fs.existsSync(targetPath)) {
        throw new Error(`Failed to copy FFmpeg to application resources: ${targetPath}`);
    }

    console.log(`[afterPack] Copied ffmpeg into application resources: ${targetPath}`);

    if (platform === 'linux') {
        copyLinuxDesktopIntegrationFiles(projectDir, context.appOutDir);
    }
};
