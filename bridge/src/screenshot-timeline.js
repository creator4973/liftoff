// @ts-check
/**
 * Persistent screenshot timeline for the mobile workspace.
 *
 * Stores timeline screenshots on disk, keeps a lightweight manifest, and
 * optionally captures new screenshots on a background interval when the
 * observed snapshot hash changes.
 *
 * @module screenshot-timeline
 */

import { promises as fs } from 'fs';
import { basename, extname, join } from 'path';
import {
    PROJECT_ROOT,
    getScreenshotEnabled,
    getScreenshotInterval,
    getScreenshotMax
} from './config.js';
import { hashString } from './utils/hash.js';

const SCREENSHOT_DIR = join(PROJECT_ROOT, 'data', 'screenshots');
const INDEX_FILE = join(SCREENSHOT_DIR, 'timeline.json');
const RELATIVE_DIRECTORY = 'data/screenshots';

function normalizeMimeType(value = 'image/jpeg') {
    const lower = String(value || 'image/jpeg').toLowerCase();
    if (lower.includes('png')) return 'image/png';
    if (lower.includes('webp')) return 'image/webp';
    return 'image/jpeg';
}

function inferExtension(mimeType) {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/webp') return '.webp';
    return '.jpg';
}

function inferMimeType(filename) {
    const extension = extname(filename).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    return 'image/jpeg';
}

function isImageFile(filename) {
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(filename).toLowerCase());
}

function safeTimestamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function formatBytes(bytes) {
    const size = Number(bytes || 0);
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function sortEntries(entries) {
    return entries
        .slice()
        .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt));
}

function toPublicEntry(entry) {
    return {
        ...entry,
        url: `/api/timeline/${encodeURIComponent(entry.filename)}`,
        sizeLabel: formatBytes(entry.sizeBytes)
    };
}

async function fileExists(pathname) {
    try {
        await fs.access(pathname);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * @typedef {object} TimelineEntry
 * @property {string} filename
 * @property {string} capturedAt
 * @property {string} reason
 * @property {number} sizeBytes
 * @property {string} mimeType
 * @property {string} [snapshotHash]
 * @property {string} [contentHash]
 */

export class ScreenshotTimeline {
    constructor(options = {}) {
        this.enabled = options.enabled ?? getScreenshotEnabled();
        this.intervalMs = options.intervalMs ?? getScreenshotInterval();
        this.maxEntries = options.maxEntries ?? getScreenshotMax();
        this.directory = options.directory ?? SCREENSHOT_DIR;
        this.indexPath = options.indexPath ?? INDEX_FILE;
        this.captureScreenshot = options.captureScreenshot ?? null;
        this.getSnapshotHash = options.getSnapshotHash ?? (() => '');
        this.entries = [];
        this.listeners = new Set();
        this.initialized = false;
        this.timer = null;
        this.lastCaptureAt = '';
        this.lastUpdated = '';
        this.lastError = '';
        this.lastCapturedSnapshotHash = '';
    }

    async init() {
        if (this.initialized) {
            return this.getSummary();
        }

        await fs.mkdir(this.directory, { recursive: true });
        await this.loadEntries();
        await this.pruneToLimit();
        await this.persist();
        this.lastUpdated = new Date().toISOString();
        this.initialized = true;
        return this.getSummary();
    }

    async loadEntries() {
        let manifestEntries = null;
        try {
            const payload = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
            if (Array.isArray(payload?.entries)) {
                manifestEntries = payload.entries;
                this.lastUpdated = String(payload.updatedAt || '');
            }
        } catch (_) {
            manifestEntries = null;
        }

        const entries = manifestEntries || await this.scanDirectory();
        const filtered = [];
        for (const entry of entries) {
            if (!entry?.filename) continue;
            const safeName = basename(String(entry.filename));
            const path = join(this.directory, safeName);
            if (!await fileExists(path)) continue;
            filtered.push({
                filename: safeName,
                capturedAt: String(entry.capturedAt || new Date().toISOString()),
                reason: String(entry.reason || 'persisted'),
                sizeBytes: Number(entry.sizeBytes || 0),
                mimeType: normalizeMimeType(entry.mimeType || inferMimeType(safeName)),
                snapshotHash: entry.snapshotHash ? String(entry.snapshotHash) : '',
                contentHash: entry.contentHash ? String(entry.contentHash) : ''
            });
        }

        this.entries = sortEntries(filtered);
        this.lastCaptureAt = this.entries[0]?.capturedAt || '';
    }

    async scanDirectory() {
        const fileNames = await fs.readdir(this.directory).catch(() => []);
        const entries = [];
        for (const fileName of fileNames) {
            if (!isImageFile(fileName)) continue;
            const path = join(this.directory, fileName);
            const stats = await fs.stat(path).catch(() => null);
            if (!stats?.isFile()) continue;
            entries.push({
                filename: fileName,
                capturedAt: stats.mtime.toISOString(),
                reason: 'persisted',
                sizeBytes: stats.size,
                mimeType: inferMimeType(fileName),
                snapshotHash: '',
                contentHash: ''
            });
        }
        return sortEntries(entries);
    }

    async persist() {
        const payload = {
            updatedAt: new Date().toISOString(),
            entries: this.entries
        };
        await fs.writeFile(this.indexPath, JSON.stringify(payload, null, 2), 'utf8');
    }

    getSummary() {
        const publicEntries = this.entries.map(toPublicEntry);
        return {
            enabled: this.enabled,
            autoCaptureActive: Boolean(this.timer),
            intervalMs: this.intervalMs,
            maxEntries: this.maxEntries,
            directory: RELATIVE_DIRECTORY,
            totalEntries: publicEntries.length,
            lastCaptureAt: this.lastCaptureAt,
            lastUpdated: this.lastUpdated,
            lastError: this.lastError,
            entries: publicEntries
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emit(event, payload = {}) {
        const summary = this.getSummary();
        for (const listener of this.listeners) {
            try {
                listener(event, summary, payload);
            } catch (_) {
                // Timeline listeners must never break the main process.
            }
        }
    }

    async pruneToLimit() {
        const removed = [];
        while (this.entries.length > this.maxEntries) {
            const staleEntry = this.entries.pop();
            if (!staleEntry) break;
            removed.push(staleEntry);
            await fs.unlink(join(this.directory, staleEntry.filename)).catch(() => {});
        }
        return removed;
    }

    async capture({
        data,
        mimeType = 'image/jpeg',
        reason = 'manual',
        snapshotHash = '',
        force = false,
        emit = true
    } = {}) {
        await this.init();

        const cleanData = String(data || '').replace(/^data:[^;]+;base64,/, '').trim();
        if (!cleanData) {
            throw new Error('Screenshot data is required');
        }

        const nextSnapshotHash = String(snapshotHash || '').trim();
        if (!force && nextSnapshotHash && nextSnapshotHash === this.lastCapturedSnapshotHash) {
            return {
                success: true,
                skipped: true,
                reason: 'no_change',
                ...this.getSummary()
            };
        }

        const normalizedMimeType = normalizeMimeType(mimeType);
        const extension = inferExtension(normalizedMimeType);
        const buffer = Buffer.from(cleanData, 'base64');
        const capturedAt = new Date().toISOString();
        const contentHash = hashString(`${buffer.length}:${cleanData.slice(0, 2048)}:${nextSnapshotHash}`);
        const filename = `${safeTimestamp(new Date(capturedAt))}-${contentHash}${extension}`;

        await fs.writeFile(join(this.directory, filename), buffer);

        /** @type {TimelineEntry} */
        const entry = {
            filename,
            capturedAt,
            reason: String(reason || 'manual'),
            sizeBytes: buffer.length,
            mimeType: normalizedMimeType,
            snapshotHash: nextSnapshotHash,
            contentHash
        };

        this.entries = sortEntries([entry, ...this.entries.filter((item) => item.filename !== filename)]);
        this.lastCaptureAt = capturedAt;
        this.lastUpdated = new Date().toISOString();
        this.lastError = '';
        if (nextSnapshotHash) {
            this.lastCapturedSnapshotHash = nextSnapshotHash;
        }

        const removed = await this.pruneToLimit();
        await this.persist();

        if (emit) {
            this.emit('captured', {
                entry: toPublicEntry(entry),
                removed: removed.map(toPublicEntry)
            });
        }

        return {
            success: true,
            skipped: false,
            entry: toPublicEntry(entry),
            ...this.getSummary()
        };
    }

    async captureNow({ reason = 'manual', snapshotHash, force = false } = {}) {
        await this.init();
        if (!this.captureScreenshot) {
            throw new Error('Screenshot capture provider is not configured');
        }

        const result = await this.captureScreenshot({
            format: 'jpeg',
            quality: 70
        });

        if (!result?.data) {
            throw new Error(result?.error || 'Screenshot capture returned no data');
        }

        const nextSnapshotHash = snapshotHash ?? await Promise.resolve(this.getSnapshotHash?.());
        return this.capture({
            data: result.data,
            mimeType: result.mimeType || 'image/jpeg',
            reason,
            snapshotHash: nextSnapshotHash,
            force
        });
    }

    async tick() {
        const snapshotHash = String(await Promise.resolve(this.getSnapshotHash?.() || '')).trim();
        if (!snapshotHash) {
            return { success: true, skipped: true, reason: 'no_snapshot' };
        }
        if (snapshotHash === this.lastCapturedSnapshotHash) {
            return { success: true, skipped: true, reason: 'no_change' };
        }

        try {
            return await this.captureNow({
                reason: 'auto',
                snapshotHash,
                force: false
            });
        } catch (error) {
            this.lastError = error.message;
            this.lastUpdated = new Date().toISOString();
            this.emit('error', { error: error.message });
            return { success: false, error: error.message };
        }
    }

    start(options = {}) {
        if (options.captureScreenshot) {
            this.captureScreenshot = options.captureScreenshot;
        }
        if (options.getSnapshotHash) {
            this.getSnapshotHash = options.getSnapshotHash;
        }

        this.stop();
        if (!this.enabled) {
            return;
        }

        this.init().catch(() => {});
        this.timer = setInterval(() => {
            this.tick().catch(() => {});
        }, this.intervalMs);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    find(filename) {
        const safeName = basename(String(filename || ''));
        return this.entries.find((entry) => entry.filename === safeName) || null;
    }

    async resolveFile(filename) {
        await this.init();
        const entry = this.find(filename);
        if (!entry) {
            return null;
        }

        const path = join(this.directory, entry.filename);
        if (!await fileExists(path)) {
            return null;
        }

        return {
            path,
            entry: toPublicEntry(entry)
        };
    }

    async clear() {
        await this.init();
        const cleared = this.entries.length;
        for (const entry of this.entries) {
            await fs.unlink(join(this.directory, entry.filename)).catch(() => {});
        }

        this.entries = [];
        this.lastCaptureAt = '';
        this.lastUpdated = new Date().toISOString();
        this.lastError = '';
        this.lastCapturedSnapshotHash = '';
        await this.persist();
        this.emit('cleared', { cleared });

        return {
            success: true,
            cleared,
            ...this.getSummary()
        };
    }
}

export const screenshotTimeline = new ScreenshotTimeline();
