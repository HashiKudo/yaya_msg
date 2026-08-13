(function initYayaRendererUtils() {
    const SAFE_HTML = Symbol('YayaSafeHtml');

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
        rawHtml,
        reportError,
        reportIgnoredError,
        setSafeHtml,
        setText
    });
})();
