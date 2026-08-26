const fs = require('fs');
const path = require('path');

function copyLinuxIcon(projectDir, appOutDir) {
    const sourcePath = path.join(projectDir, 'icon.png');
    const targetPath = path.join(appOutDir, 'icon.png');
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Linux icon not found: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o644);
    console.log(`[afterPack] Copied Linux icon: ${targetPath}`);
}

exports.default = async function copyFfmpeg(context) {
    const platform = context.electronPlatformName || process.platform;
    const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const projectDir = context.appDir || context.packager?.projectDir || process.cwd();
    const sourcePath = path.join(projectDir, 'node_modules', 'ffmpeg-static', ffmpegName);

    if (!fs.existsSync(sourcePath)) {
        console.log(`[afterPack] FFmpeg binary not found for platform ${platform}. Attempting to download...`);
        const { spawnSync } = require('child_process');
        const env = { ...process.env, npm_config_platform: platform };
        const archMap = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };
        env.npm_config_arch = context.arch !== undefined ? archMap[context.arch] : process.arch;
        
        const result = spawnSync('node', ['install.js'], {
            cwd: path.join(projectDir, 'node_modules', 'ffmpeg-static'),
            env,
            stdio: 'inherit'
        });

        if (result.status !== 0 || !fs.existsSync(sourcePath)) {
            throw new Error(`FFmpeg binary not found for platform ${platform}: ${sourcePath} (Download failed)`);
        }
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
        copyLinuxIcon(projectDir, context.appOutDir);
    }
};
