// @ts-check
/**
 * Lightweight in-memory session analytics for the mobile control surface.
 *
 * @module session-stats
 */

/**
 * @typedef {object} SessionSummary
 * @property {string} startedAt
 * @property {string} lastResetAt
 * @property {string} resetReason
 * @property {number} uptimeMs
 * @property {string} uptime
 * @property {Record<string, number>} metrics
 * @property {string} errorRate
 * @property {string} approvalRate
 * @property {Array<{type: string, message: string, timestamp: string, meta?: any}>} lastErrors
 * @property {Array<{type: string, details?: any, timestamp: string}>} lastActions
 */

export class SessionStats {
    constructor() {
        this.listeners = new Set();
        this.reset('startup');
    }

    reset(reason = 'manual') {
        this.startTime = Date.now();
        this.startedAt = new Date(this.startTime).toISOString();
        this.lastResetAt = this.startedAt;
        this.resetReason = reason;
        this.metrics = {
            messagesSent: 0,
            quickCommandUses: 0,
            snapshotsProcessed: 0,
            snapshotUpdatesBroadcast: 0,
            actionsApproved: 0,
            actionsRejected: 0,
            actionsAutoApproved: 0,
            errorsDetected: 0,
            dialogErrorsDetected: 0,
            telegramNotificationsSent: 0,
            quotaWarnings: 0,
            rateLimitHits: 0,
            reconnections: 0,
            suggestionsCreated: 0,
            suggestionsApproved: 0,
            suggestionsRejected: 0,
            screenCaptures: 0,
            timelineCaptures: 0,
            screenStreamsStarted: 0,
            screenStreamsStopped: 0,
            uploadsInjected: 0
        };
        this.errorLog = [];
        this.actionLog = [];
        this.emit('reset');
    }

    increment(metric, amount = 1) {
        if (!(metric in this.metrics)) {
            this.metrics[metric] = 0;
        }
        this.metrics[metric] += amount;
        this.emit('updated');
        return this.metrics[metric];
    }

    logError(type, message, meta) {
        const entry = {
            type: String(type || 'error'),
            message: String(message || 'Unknown error'),
            timestamp: new Date().toISOString()
        };
        if (meta !== undefined) {
            entry.meta = meta;
        }
        this.errorLog.push(entry);
        if (this.errorLog.length > 50) {
            this.errorLog.shift();
        }
        this.metrics.errorsDetected += 1;
        this.emit('updated');
        return entry;
    }

    logAction(type, details) {
        const entry = {
            type: String(type || 'action'),
            timestamp: new Date().toISOString()
        };
        if (details !== undefined) {
            entry.details = details;
        }
        this.actionLog.push(entry);
        if (this.actionLog.length > 100) {
            this.actionLog.shift();
        }
        this.emit('updated');
        return entry;
    }

    getUptimeMs() {
        return Math.max(0, Date.now() - this.startTime);
    }

    getUptime() {
        const ms = this.getUptimeMs();
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    calculateErrorRate() {
        const total = this.metrics.snapshotsProcessed || 1;
        return `${((this.metrics.errorsDetected / total) * 100).toFixed(2)}%`;
    }

    calculateApprovalRate() {
        const total = this.metrics.actionsApproved + this.metrics.actionsRejected || 1;
        return `${((this.metrics.actionsApproved / total) * 100).toFixed(0)}%`;
    }

    /**
     * @returns {SessionSummary}
     */
    getSummary() {
        return {
            startedAt: this.startedAt,
            lastResetAt: this.lastResetAt,
            resetReason: this.resetReason,
            uptimeMs: this.getUptimeMs(),
            uptime: this.getUptime(),
            metrics: { ...this.metrics },
            errorRate: this.calculateErrorRate(),
            approvalRate: this.calculateApprovalRate(),
            lastErrors: this.errorLog.slice(-5),
            lastActions: this.actionLog.slice(-10)
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emit(event) {
        const summary = this.getSummary();
        for (const listener of this.listeners) {
            try {
                listener(event, summary);
            } catch (_) {
                // Stats listeners must never break the main process.
            }
        }
    }
}

export const sessionStats = new SessionStats();
