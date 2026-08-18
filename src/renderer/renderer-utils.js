(function initYayaRendererUtils() {
    const SAFE_HTML = Symbol('YayaSafeHtml');

    const QQ_EMOJI_MAP = Object.freeze({
        '[微笑]': '🙂',
        '[撇嘴]': '😕',
        '[色]': '😍',
        '[发呆]': '😐',
        '[得意]': '😎',
        '[流泪]': '😢',
        '[害羞]': '😊',
        '[闭嘴]': '🤐',
        '[睡]': '😴',
        '[大哭]': '😭',
        '[尴尬]': '😅',
        '[发怒]': '😡',
        '[调皮]': '😜',
        '[呲牙]': '😁',
        '[龇牙]': '😁',
        '[惊讶]': '😮',
        '[难过]': '😞',
        '[酷]': '😎',
        '[囧]': '😣',
        '[冷汗]': '😰',
        '[抓狂]': '😫',
        '[吐]': '🤮',
        '[偷笑]': '🤭',
        '[愉快]': '😊',
        '[可爱]': '😊',
        '[白眼]': '🙄',
        '[傲慢]': '😤',
        '[饥饿]': '🤤',
        '[困]': '😪',
        '[惊恐]': '😱',
        '[流汗]': '😓',
        '[憨笑]': '😄',
        '[悠闲]': '😌',
        '[大兵]': '🫡',
        '[奋斗]': '💪',
        '[咒骂]': '🤬',
        '[疑问]': '❓',
        '[嘘]': '🤫',
        '[晕]': '😵',
        '[疯了]': '🤪',
        '[折磨]': '🤪',
        '[衰]': '😞',
        '[骷髅]': '💀',
        '[敲打]': '🔨',
        '[再见]': '👋',
        '[擦汗]': '😓',
        '[抠鼻]': '👃',
        '[鼓掌]': '👏',
        '[糗大了]': '😳',
        '[坏笑]': '😏',
        '[左哼哼]': '😤',
        '[右哼哼]': '😤',
        '[哈欠]': '🥱',
        '[鄙视]': '👎',
        '[委屈]': '🥺',
        '[快哭了]': '🥹',
        '[阴险]': '😈',
        '[亲亲]': '😘',
        '[吓]': '😨',
        '[可怜]': '🥺',
        '[菜刀]': '🔪',
        '[西瓜]': '🍉',
        '[啤酒]': '🍺',
        '[篮球]': '🏀',
        '[乒乓]': '🏓',
        '[咖啡]': '☕',
        '[饭]': '🍚',
        '[猪头]': '🐷',
        '[玫瑰]': '🌹',
        '[凋谢]': '🥀',
        '[嘴唇]': '💋',
        '[示爱]': '💋',
        '[爱心]': '❤️',
        '[心碎]': '💔',
        '[蛋糕]': '🎂',
        '[闪电]': '⚡',
        '[炸弹]': '💣',
        '[刀]': '🔪',
        '[足球]': '⚽',
        '[瓢虫]': '🐞',
        '[便便]': '💩',
        '[月亮]': '🌙',
        '[太阳]': '☀️',
        '[礼物]': '🎁',
        '[拥抱]': '🤗',
        '[强]': '👍',
        '[弱]': '👎',
        '[握手]': '🤝',
        '[胜利]': '✌️',
        '[抱拳]': '🙏',
        '[勾引]': '☝️',
        '[拳头]': '✊',
        '[差劲]': '👎',
        '[爱你]': '🤟',
        '[NO]': '🙅',
        '[OK]': '👌',
        '[爱情]': '💞',
        '[飞吻]': '😘',
        '[跳跳]': '💃',
        '[发抖]': '🥶',
        '[怄火]': '😡',
        '[转圈]': '💫',
        '[磕头]': '🙇',
        '[回头]': '🔙',
        '[跳绳]': '🏃',
        '[投降]': '🏳️',
        '[挥手]': '🙋',
        '[激动]': '🤩',
        '[乱舞]': '🕺',
        '[街舞]': '🕺',
        '[献吻]': '😽',
        '[左太极]': '☯️',
        '[右太极]': '☯️',
        '[生病]': '😷',
        '[大笑]': '😆'
    });

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[character]));
    }

    function escapeJsString(value) {
        return String(value == null ? '' : value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r?\n/g, ' ');
    }

    function replaceTencentEmoji(value) {
        const text = String(value == null ? '' : value);
        if (!text) return text;
        return text.replace(/\[[^\]]+\]/g, match => QQ_EMOJI_MAP[match] || match);
    }

    function normalizeUrl(value, options = {}) {
        const raw = String(value || '').trim();
        if (!raw) return options.fallback || '';

        try {
            const url = new URL(raw, options.baseUrl || window.location.href);
            const allowedProtocols = options.allowedProtocols || ['https:', 'http:'];
            return allowedProtocols.includes(url.protocol) ? url.toString() : (options.fallback || '');
        } catch (error) {
            reportIgnoredError(error, 'normalizeUrl');
            return options.fallback || '';
        }
    }

    function normalize48Url(value, sourceOrigin = 'https://source3.48.cn') {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw)) return normalizeUrl(raw);
        if (raw.includes('48.cn')) return normalizeUrl(`https://${raw.replace(/^\/+/, '')}`);
        return normalizeUrl(raw.startsWith('/') ? `${sourceOrigin}${raw}` : `${sourceOrigin}/${raw}`);
    }

    function getErrorMessage(error, fallback = '未知错误') {
        if (error instanceof Error && error.message) return error.message;
        const message = String(error == null ? '' : error).trim();
        return message || fallback;
    }

    function reportError(context, error, level = 'error') {
        const entry = {
            event: 'renderer_error',
            context: String(context || 'unknown'),
            error: getErrorMessage(error)
        };
        const logger = level === 'debug' ? console.debug : level === 'warn' ? console.warn : console.error;
        logger(entry);
        return entry.error;
    }

    function reportIgnoredError(error, context = 'ignored_operation') {
        return reportError(context, error, 'debug');
    }

    function parseJson(value, fallbackValue = null, context = 'parse_json') {
        try {
            return JSON.parse(String(value || ''));
        } catch (error) {
            reportIgnoredError(error, context);
            return fallbackValue;
        }
    }

    function rawHtml(value) {
        return { [SAFE_HTML]: true, value: String(value == null ? '' : value) };
    }

    function html(strings, ...values) {
        const value = strings.reduce((result, part, index) => {
            if (index >= values.length) return result + part;
            const interpolation = values[index];
            const rendered = interpolation && interpolation[SAFE_HTML]
                ? interpolation.value
                : escapeHtml(interpolation);
            return result + part + rendered;
        }, '');
        return rawHtml(value);
    }

    function setSafeHtml(element, safeValue) {
        if (!element) return null;
        if (!safeValue || safeValue[SAFE_HTML] !== true) {
            throw new TypeError('setSafeHtml requires a value created by html() or rawHtml()');
        }
        element.innerHTML = safeValue.value;
        return element;
    }

    function setText(element, value) {
        if (element) element.textContent = String(value == null ? '' : value);
        return element;
    }

    window.YayaRendererUtils = Object.freeze({
        escapeHtml,
        escapeJsString,
        getErrorMessage,
        html,
        normalize48Url,
        normalizeUrl,
        parseJson,
        QQ_EMOJI_MAP,
        rawHtml,
        replaceTencentEmoji,
        reportError,
        reportIgnoredError,
        setSafeHtml,
        setText
    });
})();
