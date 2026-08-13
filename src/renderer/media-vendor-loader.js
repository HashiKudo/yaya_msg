import * as mpegtsModule from 'mpegts.js';
import Hls from 'hls.js';
import Artplayer from 'artplayer';
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku';
import DPlayer from 'dplayer';
import * as pinyinPro from 'pinyin-pro';

// This file is an esbuild entry point. scripts/build-web.js turns it into the
// classic browser bundle loaded by index.html, so Electron and Web never fetch
// executable player/search code from a CDN at runtime.
const mpegts = mpegtsModule.default || mpegtsModule;

window.mpegts = mpegts;
window.Hls = Hls;
window.Artplayer = Artplayer;
window.artplayerPluginDanmuku = artplayerPluginDanmuku;
window.DPlayer = DPlayer;
window.pinyinPro = pinyinPro;
