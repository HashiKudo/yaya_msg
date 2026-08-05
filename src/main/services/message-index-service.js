const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ensureStoragePaths } = require('../../common/storage-paths');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MESSAGE_INDEX_SCHEMA_VERSION = 2;
let database = null;
let syncPromise = null;
let messageDirectoryWatcher = null;
let messageWatcherTimer = null;
let messageWatcherDirty = false;
let messageWatcherSyncing = false;
let messageWatcherListener = null;

function hasCurrentMessageSchema(db) {
    const columns = db.prepare('PRAGMA table_info(messages)').all();
    if (!columns.length) return true;
    const idColumn = columns.find(column => column.name === 'id');
    return columns.some(column => column.name === 'file_id')
        && String(idColumn?.type || '').toUpperCase() === 'INTEGER';
}

function initializeDatabase(db) {
    if (!hasCurrentMessageSchema(db)) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('PRAGMA journal_mode = DELETE');
        db.exec(`
            DROP TABLE IF EXISTS messages;
            DROP TABLE IF EXISTS message_files;
        `);
        db.exec('VACUUM');
    }

    db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE IF NOT EXISTS message_files (
            file_id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            size INTEGER NOT NULL,
            mtime_ms REAL NOT NULL,
            indexed_size INTEGER NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            member_name TEXT NOT NULL,
            message_key TEXT NOT NULL,
            sort_time INTEGER NOT NULL,
            message_type TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            user_id TEXT NOT NULL,
            search_text TEXT NOT NULL,
            has_image INTEGER NOT NULL DEFAULT 0,
            has_video INTEGER NOT NULL DEFAULT 0,
            has_audio INTEGER NOT NULL DEFAULT 0,
            is_reply INTEGER NOT NULL DEFAULT 0,
            is_live INTEGER NOT NULL DEFAULT 0,
            record_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_file_key ON messages(file_id, message_key);
        CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(sort_time, id);
        CREATE INDEX IF NOT EXISTS idx_messages_member_time ON messages(member_name, sort_time, id);
        CREATE INDEX IF NOT EXISTS idx_messages_type_time ON messages(message_type, sort_time, id);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_name, user_id);
        PRAGMA user_version = ${MESSAGE_INDEX_SCHEMA_VERSION};
    `);
}

function getDatabase() {
    if (database) return database;

    const { messageIndexFile } = ensureStoragePaths();
    database = new DatabaseSync(messageIndexFile);
    initializeDatabase(database);
    return database;
}

async function listJsonlFiles(rootDir) {
    const files = [];

    async function visit(dirPath) {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                await visit(fullPath);
            } else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) {
                files.push(fullPath);
            }
        }
    }

    if (fs.existsSync(rootDir)) await visit(rootDir);
    files.sort((left, right) => left.localeCompare(right));
    return files;
}

function getRecordMessageType(record) {
    const content = record?.content && typeof record.content === 'object' ? record.content : {};
    return String(record?.messageType || record?.msgType || content.messageType || 'TEXT').toUpperCase();
}

function getRecordSearchText(record) {
    const sender = record?.sender && typeof record.sender === 'object' ? record.sender : {};
    let contentText = '';
    try {
        contentText = JSON.stringify(record?.content ?? record?.text ?? '');
    } catch (error) {
        contentText = String(record?.text || '');
    }
    return `${sender.name || record?.senderName || ''} ${contentText}`.toLowerCase();
}

function normalizeRecordForIndex(record, sourcePath) {
    if (!record || typeof record !== 'object' || !record.key) return null;

    const sender = record.sender && typeof record.sender === 'object' ? record.sender : {};
    const messageType = getRecordMessageType(record);
    const memberName = path.basename(path.dirname(sourcePath)) || '未命名成员';
    const messageKey = String(record.key);

    return {
        memberName,
        messageKey,
        sortTime: Number(record.sortTime || record.msgTime || 0),
        messageType,
        senderName: String(sender.name || record.senderName || ''),
        userId: String(sender.userId || record.userId || ''),
        searchText: getRecordSearchText(record),
        hasImage: messageType === 'IMAGE' ? 1 : 0,
        hasVideo: messageType === 'VIDEO' || messageType === 'FLIPCARD_VIDEO' ? 1 : 0,
        hasAudio: ['AUDIO', 'AUDIO_REPLY', 'AUDIO_GIFT_REPLY', 'FLIPCARD_AUDIO'].includes(messageType) ? 1 : 0,
        isReply: messageType.startsWith('FLIPCARD') ? 1 : 0,
        isLive: ['LIVEPUSH', 'SHARE_LIVE'].includes(messageType) ? 1 : 0,
        recordJson: JSON.stringify(record)
    };
}

async function readFileRange(filePath, start, end) {
    const length = Math.max(0, end - start);
    if (!length) return Buffer.alloc(0);

    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function indexFileRecords(db, fileId, filePath, records, replaceSource) {
    const deleteMessages = db.prepare('DELETE FROM messages WHERE file_id = ?');
    const insertMessage = db.prepare(`
        INSERT INTO messages (
            file_id, member_name, message_key, sort_time,
            message_type, sender_name, user_id, search_text,
            has_image, has_video, has_audio, is_reply, is_live, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id, message_key) DO UPDATE SET
            member_name = excluded.member_name,
            sort_time = excluded.sort_time,
            message_type = excluded.message_type,
            sender_name = excluded.sender_name,
            user_id = excluded.user_id,
            search_text = excluded.search_text,
            has_image = excluded.has_image,
            has_video = excluded.has_video,
            has_audio = excluded.has_audio,
            is_reply = excluded.is_reply,
            is_live = excluded.is_live,
            record_json = excluded.record_json
    `);

    if (replaceSource) deleteMessages.run(fileId);
    let indexedCount = 0;
    for (const record of records) {
        const item = normalizeRecordForIndex(record, filePath);
        if (!item) continue;
        insertMessage.run(
            fileId, item.memberName, item.messageKey,
            item.sortTime, item.messageType, item.senderName, item.userId, item.searchText,
            item.hasImage, item.hasVideo, item.hasAudio, item.isReply, item.isLive, item.recordJson
        );
        indexedCount += 1;
    }
    return indexedCount;
}

async function syncMessageIndexInternal() {
    const db = getDatabase();
    const { htmlDir } = ensureStoragePaths();
    const jsonlFiles = await listJsonlFiles(htmlDir);
    const realPaths = new Set(jsonlFiles);
    const knownFiles = db.prepare('SELECT file_id, path FROM message_files').all();
    const deleteMessages = db.prepare('DELETE FROM messages WHERE file_id = ?');
    const deleteFile = db.prepare('DELETE FROM message_files WHERE file_id = ?');
    let removedFiles = 0;
    let removedMessages = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
        for (const row of knownFiles) {
            if (realPaths.has(row.path)) continue;
            const deleteResult = deleteMessages.run(row.file_id);
            removedMessages += Number(deleteResult?.changes) || 0;
            deleteFile.run(row.file_id);
            removedFiles += 1;
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }

    const getFile = db.prepare('SELECT file_id, size, mtime_ms, indexed_size, message_count FROM message_files WHERE path = ?');
    const upsertFile = db.prepare(`
        INSERT INTO message_files(path, size, mtime_ms, indexed_size, message_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            indexed_size = excluded.indexed_size,
            message_count = excluded.message_count
    `);
    let changedFiles = 0;
    let indexedMessages = 0;

    for (const filePath of jsonlFiles) {
        const stat = await fs.promises.stat(filePath);
        const previous = getFile.get(filePath);
        if (previous && previous.size === stat.size && previous.mtime_ms === stat.mtimeMs) continue;

        const appendOnly = !!previous
            && stat.size > previous.size
            && Number(previous.indexed_size) === Number(previous.size);
        const startOffset = appendOnly ? Number(previous.indexed_size) || 0 : 0;
        const buffer = await readFileRange(filePath, startOffset, stat.size);
        const text = buffer.toString('utf8');
        const records = [];
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch (error) {
            }
        }

        db.exec('BEGIN IMMEDIATE');
        try {
            upsertFile.run(
                filePath,
                stat.size,
                stat.mtimeMs,
                stat.size,
                Number(previous?.message_count) || 0
            );
            const fileId = Number(getFile.get(filePath)?.file_id);
            if (!Number.isFinite(fileId)) throw new Error(`无法创建消息文件索引: ${filePath}`);
            const count = indexFileRecords(db, fileId, filePath, records, !appendOnly);
            const totalCount = appendOnly ? (Number(previous.message_count) || 0) + count : count;
            if (!appendOnly && previous) {
                removedMessages += Math.max(0, (Number(previous.message_count) || 0) - count);
            }
            upsertFile.run(filePath, stat.size, stat.mtimeMs, stat.size, totalCount);
            db.exec('COMMIT');
            changedFiles += 1;
            indexedMessages += count;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    let compacted = false;
    if (removedMessages > 0) {
        db.exec('PRAGMA optimize');
        const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count) || 0;
        const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count) || 0;
        const totalMessages = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count) || 0;
        if (totalMessages === 0 || (freePages >= 256 && pageCount > 0 && freePages / pageCount >= 0.15)) {
            db.exec('VACUUM');
            compacted = true;
        }
    }

    return {
        success: true,
        changedFiles: changedFiles + removedFiles,
        indexedMessages,
        removedFiles,
        removedMessages,
        compacted,
        ...getMessageIndexSummary()
    };
}

function syncMessageIndex() {
    if (syncPromise) return syncPromise;
    syncPromise = syncMessageIndexInternal().finally(() => {
        syncPromise = null;
    });
    return syncPromise;
}

async function flushMessageIndexWatcher() {
    if (messageWatcherSyncing) return;
    messageWatcherSyncing = true;

    try {
        // 如果其他入口正在同步，先等它结束，再执行一次新的同步，避免漏掉同步期间发生的删除。
        if (syncPromise) await syncPromise;
        while (messageWatcherDirty) {
            messageWatcherDirty = false;
            const result = await syncMessageIndex();
            if (typeof messageWatcherListener === 'function'
                && (result.changedFiles > 0 || result.removedMessages > 0)) {
                messageWatcherListener(result);
            }
        }
    } catch (error) {
        console.warn('消息文件变化自动同步失败:', error);
    } finally {
        messageWatcherSyncing = false;
        if (messageWatcherDirty) scheduleMessageIndexWatcherSync();
    }
}

function scheduleMessageIndexWatcherSync() {
    messageWatcherDirty = true;
    if (messageWatcherTimer) clearTimeout(messageWatcherTimer);
    messageWatcherTimer = setTimeout(() => {
        messageWatcherTimer = null;
        flushMessageIndexWatcher();
    }, 500);
}

function startMessageIndexWatcher(listener) {
    messageWatcherListener = typeof listener === 'function' ? listener : null;
    if (messageDirectoryWatcher) return;

    const { htmlDir } = ensureStoragePaths();
    try {
        messageDirectoryWatcher = fs.watch(htmlDir, { recursive: true }, () => {
            scheduleMessageIndexWatcherSync();
        });
        messageDirectoryWatcher.on('error', error => {
            console.warn('消息数据目录监听失败:', error);
        });
    } catch (error) {
        console.warn('无法启动消息数据目录监听:', error);
    }
}

function stopMessageIndexWatcher() {
    if (messageWatcherTimer) clearTimeout(messageWatcherTimer);
    messageWatcherTimer = null;
    messageWatcherDirty = false;
    messageWatcherListener = null;
    if (messageDirectoryWatcher) messageDirectoryWatcher.close();
    messageDirectoryWatcher = null;
}

function getMessageIndexSummary() {
    const db = getDatabase();
    const totalCount = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count) || 0;
    const members = db.prepare('SELECT DISTINCT member_name FROM messages ORDER BY member_name COLLATE NOCASE')
        .all()
        .map(row => String(row.member_name || ''))
        .filter(Boolean);
    return { totalCount, members };
}

function escapeLike(value) {
    return String(value || '').replace(/[\\%_]/g, match => `\\${match}`);
}

function buildQueryConditions(filters = {}, includeCursor = true) {
    const where = [];
    const params = [];
    const member = String(filters.member || '').trim();
    if (member && member !== 'all') {
        where.push('member_name = ?');
        params.push(member);
    }

    const query = String(filters.query || '').trim().toLowerCase();
    if (query) {
        const terms = query.split('|').map(term => term.trim()).filter(Boolean);
        if (terms.length) {
            where.push(`(${terms.map(() => "search_text LIKE ? ESCAPE '\\'").join(' OR ')})`);
            terms.forEach(term => params.push(`%${escapeLike(term)}%`));
        }
    }

    const user = String(filters.user || '').trim().toLowerCase();
    if (user) {
        where.push("(LOWER(sender_name) LIKE ? ESCAPE '\\' OR user_id = ?)");
        params.push(`%${escapeLike(user)}%`, user);
    }

    const type = String(filters.type || 'all');
    if (type === 'image') where.push('has_image = 1 AND is_reply = 0');
    if (type === 'video') where.push('has_video = 1 AND is_reply = 0');
    if (type === 'audio') where.push('has_audio = 1 AND is_reply = 0');
    if (type === 'reply') where.push('is_reply = 1');
    if (type === 'live-record') where.push('is_live = 1');
    if (type === 'text') where.push('has_image = 0 AND has_video = 0 AND has_audio = 0 AND is_reply = 0 AND is_live = 0');

    const drilldown = String(filters.drilldown || '');
    if (drilldown === 'gift') where.push("message_type = 'GIFT_TEXT'");
    if (drilldown === 'interaction') {
        where.push("message_type IN ('REPLY', 'GIFTREPLY', 'AUDIO_REPLY', 'AUDIO_GIFT_REPLY')");
    }

    const hasFromTime = filters.fromTime !== null && filters.fromTime !== undefined && filters.fromTime !== '';
    const hasToTime = filters.toTime !== null && filters.toTime !== undefined && filters.toTime !== '';
    const fromTime = hasFromTime ? Number(filters.fromTime) : Number.NaN;
    const toTime = hasToTime ? Number(filters.toTime) : Number.NaN;
    if (hasFromTime && Number.isFinite(fromTime)) {
        where.push('sort_time >= ?');
        params.push(fromTime);
    }
    if (hasToTime && Number.isFinite(toTime)) {
        where.push('sort_time <= ?');
        params.push(toTime);
    }

    const sortOrder = String(filters.sortOrder || 'desc') === 'asc' ? 'asc' : 'desc';
    const cursor = filters.cursor && typeof filters.cursor === 'object' ? filters.cursor : null;
    if (includeCursor && cursor && Number.isFinite(Number(cursor.sortTime)) && Number.isFinite(Number(cursor.id))) {
        const comparator = sortOrder === 'asc' ? '>' : '<';
        where.push(`(sort_time ${comparator} ? OR (sort_time = ? AND id ${comparator} ?))`);
        params.push(Number(cursor.sortTime), Number(cursor.sortTime), Number(cursor.id));
    }

    return {
        sql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        params,
        sortOrder
    };
}

function queryMessageIndexPage(filters = {}) {
    const db = getDatabase();
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(filters.limit) || DEFAULT_PAGE_SIZE)));
    const query = buildQueryConditions(filters, true);
    const countQuery = buildQueryConditions(filters, false);
    const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`
        SELECT messages.id, message_files.path AS source_path, member_name, sort_time, record_json
        FROM messages
        JOIN message_files ON message_files.file_id = messages.file_id
        ${query.sql}
        ORDER BY sort_time ${direction}, messages.id ${direction}
        LIMIT ?
    `).all(...query.params, limit + 1);
    const totalCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM messages ${countQuery.sql}`).get(...countQuery.params)?.count) || 0;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records = pageRows.map(row => {
        const record = JSON.parse(row.record_json);
        return {
            ...record,
            indexId: row.id,
            sourcePath: row.source_path,
            fileName: path.basename(row.source_path),
            memberName: row.member_name
        };
    });
    const lastRow = pageRows[pageRows.length - 1];

    return {
        records,
        hasMore,
        totalCount,
        limit,
        nextCursor: lastRow ? { sortTime: Number(lastRow.sort_time), id: Number(lastRow.id) } : null
    };
}

function parseIndexedRecord(recordJson) {
    try {
        const record = JSON.parse(recordJson);
        return record && typeof record === 'object' ? record : {};
    } catch (error) {
        return {};
    }
}

function getIndexedSender(record, fallback = {}) {
    const sender = record?.sender && typeof record.sender === 'object' ? record.sender : {};
    return {
        name: String(sender.name || record?.senderName || fallback.senderName || ''),
        userId: String(sender.userId || record?.userId || fallback.userId || ''),
        avatarUrl: String(sender.avatarUrl || record?.avatarUrl || record?.avatar || '')
    };
}

function getIndexedContent(record) {
    return record?.content && typeof record.content === 'object' ? record.content : {};
}

function getIndexedContentPreview(record) {
    const content = getIndexedContent(record);
    const candidates = [
        content.text,
        content.replyInfo?.text,
        content.giftReplyInfo?.text,
        content.livePushInfo?.liveTitle,
        content.shareInfo?.shareTitle,
        record?.text
    ];
    const direct = candidates.find(value => value !== null && value !== undefined && String(value).trim());
    if (direct !== undefined) return String(direct).trim();
    const type = getRecordMessageType(record);
    const labels = {
        IMAGE: '图片',
        EXPRESSIMAGE: '表情',
        VIDEO: '视频',
        AUDIO: '语音',
        FLIPCARD: '翻牌',
        FLIPCARD_AUDIO: '语音翻牌',
        FLIPCARD_VIDEO: '视频翻牌',
        LIVEPUSH: '直播',
        SHARE_LIVE: '直播分享'
    };
    return labels[type] || type || '消息';
}

function appendAnalysisCondition(query, condition) {
    return query.sql
        ? `${query.sql} AND ${condition}`
        : `WHERE ${condition}`;
}

function queryDateAnalysis(db, payload) {
    const filters = payload?.filters || {};
    const query = buildQueryConditions({ member: filters.member }, false);
    const memberNames = Array.from(new Set(Array.isArray(payload?.memberNames) ? payload.memberNames.map(String).filter(Boolean) : [])).slice(0, 2000);
    const memberIds = Array.from(new Set(Array.isArray(payload?.memberIds) ? payload.memberIds.map(String).filter(Boolean) : [])).slice(0, 2000);
    const memberChecks = ['is_reply = 1', 'sender_name = member_name'];
    const memberParams = [];
    if (memberNames.length) {
        memberChecks.push(`sender_name IN (${memberNames.map(() => '?').join(', ')})`);
        memberParams.push(...memberNames);
    }
    if (memberIds.length) {
        memberChecks.push(`user_id IN (${memberIds.map(() => '?').join(', ')})`);
        memberParams.push(...memberIds);
    }

    const rows = db.prepare(`
        SELECT
            strftime('%Y-%m-%d', sort_time / 1000, 'unixepoch', 'localtime') AS date,
            COUNT(*) AS count,
            SUM(CASE WHEN ${memberChecks.join(' OR ')} THEN 1 ELSE 0 END) AS member_count
        FROM messages
        ${query.sql}
        GROUP BY date
        ORDER BY date DESC
    `).all(...memberParams, ...query.params);

    return {
        items: rows.filter(row => row.date).map(row => ({
            date: String(row.date),
            count: Number(row.count) || 0,
            memberCount: Number(row.member_count) || 0
        }))
    };
}

function querySpeechAnalysis(db, payload) {
    const query = buildQueryConditions(payload?.filters || {}, false);
    const whereSql = appendAnalysisCondition(query, "message_type <> 'GIFT_TEXT' AND sender_name <> ''");
    const rows = db.prepare(`
        WITH ranked AS (
            SELECT
                sender_name,
                user_id,
                sort_time,
                record_json,
                COUNT(*) OVER (PARTITION BY COALESCE(NULLIF(user_id, ''), sender_name)) AS message_count,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(NULLIF(user_id, ''), sender_name)
                    ORDER BY sort_time DESC, id DESC
                ) AS row_number
            FROM messages
            ${whereSql}
        )
        SELECT sender_name, user_id, sort_time, record_json, message_count
        FROM ranked
        WHERE row_number = 1
        ORDER BY message_count DESC, sort_time DESC
    `).all(...query.params);

    const items = rows.map(row => {
        const record = parseIndexedRecord(row.record_json);
        const sender = getIndexedSender(record, { senderName: row.sender_name, userId: row.user_id });
        return {
            id: String(row.user_id || row.sender_name || ''),
            realUserId: String(row.user_id || ''),
            name: sender.name || String(row.sender_name || '未知用户'),
            count: Number(row.message_count) || 0,
            avatarUrl: sender.avatarUrl,
            lastText: getIndexedContentPreview(record),
            latestTime: Number(row.sort_time) || 0
        };
    });

    return {
        items,
        totalMessages: items.reduce((sum, item) => sum + item.count, 0)
    };
}

function queryGiftAnalysis(db, payload) {
    const query = buildQueryConditions(payload?.filters || {}, false);
    const whereSql = appendAnalysisCondition(query, "message_type = 'GIFT_TEXT'");
    const rows = db.prepare(`
        SELECT sender_name, user_id, sort_time, record_json
        FROM messages
        ${whereSql}
        ORDER BY sort_time ASC, id ASC
    `).all(...query.params);
    const giftPrices = new Map();
    (Array.isArray(payload?.giftPrices) ? payload.giftPrices : []).slice(0, 10000).forEach(gift => {
        const cost = Number(gift?.cost) || 0;
        if (gift?.id !== null && gift?.id !== undefined) giftPrices.set(`id:${gift.id}`, cost);
        if (gift?.name) giftPrices.set(`name:${gift.name}`, cost);
    });
    const users = new Map();
    let totalRevenue = 0;

    rows.forEach(row => {
        const record = parseIndexedRecord(row.record_json);
        const sender = getIndexedSender(record, { senderName: row.sender_name, userId: row.user_id });
        const content = getIndexedContent(record);
        const info = content.giftInfo && typeof content.giftInfo === 'object' ? content.giftInfo : content;
        const giftName = String(info.giftName || info.name || '未知礼物');
        const giftCount = Number(info.giftNum || info.num || info.count || 1) || 1;
        const unitCost = Number(info.money || info.cost)
            || giftPrices.get(`id:${info.giftId || info.id}`)
            || giftPrices.get(`name:${giftName}`)
            || 0;
        const key = String(row.user_id || row.sender_name || '未知用户');
        if (!users.has(key)) {
            users.set(key, {
                id: key,
                realUserId: String(row.user_id || ''),
                name: sender.name || String(row.sender_name || '未知用户'),
                totalCost: 0,
                totalCount: 0,
                avatarUrl: sender.avatarUrl,
                latestTime: Number(row.sort_time) || 0
            });
        }
        const user = users.get(key);
        user.totalCost += unitCost * giftCount;
        user.totalCount += giftCount;
        totalRevenue += unitCost * giftCount;
        if (Number(row.sort_time) >= user.latestTime) {
            user.name = sender.name || user.name;
            user.avatarUrl = sender.avatarUrl || user.avatarUrl;
            user.latestTime = Number(row.sort_time) || user.latestTime;
        }
    });

    return {
        items: Array.from(users.values()).sort((left, right) => right.totalCost - left.totalCost),
        totalRevenue
    };
}

function getReplyTargetName(record) {
    const content = getIndexedContent(record);
    const info = content.replyInfo || content.giftReplyInfo
        || content.bodys?.replyInfo || content.bodys?.giftReplyInfo || {};
    return String(info.replyName || '').trim();
}

function queryInteractionAnalysis(db, payload) {
    const filters = payload?.filters || {};
    const memberQuery = buildQueryConditions({ member: filters.member }, false);
    const aliasRows = db.prepare(`
        SELECT sender_name, user_id, MAX(sort_time) AS latest_time
        FROM messages
        WHERE sender_name <> ''
        GROUP BY sender_name, user_id
    `).all();
    const latestRows = db.prepare(`
        WITH ranked AS (
            SELECT sender_name, user_id, sort_time, record_json,
                ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(NULLIF(user_id, ''), sender_name)
                    ORDER BY sort_time DESC, id DESC
                ) AS row_number
            FROM messages
            WHERE sender_name <> ''
        )
        SELECT sender_name, user_id, sort_time, record_json
        FROM ranked
        WHERE row_number = 1
    `).all();
    const replyWhere = appendAnalysisCondition(memberQuery, "message_type IN ('REPLY', 'GIFTREPLY', 'AUDIO_REPLY', 'AUDIO_GIFT_REPLY')");
    const replyRows = db.prepare(`
        SELECT record_json
        FROM messages
        ${replyWhere}
    `).all(...memberQuery.params);

    const nameToId = new Map();
    aliasRows.forEach(row => {
        if (row.sender_name && row.user_id) nameToId.set(String(row.sender_name), String(row.user_id));
    });
    const latestById = new Map();
    latestRows.forEach(row => {
        const record = parseIndexedRecord(row.record_json);
        const sender = getIndexedSender(record, { senderName: row.sender_name, userId: row.user_id });
        latestById.set(String(row.user_id || row.sender_name), {
            name: sender.name || String(row.sender_name || ''),
            avatarUrl: sender.avatarUrl
        });
    });

    const stats = new Map();
    let totalInteractions = 0;
    replyRows.forEach(row => {
        const rawName = getReplyTargetName(parseIndexedRecord(row.record_json));
        if (!rawName) return;
        const realId = nameToId.get(rawName) || '';
        const key = realId || rawName;
        const latest = latestById.get(key) || {};
        if (!stats.has(key)) {
            stats.set(key, {
                id: key,
                realId,
                name: latest.name || rawName,
                count: 0,
                avatarUrl: latest.avatarUrl || '',
                aliases: []
            });
        }
        const item = stats.get(key);
        if (!item.aliases.includes(rawName)) item.aliases.push(rawName);
        if (item.name && !item.aliases.includes(item.name)) item.aliases.push(item.name);
        item.count += 1;
        totalInteractions += 1;
    });

    return {
        items: Array.from(stats.values()).sort((left, right) => right.count - left.count),
        totalInteractions
    };
}

function queryMessageAnalysis(payload = {}) {
    const db = getDatabase();
    const kind = String(payload.kind || '');
    if (kind === 'date') return queryDateAnalysis(db, payload);
    if (kind === 'speech') return querySpeechAnalysis(db, payload);
    if (kind === 'gift') return queryGiftAnalysis(db, payload);
    if (kind === 'interaction') return queryInteractionAnalysis(db, payload);
    throw new Error(`不支持的消息统计类型: ${kind || 'unknown'}`);
}

function getAllMessageIndexRecords() {
    const db = getDatabase();
    return db.prepare(`
        SELECT messages.id, message_files.path AS source_path, member_name, record_json
        FROM messages
        JOIN message_files ON message_files.file_id = messages.file_id
        ORDER BY sort_time ASC, messages.id ASC
    `).all().map(row => ({
        ...JSON.parse(row.record_json),
        indexId: row.id,
        sourcePath: row.source_path,
        fileName: path.basename(row.source_path),
        memberName: row.member_name
    }));
}

function closeMessageIndex() {
    stopMessageIndexWatcher();
    if (!database) return;
    database.close();
    database = null;
}

module.exports = {
    syncMessageIndex,
    startMessageIndexWatcher,
    stopMessageIndexWatcher,
    getMessageIndexSummary,
    queryMessageIndexPage,
    queryMessageAnalysis,
    getAllMessageIndexRecords,
    closeMessageIndex
};
