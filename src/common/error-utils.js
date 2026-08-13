'use strict';

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function reportIgnoredError(error, context, logger = console.debug) {
    if (typeof logger !== 'function') return;
    logger.call(console, {
        level: 'debug',
        event: 'ignored_error',
        context: String(context || 'unknown'),
        error: getErrorMessage(error)
    });
}

module.exports = {
    getErrorMessage,
    reportIgnoredError
};
