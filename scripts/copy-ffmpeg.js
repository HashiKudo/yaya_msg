const fs = require('fs');
const path = require('path');

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

    const resourcesDir = platform === 'darwin'
        ? path.join(context.appOutDir, 'Contents', 'Resources')
        : path.join(context.appOutDir, 'resources');

    fs.mkdirSync(resourcesDir, { recursive: true });

    const targetPath = path.join(resourcesDir, ffmpegName);
    fs.copyFileSync(sourcePath, targetPath);

    if (platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
    }

    console.log(`[afterPack] Copied ffmpeg to ${targetPath}`);
};
