const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildDesktopShell } = require('../src/common/desktop-document');
const { buildRendererEntry } = require('./build-renderer-entry');

function ensureMacElectronBundleSignature() {
    if (process.platform !== 'darwin') return;
    const electronAppPath = path.resolve(__dirname, '../node_modules/electron/dist/Electron.app');
    if (!fs.existsSync(electronAppPath)) return;

    const verifyResult = spawnSync('codesign', ['--verify', '--deep', '--strict', electronAppPath], {
        stdio: 'ignore'
    });
    if (verifyResult.status === 0) return;

    const signResult = spawnSync('codesign', ['--force', '--deep', '--sign', '-', electronAppPath], {
        stdio: 'pipe',
        encoding: 'utf8'
    });
    if (signResult.status === 0) {
        console.log('[desktop:build] Applied ad-hoc bundle signature to Electron.app for macOS Notification Center');
    }
}

buildRendererEntry();
ensureMacElectronBundleSignature();
console.log(`Desktop document built at ${buildDesktopShell()}`);
