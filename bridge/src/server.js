#!/usr/bin/env node
// @ts-check
/**
 * LiftOff Antigravity Bridge - Main Server
 * Mobile remote control for AI coding sessions via CDP mirroring.
 *
 * @module server
 */
import './env.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    sendTelegramNotification,
    sendTypedNotification,
    sendActionRequired,
    sendSuggestionRequired,
    initTelegramBot,
    registerTelegramHooks,
    stopBot as stopTelegramBot
} from './utils/telegram.js';

import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';

// ─── Module Imports ─────────────────────────────────────────────────
import {
    PROJECT_ROOT, PORTS, CONTAINER_IDS, SERVER_PORT, POLL_INTERVAL,
    APP_PASSWORD, COOKIE_SECRET, AUTH_SALT, AUTH_COOKIE_NAME, VERSION,
    JSON_BODY_LIMIT, AUTO_TUNNEL_PROVIDER
} from './config.js';
import * as state from './state.js';
import { getLocalIP, isLocalRequest, getJson } from './utils/network.js';
import { killPortProcess, launchAntigravity } from './utils/process.js';
import { hashString } from './utils/hash.js';
import { FIND_SUBMIT_BUTTON_SOURCE } from './utils/submit-button.js';
import {
    classifyCurrentAgentNotification,
    isCancellationMessage
} from './utils/agent-state.js';
import { formatEntityTag, normalizeEntityTag } from './utils/http-cache.js';
import { discoverCDP, discoverAllCDP, connectCDP, initCDP } from './cdp/connection.js';
import { inspectUI } from './ui_inspector.js';
import { sessionStats } from './session-stats.js';
import { quotaService } from './quota-service.js';
import { screenshotTimeline } from './screenshot-timeline.js';
import {
    ensureWorkspaceData,
    getGitSummary,
    gitAdd,
    gitCommit,
    gitPush,
    listWorkspace,
    loadQuickCommands,
    readWorkspaceFile,
    saveQuickCommands,
    saveUploadedImage,
    terminalManager,
    workspaceRoot,
    uploadsDir
} from './utils/workspace.js';
import { aiSupervisor, suggestQueue, extractPendingCommand } from './supervisor.js';
import { CloudflareTunnelManager } from '../scripts/cloudflare-tunnel.js';
import { PinggyTunnelManager } from '../scripts/pinggy-tunnel.js';
import { DISCOVERY_PORT, startDiscoveryResponder } from './discovery.js';
import { LanguageServerConversationReadService } from './language-server/conversation-read-service.js';
import { LanguageServerConversationWriteService } from './language-server/conversation-write-service.js';
import { findTrajectoryMedia } from './language-server/trajectory-normalizer.js';
import {
    emitTrayCommand,
    isDesktopPasswordValid,
    isTrayManaged,
    readTrayState
} from './utils/desktop-control.js';

// ─── Mutable State ──────────────────────────────────────────────────

/** @type {import('./state.js').CDPConnection | null} */
let cdpConnection = null;

/** @type {import('./state.js').Snapshot | null} */
let lastSnapshot = null;

/** @type {string | null} */
let lastSnapshotHash = null;

let snapshotRefreshRequested = true;
let snapshotRequestReason = 'startup';
let lastSnapshotCaptureAt = 0;
let lastCapturedProbeSignature = '';
let lastAgentProbe = null;
let lastBroadcastAgentStatus = '';
let pendingAgentCompletion = false;
let idleCandidateSignature = '';
let idleStableTicks = 0;
let responseWatch = {
    active: false,
    baselineSignature: '',
    lastSignature: '',
    lastLoadedRpcRevision: '',
    stableTicks: 0,
    observedBusy: false,
    startedAt: 0
};

/** @type {import('./state.js').CDPTarget[]} */
let availableTargets = [];

/** @type {string | null} */
let activeTargetId = null;

/** @type {string} */
let AUTH_TOKEN = 'ag_default_token';

const conversationReadService = new LanguageServerConversationReadService();
const conversationWriteService = new LanguageServerConversationWriteService({
    readService: conversationReadService,
    metadata: {
        ideVersion: VERSION,
        extensionVersion: VERSION
    }
});
let lastRpcSnapshot = null;
let lastRpcSnapshotHash = null;
let lastRpcSnapshotRevision = null;
let lastRpcConversation = null;
let lastRpcSnapshotLoadedAt = 0;
let rpcSnapshotPromise = null;
const MAX_RPC_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RPC_DIFF_BYTES = 5 * 1024 * 1024;
const RPC_REVISION_FAST_PATH_MS = 10000;
const desktopFocusTasks = new Map();

/** @type {import('ws').WebSocketServer | null} */
let websocketServer = null;
/** @type {{close: () => void} | null} */
let discoveryResponder = null;
/** @type {{url: string, version: string, name: string} | null} */
let pairingInfo = null;
/** @type {(() => void) | null} */
let suggestionQueueUnsubscribe = null;
/** @type {(() => void) | null} */
let sessionStatsUnsubscribe = null;
/** @type {(() => void) | null} */
let quotaServiceUnsubscribe = null;
/** @type {(() => void) | null} */
let timelineUnsubscribe = null;
const TELEGRAM_CONFIGURED = Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
);

const serverStartedAt = new Date().toISOString();
const MAX_SERVER_LOGS = 250;
/** @type {Array<{level: string, message: string, timestamp: string}>} */
const serverLogs = [];
const tunnelManagers = {
    cloudflare: new CloudflareTunnelManager(),
    pinggy: new PinggyTunnelManager()
};
let tunnelProvider = '';
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

function requestSnapshotRefresh(reason = 'requested') {
    snapshotRefreshRequested = true;
    snapshotRequestReason = reason;
}

function broadcastAgentState(status) {
    if (lastBroadcastAgentStatus === status) return;
    lastBroadcastAgentStatus = status;
    broadcast({
        type: 'agent_state',
        status,
        timestamp: new Date().toISOString()
    });
}

function beginResponseWatch() {
    responseWatch = {
        active: true,
        baselineSignature: lastAgentProbe?.signature || '',
        lastSignature: lastAgentProbe?.signature || '',
        lastLoadedRpcRevision: lastRpcSnapshotRevision || '',
        stableTicks: 0,
        observedBusy: false,
        startedAt: Date.now()
    };
    broadcastAgentState('preparing');
}

/**
 * @param {string} [provider]
 */
function getTunnelManager(provider = tunnelProvider) {
    if (!provider) return null;
    return tunnelManagers[provider] || null;
}

/**
 * @param {string} [provider]
 */
function getTunnelStatus(provider = tunnelProvider) {
    const manager = getTunnelManager(provider);
    if (manager) {
        return manager.getStatus();
    }
    return {
        active: false,
        url: '',
        startedAt: '',
        error: '',
        logs: []
    };
}

function broadcastTunnelStatus() {
    broadcast({
        type: 'tunnel_status',
        status: {
            provider: tunnelProvider,
            ...getTunnelStatus()
        },
        timestamp: new Date().toISOString()
    });
}

/**
 * @param {string} provider
 * @returns {Promise<void>}
 */
async function stopOtherTunnels(provider) {
    const tasks = Object.entries(tunnelManagers)
        .filter(([name]) => name !== provider)
        .map(([, manager]) => manager.stop());
    await Promise.all(tasks);
}

/**
 * @param {string} provider
 * @param {number} port
 * @param {{tls?: boolean, sniServerName?: string}} [options]
 * @returns {Promise<string>}
 */
async function startTunnel(provider, port, options = {}) {
    const manager = getTunnelManager(provider);
    if (!manager) {
        throw new Error(`Unsupported tunnel provider: ${provider}`);
    }

    await stopOtherTunnels(provider);
    tunnelProvider = provider;
    return manager.start(port, options);
}

async function stopActiveTunnel() {
    const manager = getTunnelManager();
    if (!manager) return;
    await manager.stop();
}

const screenStreamState = {
    active: false,
    startedAt: '',
    lastFrameAt: '',
    /** @type {((params: any) => Promise<void>) | null} */
    listener: null
};

/**
 * @param {any} value
 * @returns {string}
 */
function serializeLogArg(value) {
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

/**
 * Remove ANSI escape sequences (colors, cursor moves) so stored logs stay readable in the admin UI.
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x1b\x9b][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g, '');
}

for (const level of /** @type {const} */ (['log', 'info', 'warn', 'error'])) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        serverLogs.push({
            level,
            message: stripAnsi(args.map(serializeLogArg).join(' ')),
            timestamp: new Date().toISOString()
        });
        if (serverLogs.length > MAX_SERVER_LOGS) {
            serverLogs.shift();
        }
        original(...args);
    };
}

/**
 * @param {number} [limit]
 * @returns {Array<{level: string, message: string, timestamp: string}>}
 */
function getServerLogs(limit = 80) {
    return serverLogs.slice(-Math.max(1, limit));
}

/**
 * Track delivered Telegram notifications only when Telegram is configured.
 * `sendTelegramNotification()` returns true when disabled, so we gate metrics here.
 *
 * @param {boolean} sent
 */
function trackTelegramNotification(sent) {
    if (sent && TELEGRAM_CONFIGURED) {
        sessionStats.increment('telegramNotificationsSent');
    }
}

function getSuggestionState() {
    return {
        suggestMode: aiSupervisor.isSuggestModeEnabled(),
        pendingCount: suggestQueue.getPendingCount(),
        suggestions: suggestQueue.getAll()
    };
}

function broadcastSuggestionState() {
    broadcast({
        type: 'suggestion_state',
        ...getSuggestionState(),
        timestamp: new Date().toISOString()
    });
}

function getStatsState() {
    return {
        ...sessionStats.getSummary(),
        pendingSuggestions: suggestQueue.getPendingCount()
    };
}

function broadcastStatsState() {
    broadcast({
        type: 'stats_state',
        stats: getStatsState(),
        timestamp: new Date().toISOString()
    });
}

function getQuotaState() {
    return quotaService.getSummary();
}

function broadcastQuotaState() {
    broadcast({
        type: 'quota_state',
        quota: getQuotaState(),
        timestamp: new Date().toISOString()
    });
}

function getTimelineState() {
    return screenshotTimeline.getSummary();
}

function broadcastTimelineState() {
    broadcast({
        type: 'timeline_state',
        timeline: getTimelineState(),
        timestamp: new Date().toISOString()
    });
}

function getAssistContext() {
    return {
        stats: getStatsState(),
        quota: getQuotaState(),
        pendingSuggestions: suggestQueue.getPendingCount(),
        suggestions: suggestQueue.getPending().slice(0, 3)
    };
}

function getLatestPendingSuggestion() {
    return suggestQueue.getPending()[0] || null;
}

async function captureCurrentScreenshot({ format = 'jpeg', quality = 70 } = {}) {
    if (!cdpConnection) {
        return { success: false, error: 'CDP disconnected' };
    }

    try {
        /** @type {any} */
        const params = { format };
        if (format !== 'png') {
            params.quality = quality;
        }

        const result = await cdpConnection.call('Page.captureScreenshot', params);
        return {
            success: true,
            data: result.data,
            mimeType: format === 'png' ? 'image/png' : 'image/jpeg'
        };
    } catch (e) { const error = /** @type {Error} */ (e);
        return {
            success: false,
            error: error.message
        };
    }
}

/** @param {string} id */
async function approveQueuedSuggestion(id) {
    const suggestion = suggestQueue.find(id);
    if (!suggestion) {
        return { success: false, error: 'Suggestion not found' };
    }

    if (suggestion.status !== 'pending') {
        return { success: false, error: `Suggestion already ${suggestion.status}` };
    }

    if (!cdpConnection) {
        return { success: false, error: 'CDP disconnected' };
    }

    const executed = await completePendingAction(cdpConnection, suggestion.action);
    if (!executed.success) {
        return {
            success: false,
            error: executed.error || 'Failed to execute suggested action',
            executed
        };
    }

    const approved = suggestQueue.approve(id);
    if (suggestion.action === 'accept') {
        sessionStats.increment('actionsApproved');
    } else {
        sessionStats.increment('actionsRejected');
    }
    sessionStats.logAction('suggestion_executed', {
        id,
        action: suggestion.action
    });
    return {
        success: true,
        suggestion: approved,
        executed
    };
}

/** @param {string} id */
function rejectQueuedSuggestion(id) {
    const suggestion = suggestQueue.find(id);
    if (!suggestion) {
        return { success: false, error: 'Suggestion not found' };
    }

    if (suggestion.status !== 'pending') {
        return { success: false, error: `Suggestion already ${suggestion.status}` };
    }

    const rejected = suggestQueue.reject(id);
    sessionStats.logAction('suggestion_rejected_by_user', { id });
    return {
        success: true,
        suggestion: rejected
    };
}

/**
 * Broadcast a JSON payload to connected mobile clients.
 *
 * @param {object} payload
 * @returns {void}
 */
function broadcast(payload) {
    if (!websocketServer) return;
    const serialized = JSON.stringify(payload);
    websocketServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(serialized);
        }
    });
}

async function loadRpcSnapshot({ force = false } = {}) {
    if (!conversationReadService.getActiveConversationId()) return null;
    if (rpcSnapshotPromise) return rpcSnapshotPromise;
    rpcSnapshotPromise = (async () => {
        try {
            const conversation = await conversationReadService.loadActiveConversation({ force });
            const snapshot = conversation.snapshot;
            lastRpcConversation = conversation;
            lastRpcSnapshot = snapshot;
            lastRpcSnapshotHash = hashString(snapshot.html);
            lastRpcSnapshotRevision = hashString(conversation.revision);
            lastRpcSnapshotLoadedAt = Date.now();
            return snapshot;
        } catch (_) {
            return null;
        } finally {
            rpcSnapshotPromise = null;
        }
    })();
    return rpcSnapshotPromise;
}

async function getRpcSnapshotRevision() {
    if (!conversationReadService.getActiveConversationId()) return null;
    try {
        const revision = await conversationReadService.getActiveConversationRevision({
            force: false
        });
        return hashString(revision);
    } catch (_) {
        return null;
    }
}

async function pollActiveRpcConversation() {
    if (!responseWatch.active || !conversationReadService.getActiveConversationId()) return;
    let revisionText;
    try {
        revisionText = await conversationReadService.getActiveConversationRevision({
            force: true
        });
    } catch (_) {
        return;
    }

    const revision = hashString(revisionText);
    let summary = {};
    try {
        summary = JSON.parse(revisionText);
    } catch (_) { }
    const status = String(summary.status || '');
    const isIdle = !status || status === 'CASCADE_RUN_STATUS_IDLE';
    if (!isIdle) {
        responseWatch.observedBusy = true;
        broadcastAgentState('responding');
        return;
    }

    // Summary/status probing is much cheaper than loading every trajectory step.
    // Fetch the full transcript only when the idle conversation revision has not
    // already been rendered during this response.
    if (revision === responseWatch.lastLoadedRpcRevision) return;

    const previousHash = lastRpcSnapshotHash;
    const snapshot = await loadRpcSnapshot({ force: false });
    if (!snapshot || !lastRpcConversation) return;
    responseWatch.lastLoadedRpcRevision = revision;

    const changed = lastRpcSnapshotHash !== previousHash;
    if (changed) {
        broadcast({
            type: 'snapshot_update',
            source: 'language-server-rpc',
            timestamp: new Date().toISOString()
        });
    }

    const latestMessage = lastRpcConversation.messages.at(-1);
    const assistantChanged = changed && latestMessage?.role === 'assistant';
    if (!assistantChanged || Date.now() - responseWatch.startedAt < 1200) return;

    responseWatch.active = false;
    pendingAgentCompletion = false;
    if (isCancellationMessage(latestMessage.content)) {
        broadcastAgentState('cancelled');
    } else {
        broadcastAgentState('complete');
        broadcast({
            type: 'notification',
            event: 'reply_ready',
            message: 'Antigravity finished replying.',
            timestamp: new Date().toISOString()
        });
    }
}

/**
 * @returns {number}
 */
function getOpenClientCount() {
    if (!websocketServer) return 0;
    let count = 0;
    websocketServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) count++;
    });
    return count;
}

/**
 * @returns {{active: boolean, startedAt: string, lastFrameAt: string}}
 */
function getScreencastStatus() {
    return {
        active: screenStreamState.active,
        startedAt: screenStreamState.startedAt,
        lastFrameAt: screenStreamState.lastFrameAt
    };
}

/**
 * @returns {Promise<void>}
 */
async function stopScreencast() {
    const wasActive = screenStreamState.active;
    if (cdpConnection && screenStreamState.active) {
        try {
            if (screenStreamState.listener) {
                cdpConnection.off('Page.screencastFrame', screenStreamState.listener);
            }
            await cdpConnection.call('Page.stopScreencast', {});
        } catch (_) {
            // Ignore stop errors during reconnect or target switches.
        }
    }

    screenStreamState.active = false;
    screenStreamState.startedAt = '';
    screenStreamState.lastFrameAt = '';
    screenStreamState.listener = null;
    if (wasActive) {
        sessionStats.increment('screenStreamsStopped');
        sessionStats.logAction('screencast_stopped');
    }
    broadcast({ type: 'screen_status', status: getScreencastStatus() });
}

/**
 * @returns {Promise<{active: boolean, startedAt: string, lastFrameAt: string}>}
 */
async function startScreencast() {
    if (!cdpConnection) {
        throw new Error('CDP disconnected');
    }

    if (screenStreamState.active) {
        return getScreencastStatus();
    }

    await cdpConnection.call('Page.enable', {});

    screenStreamState.listener = async (params) => {
        screenStreamState.lastFrameAt = new Date().toISOString();
        broadcast({
            type: 'screen_frame',
            data: params.data,
            format: 'image/jpeg',
            timestamp: screenStreamState.lastFrameAt
        });
        try {
            await cdpConnection?.call('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch (_) {
            // Ignore acknowledgements during reconnect.
        }
    };

    cdpConnection.on('Page.screencastFrame', screenStreamState.listener);
    await cdpConnection.call('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1
    });

    screenStreamState.active = true;
    screenStreamState.startedAt = new Date().toISOString();
    screenStreamState.lastFrameAt = '';
    sessionStats.increment('screenStreamsStarted');
    sessionStats.logAction('screencast_started');
    broadcast({ type: 'screen_status', status: getScreencastStatus() });
    return getScreencastStatus();
}

/**
 * @returns {Promise<void>}
 */
async function maybeStartAutoTunnel(options = {}) {
    const provider = AUTO_TUNNEL_PROVIDER;
    const manager = getTunnelManager(provider);
    if (!manager) return;
    if (manager.getStatus().active) return;

    try {
        const url = await startTunnel(provider, Number(SERVER_PORT), options);
        console.log(`☁️ ${provider} tunnel ready: ${url}`);
    } catch (e) { const error = /** @type {Error} */ (e);
        console.warn(`⚠️ ${provider} tunnel failed: ${error.message}`);
    }
}

// ─── CDP Action Functions ───────────────────────────────────────────
// These functions contain large template-literal scripts injected into
// the browser via CDP Runtime.evaluate. They stay in this file because
// the template strings reference interpolated variables from their
// closure scope, making extraction fragile.

// (connectCDP moved to src/cdp/connection.js)

/**
 * Capture the current chat DOM as an HTML snapshot with CSS styles.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<import('./state.js').Snapshot | null>}
 */
/**
 * Scan all CDP contexts for full-page error/modal dialogs that exist OUTSIDE
 * the main chat container (e.g. quota reached, agent terminated, rate limit).
 * Inspired by tody-agent/AntigravityMobile chat-stream.mjs:checkErrorDialogs.
 *
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{error: string, type: string} | null>}
 */
async function checkErrorDialogs(cdp) {
    const DIALOG_SCRIPT = `(function() {
        try {
            const dialogs = document.querySelectorAll(
                '[role="dialog"], .dialog-shadow, .monaco-dialog-box, ' +
                '[class*="dialog"], [class*="notification-toast"], ' +
                '[class*="error-widget"], .notifications-toasts'
            );
            for (const d of dialogs) {
                if (d.offsetParent === null && !d.closest('[class*="toast"]')) continue;
                const text = (d.innerText || '').toLowerCase();
                const len = text.length;
                if (len < 5 || len > 2000) continue;

                if (text.includes('terminated due to error') || text.includes('agent terminated')) {
                    return { error: 'Agent terminated due to error', type: 'terminated' };
                }
                if (text.includes('model quota reached') || text.includes('quota exhausted') || text.includes('usage limit')) {
                    return { error: 'Model quota reached', type: 'quota' };
                }
                if (text.includes('rate limit') || text.includes('too many requests') || text.includes('rate_limit_error')) {
                    return { error: 'Rate limit exceeded', type: 'rate_limit' };
                }
                if (text.includes('high traffic') || text.includes('overloaded')) {
                    return { error: 'High traffic / server overloaded', type: 'high_traffic' };
                }
                if (text.includes('internal server error') || text.includes('something went wrong')) {
                    return { error: 'Internal server error', type: 'server_error' };
                }
                if (text.includes('network error') || text.includes('connection lost')) {
                    return { error: 'Network error / connection lost', type: 'network_error' };
                }
            }
            return null;
        } catch(e) { return null; }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: DIALOG_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { /* context may be gone */ }
    }
    return null;
}

async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(() => {
        const INTERACTIVE_TEXT_PATTERNS = [
            /^thought/i,
            /^thinking/i,
            /^run$/i,
            /^reject$/i,
            /^accept$/i,
            /^allow$/i,
            /^deny$/i,
            /^review changes$/i,
            /^files with changes$/i,
            /^continue$/i,
            /^cancel$/i,
            /^retry$/i,
            /^show more$/i,
            /^show less$/i,
            /^expand$/i,
            /^collapse$/i,
            /^copy$/i
        ];
        const normalizeText = (value) => (value || '').split('\\n')[0].replace(/\\s+/g, ' ').trim();
        const isInteractiveCandidate = (el) => {
            const text = normalizeText(el.textContent || el.innerText || '');
            if (!text || text.length > 120) return false;
            if (el.children.length > 0) return false;
            if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)) return true;
            if (el.getAttribute('role') === 'button') return true;
            return INTERACTIVE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
        };

        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 120 || rect.height < 80) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const isRendered = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const getText = (el) => (el?.innerText || el?.textContent || '').trim();
        const hasConversationContent = (el) => {
            if (!el) return false;
            if (getText(el).length >= 80) return true;
            return el.querySelectorAll(
                '[contenteditable="true"], [data-lexical-editor="true"], textarea, [class*="message"], [data-message]'
            ).length > 0;
        };
        const scoreCandidate = (el) => {
            if (!isVisible(el)) return -1;
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            const textLen = Math.min(getText(el).length, 5000);
            const buttonCount = el.querySelectorAll('button, [role="button"], a').length;
            const editorCount = el.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea').length;
            const messageCount = el.querySelectorAll('[class*="message"], [data-message]').length;
            const rootPenalty = el === document.body || el === document.documentElement ? 0.35 : 1;
            return (area * rootPenalty) + (textLen * 18) + (buttonCount * 120) + (editorCount * 1200) + (messageCount * 700);
        };

        // App chrome (left rail, top menu bar) must never be part of the mirror —
        // a container that includes them means we picked too high in the tree.
        const chromeEls = Array.from(document.querySelectorAll('div[class*="bg-sidebar"]'))
            .filter(el => {
                const r = el.getBoundingClientRect();
                return (r.width > 150 && r.height > 300) || // left rail
                       (r.width > 600 && r.height > 0 && r.height < 60); // top menu bar
            });
        const containsChrome = (el) =>
            chromeEls.some(chrome => el !== chrome && el.contains(chrome));

        let cascade = null;
        for (const id of ['cascade', 'conversation', 'chat']) {
            const exact = document.getElementById(id);
            if (isVisible(exact) && !containsChrome(exact)) {
                cascade = exact;
                break;
            }
        }

        if (!cascade) {
            const editor = Array.from(document.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea'))
                .filter(isRendered)
                .at(-1);
            if (editor) {
                const editorAncestors = [];
                let current = editor.parentElement;
                while (current && current !== document.body) {
                    if (containsChrome(current)) break; // higher ancestors only get worse
                    if (isVisible(current) && hasConversationContent(current)) {
                        editorAncestors.push(current);
                    }
                    current = current.parentElement;
                }
                editorAncestors.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
                cascade = editorAncestors[0] || null;
            }
        }

        if (!cascade) {
            const startButton = Array.from(document.querySelectorAll('button, [role="button"], a'))
                .find((el) => isVisible(el) && /start new chat|new chat|new conversation/i.test(getText(el)));
            if (startButton) {
                let current = startButton.parentElement;
                while (current && current !== document.body) {
                    if (containsChrome(current)) break;
                    if (scoreCandidate(current) > 0) {
                        cascade = current;
                        break;
                    }
                    current = current.parentElement;
                }
            }
        }

        if (!cascade) {
            const allCandidates = Array.from(document.querySelectorAll('main, [role="main"], section, article, div'))
                .filter(isVisible);
            const cleanCandidates = allCandidates.filter(el =>
                !containsChrome(el) && hasConversationContent(el)
            );
            const pool = cleanCandidates.length > 0 ? cleanCandidates : allCandidates;
            pool.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
            cascade = pool[0] || document.body;
        }

        if (!cascade) {
            const body = document.body;
            const childIds = Array.from(body?.children || []).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);

        // Preserve speaker identity for native clients. Antigravity marks user
        // turns with user-input-step; assistant turns are the remaining
        // conversation articles.
        clone.querySelectorAll('[role="article"]').forEach(article => {
            const role = article.querySelector('[data-testid="user-input-step"]')
                ? 'user'
                : 'assistant';
            article.setAttribute('data-liftoff-role', role);
            const speaker = document.createElement('div');
            speaker.setAttribute('data-liftoff-speaker', role);
            speaker.textContent = role === 'user' ? 'You' : 'Antigravity';
            article.prepend(speaker);
        });
        
        // Aggressively remove the entire interaction/input/review area
        try {
            // Remove the current Antigravity composer by its stable id, stopping
            // at the flex-shrink wrapper that sits below the transcript.
            const inputBox = clone.querySelector('[id="antigravity.agentSidePanelInputBox"]');
            if (inputBox) {
                const composerArea = inputBox.closest('[class*="flex-shrink-0"]') ||
                    inputBox.closest('div[id^="interaction"]') ||
                    inputBox.parentElement?.parentElement?.parentElement;
                if (composerArea && composerArea !== clone) composerArea.remove();
                else inputBox.remove();
            }

            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // For the editor, we want to remove its interaction container
                        if (selector === '[contenteditable="true"]') {
                            const area = el.closest('[class*="flex-shrink-0"]') ||
                                         el.closest('div[id^="interaction"]') ||
                                         el.parentElement?.parentElement;
                            if (area && area !== clone) area.remove();
                            else el.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            // 2. Text-based cleanup for stray status bars
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    if (text.includes('review changes') || text.includes('files with changes') || text.includes('context found')) {
                        if (el.children.length < 10 || el.querySelector('button') || el.classList?.contains('justify-between')) {
                            el.style.display = 'none';
                            el.remove();
                        }
                    }
                } catch (e) {}
            });

            // 3. Base64 image conversion — convert local SVGs/images to data URIs
            //    This prevents broken images when accessing via ngrok/remote
            clone.querySelectorAll('img[src], svg').forEach(el => {
                try {
                    if (el.tagName === 'SVG') {
                        const svgData = new XMLSerializer().serializeToString(el);
                        const img = document.createElement('img');
                        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                        img.style.cssText = el.style.cssText || '';
                        img.width = el.getAttribute('width') || el.clientWidth || 16;
                        img.height = el.getAttribute('height') || el.clientHeight || 16;
                        img.className = el.className?.baseVal || '';
                        el.replaceWith(img);
                    } else if (el.src && !el.src.startsWith('data:') && !el.src.startsWith('http')) {
                        // Local file references — try canvas conversion
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = el.naturalWidth || el.width || 16;
                            canvas.height = el.naturalHeight || el.height || 16;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(el, 0, 0);
                            el.src = canvas.toDataURL('image/png');
                        } catch(canvasErr) {}
                    }
                } catch(imgErr) {}
            });

            const textGroups = new Map();
            Array.from(clone.querySelectorAll('button, [role="button"], a, summary, span, div, p')).forEach(el => {
                try {
                    if (!isInteractiveCandidate(el)) return;
                    const text = normalizeText(el.textContent || el.innerText || '');
                    if (!textGroups.has(text)) {
                        textGroups.set(text, []);
                    }
                    textGroups.get(text).push(el);
                } catch (_) {}
            });

            textGroups.forEach((elements, text) => {
                elements.forEach((el, idx) => {
                    el.setAttribute('data-liftoff-text', text);
                    el.setAttribute('data-liftoff-idx', String(idx));
                    el.setAttribute('data-liftoff-total', String(elements.length));
                });
            });
        } catch (globalErr) { }
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\\n');
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length,
                containerTag: cascade.tagName,
                containerId: cascade.id || '',
                containerClass: String(cascade.className || '').slice(0, 240),
                containerTextLength: getText(cascade).length
            }
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                // console.log(`Context ${ctx.id} exception:`, result.exceptionDetails);
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    // console.log(`Context ${ctx.id} script error:`, val.error);
                    // if (val.debug) console.log(`   Debug info:`, JSON.stringify(val.debug));
                } else {
                    return val;
                }
            }
        } catch (e) {
            console.log(`Context ${ctx.id} connection error:`, e.message);
        }
    }

    return null;
}

/**
 * Inject a message into the Antigravity chat editor and submit it.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {string} text
 * @returns {Promise<{ok: boolean, method?: string, reason?: string, error?: string}>}
 */
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);
    // The evaluation below may run in several isolated worlds that share one DOM.
    // When the renderer is throttled (locked PC), the first context's call times out,
    // the loop queues the same injection in the next context, and both eventually
    // execute — duplicating the message. A DOM-stored nonce caps execution at once.
    const nonce = JSON.stringify(Date.now().toString(36) + Math.random().toString(36).slice(2));

    const EXPRESSION = `(async () => {
        const nonce = ${nonce};
        if (document.body.dataset.liftoffSendNonce === nonce) {
            return { ok:true, method:"deduped_already_sent" };
        }

        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        // Mark only once we are committed to mutating the editor, so a failed
        // attempt in one context does not block a retry in the next.
        document.body.dataset.liftoffSendNonce = nonce;

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        const findSubmitButton = () => (${FIND_SUBMIT_BUTTON_SOURCE})(document);

        const deadline = Date.now() + 10000;
        let submit = findSubmitButton();
        while (!submit && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 150));
            submit = findSubmitButton();
        }
        if (submit) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        editor.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles:true,
            key:"Enter",
            code:"Enter"
        }));
        editor.dispatchEvent(new KeyboardEvent("keyup", {
            bubbles:true,
            key:"Enter",
            code:"Enter"
        }));
        await new Promise(resolve => setTimeout(resolve, 250));
        const busyNow = !!document.querySelector(
            '[data-tooltip-id="input-send-button-cancel-tooltip"], button svg.lucide-square'
        );
        const editorText = (editor.innerText || editor.textContent || editor.value || '').trim();
        if (busyNow || !editorText) {
            return { ok:true, method:"enter_keypress" };
        }
        return { ok:false, reason:"submit_button_not_found" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

/**
 * Paste an uploaded image into Antigravity as a real File, then submit it with
 * an optional text prompt. This avoids typing a giant base64 data URL into the
 * editor, which Antigravity truncates as plain text.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {{data: string, mimeType?: string, name?: string, prompt?: string}} image
 */
async function injectImage(cdp, image) {
    const safeData = JSON.stringify(String(image.data || ''));
    const safeMimeType = JSON.stringify(String(image.mimeType || 'image/png'));
    const safeName = JSON.stringify(String(image.name || 'mobile-upload.png'));
    const safePrompt = JSON.stringify(
        image.prompt == null ? '' : String(image.prompt).trim()
    );
    const nonce = JSON.stringify(Date.now().toString(36) + Math.random().toString(36).slice(2));

    const EXPRESSION = `(async () => {
        const nonce = ${nonce};
        if (document.body.dataset.liftoffImageNonce === nonce) {
            return { ok:true, method:"deduped_already_sent" };
        }

        const editors = [...document.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const binary = atob(${safeData});
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], ${safeName}, { type:${safeMimeType} });
        const transfer = new DataTransfer();
        transfer.items.add(file);

        document.body.dataset.liftoffImageNonce = nonce;
        const prompt = ${safePrompt};
        const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
        const readEditorText = target => normalizeText(
            target.innerText || target.textContent || target.value || ''
        );
        const normalizedPrompt = normalizeText(prompt);
        const hasPrompt = target => !prompt || readEditorText(target).includes(normalizedPrompt);
        const insertPrompt = async target => {
            target.focus();
            if (hasPrompt(target)) return true;

            document.execCommand?.("selectAll", false, null);
            document.execCommand?.("delete", false, null);

            let inserted = false;
            try { inserted = !!document.execCommand?.("insertText", false, prompt); } catch {}
            if (!inserted) {
                target.textContent = prompt;
                target.dispatchEvent(new InputEvent("input", {
                    bubbles:true,
                    inputType:"insertText",
                    data:prompt
                }));
            }

            const promptDeadline = Date.now() + 1500;
            while (!hasPrompt(target) && Date.now() < promptDeadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return hasPrompt(target);
        };

        let method = "paste";
        let attached = false;
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        const fileInput = fileInputs.find(input => /image|png|jpe?g|gif|webp/i.test(input.accept))
            || fileInputs.find(input => !input.accept);
        if (fileInput) {
            try {
                fileInput.files = transfer.files;
                fileInput.dispatchEvent(new Event("input", { bubbles:true }));
                fileInput.dispatchEvent(new Event("change", { bubbles:true }));
                method = "file_input";
                attached = true;
            } catch {}
        }
        if (!attached) {
            const pasteEvent = new ClipboardEvent("paste", {
                bubbles:true,
                cancelable:true,
                clipboardData:transfer
            });
            const accepted = !editor.dispatchEvent(pasteEvent);
            if (!accepted) return { ok:false, reason:"image_paste_not_accepted" };
        }

        await new Promise(resolve => setTimeout(resolve, 1400));

        if (prompt) {
            const currentEditors = [...document.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea')]
                .filter(el => el.offsetParent !== null);
            const promptEditor = currentEditors.at(-1) || editor;
            if (!(await insertPrompt(promptEditor))) {
                return { ok:false, reason:"prompt_not_ready", method };
            }
        }

        const findSubmitButton = () => (${FIND_SUBMIT_BUTTON_SOURCE})(document);

        const deadline = Date.now() + 10000;
        let submit = findSubmitButton();
        while (!submit && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 150));
            submit = findSubmitButton();
        }
        if (!submit) return { ok:false, reason:"submit_button_not_found", method };

        submit.click();
        return { ok:true, method };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (result.result?.value) return result.result.value;
        } catch (e) { }
    }
    return { ok:false, reason:"no_context" };
}

/**
 * Set the functionality mode (Fast vs Planning).
 * @param {import('./state.js').CDPConnection} cdp
 * @param {'Fast' | 'Planning'} mode
 * @returns {Promise<{success?: boolean, alreadySet?: boolean, error?: string}>}
 */
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

/**
 * Stop the current AI generation.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{success?: boolean, method?: string, error?: string}>}
 */
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

/**
 * Click a DOM element via deterministic targeting with occurrence index.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {{selector?: string, index?: number, textContent?: string, liftoffIndex?: number}} params
 * @returns {Promise<{success?: boolean, matchCount?: number, index?: number, liftoffIndex?: number, error?: string}>}
 */
async function clickElement(cdp, { selector, index = 0, textContent, liftoffIndex }) {
    const safeSelector = JSON.stringify(selector || '*');
    const safeTextContent = textContent ? JSON.stringify(textContent) : 'null';
    const safeIndex = Number.isFinite(index) ? index : 0;
    const safeLiftOffIndex = Number.isFinite(liftoffIndex) ? liftoffIndex : -1;
    const EXP = `(async () => {
        try {
            const selector = ${safeSelector};
            const searchText = ${safeTextContent};
            const explicitIndex = ${safeIndex};
            const liftoffIndex = ${safeLiftOffIndex};
            const normalizeText = (value) => (value || '').split('\\n')[0].replace(/\\s+/g, ' ').trim();
            const isVisible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
            const matchesSearchText = (el) => {
                if (!searchText) return true;
                const exact = normalizeText(el.textContent || el.innerText || '');
                if (exact === searchText) return true;
                const fullText = (el.textContent || el.innerText || '').trim();
                return fullText.includes(searchText);
            };
            const isClickable = (el) => {
                if (!el) return false;
                if (['BUTTON', 'A', 'SUMMARY'].includes(el.tagName)) return true;
                if (el.getAttribute('role') === 'button') return true;
                if (typeof el.onclick === 'function') return true;
                const style = window.getComputedStyle(el);
                return style.cursor === 'pointer';
            };
            const findClickableTarget = (el) => {
                let current = el;
                for (let i = 0; current && i < 6; i += 1) {
                    if (isClickable(current)) return current;
                    current = current.parentElement;
                }
                return el;
            };
            
            const CONTAINER_IDS = ['cascade', 'conversation', 'chat'];
            let scope = null;
            for (const id of CONTAINER_IDS) {
                scope = document.getElementById(id);
                if (scope) break;
            }
            if (!scope) scope = document.body;
            
            let elements = [];
            try {
                elements = Array.from(scope.querySelectorAll(selector));
            } catch (_) {
                elements = Array.from(scope.querySelectorAll('*'));
            }
            elements = elements.filter(isVisible);
            
            if (searchText) {
                elements = elements.filter(matchesSearchText);
            }

            if (elements.length === 0 && searchText) {
                elements = Array.from(
                    scope.querySelectorAll('button, [role="button"], a, summary, span, div, p')
                )
                    .filter(isVisible)
                    .filter(matchesSearchText);
            }
            
            if (elements.length > 1) {
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }

            const targetIndex = liftoffIndex >= 0 ? liftoffIndex : explicitIndex;
            const target = elements[targetIndex];

            if (target) {
                const clickable = findClickableTarget(target);
                clickable.click();

                try {
                    const rect = clickable.getBoundingClientRect();
                    const clientX = rect.left + rect.width / 2;
                    const clientY = rect.top + rect.height / 2;
                    ['mousedown', 'mouseup', 'click'].forEach(type => {
                        clickable.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                            clientX,
                            clientY,
                            button: 0
                        }));
                    });
                } catch (_) {}

                return {
                    success: true,
                    matchCount: elements.length,
                    index: explicitIndex,
                    liftoffIndex: targetIndex
                };
            }
            
            return { error: 'Element not found at requested index', candidates: elements.length, liftoffIndex: targetIndex };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts' };
}

/**
 * Sync phone scroll position to the desktop chat container.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {{scrollTop?: number, scrollPercent?: number}} params
 * @returns {Promise<{success?: boolean, scrolled?: number, error?: string}>}
 */
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

/**
 * Set the AI model via the model selector dropdown.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {string} modelName
 * @returns {Promise<{success?: boolean, method?: string, error?: string}>}
 */
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            const isRendered = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            
            let modelBtn = null;
            
            // Current Antigravity exposes the selector as an ARIA dialog trigger.
            modelBtn = Array.from(document.querySelectorAll('[aria-haspopup="dialog"][aria-expanded]'))
                .find(el => isRendered(el) && KNOWN_KEYWORDS.some(k => (el.innerText || '').includes(k)));

            // Older builds exposed tooltip ids instead.
            if (!modelBtn) {
                modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            }
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            if (modelBtn.getAttribute('aria-expanded') !== 'true') modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => isRendered(d) && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

/**
 * Scrape the available AI models from the model selector dropdown.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<string[] | null>}
 */
async function scrapeAvailableModels(cdp) {
    const EXP = `(async () => {
        try {
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            const isRendered = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            };
            let modelBtn = null;
            
            // Current Antigravity model trigger.
            modelBtn = Array.from(document.querySelectorAll('[aria-haspopup="dialog"][aria-expanded]'))
                .find(el => isRendered(el) && KNOWN_KEYWORDS.some(k => (el.innerText || '').includes(k)));

            // Older builds exposed tooltip ids instead.
            if (!modelBtn) {
                modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            }
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Check if dialog is already open
            let openedHere = false;
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'))
                .find(el => isRendered(el) && /Gemini|Claude|GPT/.test(el.innerText || '')) || null;
            if (!visibleDialog) {
                modelBtn.click();
                openedHere = true;
                await new Promise(r => setTimeout(r, 400));
                visibleDialog = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'))
                    .find(el => isRendered(el) && /Gemini|Claude|GPT/.test(el.innerText || '')) || null;
            }

            if (!visibleDialog) {
                // Fallback search for absolute/fixed positioned divs containing keywords
                const divs = Array.from(document.querySelectorAll('div'));
                visibleDialog = divs.find(d => {
                    const style = window.getComputedStyle(d);
                    return d.offsetHeight > 0 && 
                           (style.position === 'absolute' || style.position === 'fixed') &&
                           KNOWN_KEYWORDS.some(k => d.innerText?.includes(k)) &&
                           !d.innerText?.includes('Files With Changes');
                });
            }

            if (!visibleDialog) {
                return { error: 'Model list dropdown not found' };
            }

            const allItems = Array.from(visibleDialog.querySelectorAll('*'));
            const leafNodes = allItems.filter(el => {
                if (el.children.length > 0) return false;
                const txt = el.innerText?.trim() || el.textContent?.trim() || '';
                return txt.length > 0 && KNOWN_KEYWORDS.some(k => txt.includes(k));
            });

            const models = Array.from(new Set(
                leafNodes
                    .map(el => (el.innerText || el.textContent || '').trim())
                    .filter(text => /^(Gemini|Claude|GPT)/.test(text))
            ));

            if (openedHere) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
            }

            return { success: true, models: models };
        } catch (e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) {
                return res.result.value.models;
            }
        } catch (e) { }
    }
    return null;
}


/**
 * Start a new chat by clicking the + button at the top toolbar.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{success?: boolean, method?: string, count?: number, error?: string}>}
 */
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Priority 2: Conversation-centric sidebar nav row — a DIV (not a button)
            // with a "New Conversation" span.
            const navRow = Array.from(document.querySelectorAll('div[class*="cursor-pointer"], [role="button"]'))
                .find(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return false;
                    const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    return t === 'new conversation' || t === 'new chat';
                });
            if (navRow) {
                navRow.click();
                return { success: true, method: 'sidebar_nav_row' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label or visible text
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                return (
                    ariaLabel.includes('new') ||
                    title.includes('new') ||
                    text.includes('start new chat') ||
                    text.includes('new chat') ||
                    text.includes('new conversation')
                ) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

async function detectActiveConversationId(cdp) {
    const expression = `(() => {
        const pathMatch = location.pathname.match(/\\/(?:c|conversation)\\/([a-z0-9-]{8,})/i);
        if (pathMatch) return pathMatch[1];
        const activePill = document.querySelector(
            '[class*="bg-sidebar-secondary"] [data-testid^="convo-pill-"]'
        );
        return (activePill?.getAttribute('data-testid') || '').replace('convo-pill-', '');
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
                contextId: ctx.id
            });
            const id = String(result.result?.value || '').trim();
            if (id) return id;
        } catch (_) { }
    }
    return '';
}

async function getChatHistory(cdp) {
    // Antigravity's conversation-centric sidebar:
    //   <div class="... bg-sidebar">                      left rail (~256px wide)
    //     <div class="... group/section">                 one per project
    //       <div class="... font-medium ...">Name</div>   project header
    //       <div role="button" class="... cursor-pointer ...">          conversation row
    //         <span data-testid="convo-pill-<uuid>">Title</span>
    //         <span class="text-xs text-muted-foreground">3d</span>
    //       <button>See all (N)</button>                  collapsed remainder
    //     <div class="... group/section"> <h2>Conversations</h2> ...    unassigned section
    // The active row carries "bg-sidebar-secondary" and its uuid appears in location.pathname (/c/<uuid>).
    const EXP = `(async () => {
        try {
            const isVisible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };

            const sidebar = Array.from(document.querySelectorAll('div[class*="bg-sidebar"]'))
                .find(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 150 && r.height > 300;
                }) || null;

            const root = sidebar || document.body;

            // Expand every "See all (N)" so collapsed conversations become scrapable
            const seeAllBtns = Array.from(root.querySelectorAll('button'))
                .filter(b => isVisible(b) && /^see all/i.test((b.innerText || '').trim()));
            if (seeAllBtns.length > 0) {
                seeAllBtns.forEach(b => b.click());
                await new Promise(r => setTimeout(r, 350));
            }

            const projects = [];
            const flatChats = [];
            const seenIds = new Set();
            const seenTitles = new Set();

            const readRow = (pill) => {
                const row = pill.closest('[role="button"]') || pill.closest('div[class*="cursor-pointer"]');
                if (!row || !isVisible(row)) return null;
                const id = (pill.getAttribute('data-testid') || '').replace('convo-pill-', '');
                const title = (pill.innerText || pill.textContent || '').trim();
                if (!title) return null;
                if (id ? seenIds.has(id) : seenTitles.has(title)) return null;
                if (id) seenIds.add(id);
                seenTitles.add(title);
                const timeEl = Array.from(row.querySelectorAll('span[class*="text-muted-foreground"]'))
                    .find(s => {
                        const t = (s.innerText || '').trim();
                        return t.length > 0 && t.length < 8;
                    });
                const time = timeEl ? (timeEl.innerText || '').trim() : '';
                const active = String(row.className || '').includes('bg-sidebar-secondary') ||
                    (!!id && location.pathname.includes(id));
                return { id, title, time, active };
            };

            const sections = Array.from(root.querySelectorAll('div[class*="group/section"]'))
                .filter(isVisible);

            for (const sec of sections) {
                const headerEl = sec.querySelector('div[class*="font-medium"]') || sec.querySelector('h2');
                const projectTitle = headerEl ? (headerEl.innerText || headerEl.textContent || '').trim() : '';

                const conversations = [];
                for (const pill of sec.querySelectorAll('[data-testid^="convo-pill-"]')) {
                    const conv = readRow(pill);
                    if (conv) {
                        conversations.push(conv);
                        flatChats.push({ id: conv.id, title: conv.title, date: conv.time || 'Recent', active: conv.active });
                    }
                }

                if (!projectTitle && conversations.length === 0) continue;
                projects.push({
                    title: projectTitle || 'Conversations',
                    conversations: conversations
                });
            }

            // Fallback: markup changed again — collect any convo pills on the page as one flat project
            if (flatChats.length === 0) {
                const conversations = [];
                for (const pill of document.querySelectorAll('[data-testid^="convo-pill-"]')) {
                    const conv = readRow(pill);
                    if (conv) {
                        conversations.push(conv);
                        flatChats.push({ id: conv.id, title: conv.title, date: conv.time || 'Recent', active: conv.active });
                    }
                }
                if (conversations.length > 0) {
                    projects.length = 0;
                    projects.push({ title: 'All Conversations', conversations: conversations });
                }
            }

            return {
                success: true,
                projects: projects,
                chats: flatChats
            };
        } catch (e) {
            return { error: e.toString(), projects: [], chats: [] };
        }
    })()`;

    let lastError = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                if (val.success) return val;
                if (val.error) lastError = val.error;
            }
            if (res.exceptionDetails) {
                lastError = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            }
        } catch (e) {
            lastError = e.message;
        }
    }
    return { success: false, error: lastError || 'Context evaluation failed', projects: [], chats: [] };
}

/**
 * Select a conversation in Antigravity's sidebar by conversation id (preferred) or title.
 * Conversation rows are identified by their <span data-testid="convo-pill-<uuid>"> pill;
 * rows collapsed behind "See all (N)" are expanded before retrying.
 * @param {import('./state.js').CDPConnection} cdp
 * @param {string} chatTitle
 * @param {string} [chatId]
 * @returns {Promise<{success?: boolean, method?: string, error?: string}>}
 */
async function selectChat(cdp, chatTitle, chatId = '') {
    const EXP = `(async () => {
    try {
        const targetTitle = ${JSON.stringify(chatTitle || '')};
        const targetId = ${JSON.stringify(chatId || '')};
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();

        const isVisible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const findRow = () => {
            const pills = Array.from(document.querySelectorAll('[data-testid^="convo-pill-"]'));
            let pill = null;
            if (targetId) {
                pill = pills.find(p => (p.getAttribute('data-testid') || '') === 'convo-pill-' + targetId);
            }
            if (!pill && targetTitle) {
                const wanted = norm(targetTitle);
                pill = pills.find(p => norm(p.innerText || p.textContent) === wanted) ||
                    pills.find(p => norm(p.innerText || p.textContent).startsWith(wanted.slice(0, 40)));
            }
            if (!pill) return null;
            return pill.closest('[role="button"]') || pill.closest('div[class*="cursor-pointer"]') || pill;
        };

        const clickRow = (el) => {
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.click();
        };

        let row = findRow();
        if (!row) {
            // The conversation may be collapsed behind a "See all (N)" expander
            const seeAllBtns = Array.from(document.querySelectorAll('button'))
                .filter(b => isVisible(b) && /^see all/i.test((b.innerText || '').trim()));
            if (seeAllBtns.length > 0) {
                seeAllBtns.forEach(b => b.click());
                await new Promise(r => setTimeout(r, 400));
                row = findRow();
            }
        }

        if (!row) {
            return { error: 'Conversation not found: ' + (targetTitle || targetId) };
        }
        if (!isVisible(row)) {
            return { error: 'Conversation row is not visible: ' + (targetTitle || targetId) };
        }

        clickRow(row);
        return { success: true, method: targetId ? 'convo_pill_id' : 'convo_pill_title' };
    } catch (e) {
        return { error: e.toString() };
    }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                if (val.success) return val;
            }
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

function scheduleDesktopConversationFocus(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id || desktopFocusTasks.has(id)) return;
    const operation = (async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const cdp = cdpConnection;
            if (cdp) {
                const result = await selectChat(cdp, '', id);
                if (result.success) return;
            }
            await new Promise((resolve) => setTimeout(resolve, 650));
        }
    })();
    desktopFocusTasks.set(id, operation);
    void operation.finally(() => desktopFocusTasks.delete(id));
}

/**
 * Check if a chat is currently open (has a cascade/conversation element).
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{hasChat: boolean, hasMessages: boolean, editorFound: boolean}>}
 */
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 60) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const chatContainer =
        ['conversation', 'chat', 'cascade']
            .map(id => document.getElementById(id))
            .find(isVisible) ||
        document.querySelector('main, [role="main"], section, article, div[class*="scrollbar-hide"], div[class*="gap-y-3"][class*="px-4"]');
    const editors = Array.from(document.querySelectorAll('[contenteditable="true"], [data-lexical-editor="true"], textarea'))
        .filter(isVisible);
    const startButtons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter((el) => isVisible(el) && /start new chat|new chat|new conversation/i.test((el.innerText || el.textContent || '').trim()));
    const hasMessages = !!(chatContainer && (
        chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0 ||
        chatContainer.querySelectorAll('div[class*="items-start"]').length > 0
    ));
    return {
        hasChat: !!chatContainer || startButtons.length > 0,
        hasMessages: hasMessages,
        editorFound: editors.length > 0
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                if (val.hasChat || val.hasMessages || val.editorFound) {
                    return val;
                }
            }
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

/**
 * Get the current app state — active mode and AI model.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{mode: string, model: string, error?: string} | {error: string}>}
 */
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for leaf text nodes containing a known model keyword
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes2 = allEls.filter(el => el.children.length === 0 && el.innerText);
        
        // First try: find inside a clickable parent (button, cursor:pointer)
        let modelEl = textNodes2.find(el => {
            const txt = el.innerText.trim();
            if (!KNOWN_MODELS.some(k => txt.includes(k))) return false;
            // Must be in a clickable context (header/toolbar, not chat content)
            let parent = el;
            for (let i = 0; i < 8; i++) {
                if (!parent) break;
                if (parent.tagName === 'BUTTON' || window.getComputedStyle(parent).cursor === 'pointer') return true;
                parent = parent.parentElement;
            }
            return false;
        });
        
        // Fallback: any leaf node with a known model name
        if (!modelEl) {
            modelEl = textNodes2.find(el => {
                const txt = el.innerText.trim();
                return KNOWN_MODELS.some(k => txt.includes(k)) && txt.length < 60;
            });
        }

        if (modelEl) {
            state.model = modelEl.innerText.trim();
        }

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                if (val.mode !== 'Unknown' || val.model !== 'Unknown') return val;
            }
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

/**
 * Identify and click the waiting action button (Accept/Run/Allow vs Reject/Deny)
 * @param {import('./state.js').CDPConnection} cdp
 * @param {'accept' | 'reject'} action
 * @returns {Promise<{success?: boolean, error?: string}>}
 */
/**
 * Check if a permission prompt dialog is actually visible on screen (excludes chat history).
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<boolean>}
 */
async function hasPendingActionVisible(cdp) {
    const EXP = `(() => {
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };

        const promptPattern = /allow (running|writing|replacing|deleting)/i;
        const visibleArticles = Array.from(document.querySelectorAll('[role="article"]'))
            .filter(article => isVisible(article));
        const latestArticle = visibleArticles.at(-1) || null;
        const submitBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(b => isVisible(b))
            .filter(b => {
                const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                return t === 'submit' || t === 'proceed' || t === 'allow once';
            });
            
        for (const btn of submitBtns) {
            const modal = btn.closest('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]');
            const article = btn.closest('[role="article"]');
            if (!modal && article && article !== latestArticle) continue;
            let parent = modal || btn.parentElement;
            let steps = 0;
            while (parent && parent !== document.body && steps < 6) {
                const text = (parent.innerText || parent.textContent || '').toLowerCase();
                const hasChoices = !!parent.querySelector('[role="radio"], [role="option"], input[type="radio"], label');
                if (text.length < 5000 && promptPattern.test(text) && hasChoices) {
                    return true;
                }
                parent = parent.parentElement;
                steps++;
            }
        }
        return false;
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return true;
        } catch (e) {}
    }
    return false;
}

/**
 * Scrape the active permission prompt's title and multiple-choice options list.
 * @param {import('./state.js').CDPConnection} cdp
 * @returns {Promise<{title: string, options: string[]} | null>}
 */
async function getPendingActionDetails(cdp) {
    const EXP = `(() => {
        try {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 5 || rect.height < 5) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden';
            };

            const promptPattern = /allow (running|writing|replacing|deleting)/i;
            const visibleArticles = Array.from(document.querySelectorAll('[role="article"]'))
                .filter(article => isVisible(article));
            const latestArticle = visibleArticles.at(-1) || null;
            const submitBtns = Array.from(document.querySelectorAll('button, [role="button"]'))
                .filter(b => isVisible(b))
                .filter(b => {
                    const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return t === 'submit' || t === 'proceed' || t === 'allow once';
                });
                
            let activePrompt = null;
            let titleText = 'Action Required';
            for (const btn of submitBtns) {
                const modal = btn.closest('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]');
                const article = btn.closest('[role="article"]');
                if (!modal && article && article !== latestArticle) continue;
                let parent = modal || btn.parentElement;
                let steps = 0;
                while (parent && parent !== document.body && steps < 6) {
                    const text = (parent.innerText || parent.textContent || '').toLowerCase();
                    const hasChoices = !!parent.querySelector('[role="radio"], [role="option"], input[type="radio"], label');
                    if (text.length < 5000 && promptPattern.test(text) && hasChoices) {
                        activePrompt = parent;
                        const titleEl = Array.from(parent.querySelectorAll('h1, h2, h3, h4, h5, div, p, span'))
                            .find(el => {
                                if (el.children.length > 3) return false;
                                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                                return t.includes('allow running this command') || t.includes('allow running') || t.includes('allow writing') || t.includes('allow replacing') || t.includes('allow deleting');
                            });
                        if (titleEl) titleText = (titleEl.innerText || titleEl.textContent).trim();
                        break;
                    }
                    parent = parent.parentElement;
                    steps++;
                }
                if (activePrompt) break;
            }

            if (!activePrompt) return { title: 'Action Required', options: [] };

            // Each option row renders twice in the tree walk: once as the row (with its
            // hotkey number, e.g. "1 Yes, allow this time") and once as the inner label
            // ("Yes, allow this time"). Normalize away the hotkey prefix and dedupe on
            // the normalized key so each option appears exactly once, without the number.
            const seenOptions = new Map();
            const allEls = Array.from(activePrompt.querySelectorAll('div, span, button, [role="button"], [role="option"], [role="radio"], label, li')).filter(isVisible);
            allEls.forEach(el => {
                if (el.children.length > 5) return;
                const rawText = (el.innerText || el.textContent || '').trim();
                if (rawText.split('\\n').length > 3) return; // Ignore giant parent containers

                const text = rawText.replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim();
                const lower = text.toLowerCase();

                if (lower === 'submit' || lower === 'skip' || lower === 'cancel' || lower === 'proceed') return;
                if (lower.length > 100) return;

                if (
                    lower.includes('allow this time') ||
                    lower.includes('always allow') ||
                    lower.includes('allow once') ||
                    lower.startsWith('yes,') ||
                    lower.startsWith('no (') ||
                    lower === 'yes' ||
                    lower === 'no' ||
                    /^\\d+\\s+.*allow/i.test(text) ||
                    /^\\d+\\s+.*no/i.test(text) ||
                    /^\\d+\\s+.*yes/i.test(text) ||
                    /^\\d+\\s+.*always/i.test(text)
                ) {
                    const label = text.replace(/^\\d+\\s+/, '');
                    const key = label.toLowerCase();
                    if (label && !seenOptions.has(key)) seenOptions.set(key, label);
                }
            });

            const uniqueOptions = Array.from(seenOptions.values());

            let commandContext = '';
            const codeEls = Array.from(activePrompt.querySelectorAll('pre, code, [class*="font-mono"]'));
            if (codeEls.length > 0) {
                commandContext = (codeEls[0].innerText || codeEls[0].textContent).trim();
            }

            return {
                title: titleText,
                options: uniqueOptions,
                context: commandContext
            };
        } catch (e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value && res.result.value.options?.length > 0) {
                return res.result.value;
            }
        } catch (e) {}
    }
    return null;
}

async function completePendingAction(cdp, action, selectedOption = null) {
    const isAccept = action === 'accept';
    const EXP = `(async () => {
        try {
            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width < 5 || rect.height < 5) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden';
            };

            const optionSelectors = 'div, span, button, [role="button"], [role="option"], [role="radio"], label, li, a';
            const dangerousTexts = ['always run', 'trust workspace', 'trust this workspace'];

            // Find the active prompt container to scope our clicks
            const submitBtnsAll = Array.from(document.querySelectorAll('button, [role="button"], a'))
                .filter(b => isVisible(b))
                .filter(b => {
                    const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return t === 'submit' || t === 'proceed' || t === 'allow once' || t.includes('submit') || t.includes('proceed');
                });
                
            let activePrompt = null;
            for (const btn of submitBtnsAll) {
                let parent = btn.parentElement;
                let steps = 0;
                while (parent && parent !== document.body && steps < 15) {
                    const text = (parent.innerText || parent.textContent || '').toLowerCase();
                    if (text.includes('allow running this command') || text.includes('allow running') || text.includes('allow writing') || text.includes('allow replacing') || text.includes('allow deleting')) {
                        activePrompt = parent;
                        break;
                    }
                    parent = parent.parentElement;
                    steps++;
                }
                if (activePrompt) break;
            }

            const searchRoot = activePrompt || document;

            // Normalize whitespace so option rows whose innerText contains newlines
            // (hotkey badge + label on separate lines) still match the requested label.
            const normText = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const stripHotkey = (s) => s.replace(/^\\d+\\s+/, '');

            const findVisibleByTextScoped = (selector, texts, avoidTexts = []) => {
                const els = Array.from(searchRoot.querySelectorAll(selector))
                    .filter(el => isVisible(el));
                for (const text of texts) {
                    const found = els.find(el => {
                        const t = normText(el);
                        if (avoidTexts.some(a => t.includes(a))) return false;
                        return t === text || stripHotkey(t) === text;
                    });
                    if (found) return found;
                }
                for (const text of texts) {
                    const matches = els.filter(el => {
                        const t = normText(el);
                        if (avoidTexts.some(a => t.includes(a))) return false;
                        return t.startsWith(text) || t.includes(text);
                    });
                    if (matches.length > 0) {
                        // Prefer the most specific (shortest-text) match — a loose
                        // includes() would otherwise hit the outermost container first.
                        matches.sort((a, b) => normText(a).length - normText(b).length);
                        return matches[0];
                    }
                }
                return null;
            };

            // 1. If a specific option text was requested, click it
            const requestedOptionRaw = ${selectedOption ? JSON.stringify(String(selectedOption).replace(/\s+/g, ' ').trim().toLowerCase()) : 'null'};
            if (requestedOptionRaw) {
                const requestedVariants = [requestedOptionRaw];
                const withoutHotkey = stripHotkey(requestedOptionRaw);
                if (withoutHotkey !== requestedOptionRaw) requestedVariants.push(withoutHotkey);
                const targetOption = findVisibleByTextScoped(optionSelectors, requestedVariants);
                if (targetOption) {
                    targetOption.click();
                    await new Promise(r => setTimeout(r, 250));

                    const submitBtn = findVisibleByTextScoped('button, [role="button"], a', ['submit', 'proceed', 'confirm', 'allow', 'accept', 'reject', 'deny']);
                    if (submitBtn) {
                        submitBtn.click();
                        return { success: true, method: 'multiple_choice_specific_submit' };
                    }
                    // The requested option is selected; do NOT fall through to the default
                    // path — it would re-click option 1 and override the user's choice.
                    return { error: 'Option selected but Submit button not found' };
                }
                return { error: 'Requested option not found: ' + requestedOptionRaw };
            }

            // 2. Otherwise try default choice clicks
            if (${isAccept}) {
                const safeOption = findVisibleByTextScoped(optionSelectors, [
                    'yes, allow this time', 
                    'allow this time', 
                    'allow once', 
                    'yes, allow',
                    'yes'
                ], dangerousTexts);

                if (safeOption) {
                    safeOption.click();
                    await new Promise(r => setTimeout(r, 200));

                    const submitBtn = findVisibleByTextScoped('button, [role="button"], a', ['submit', 'proceed', 'confirm', 'allow', 'accept']);
                    if (submitBtn) {
                        submitBtn.click();
                        return { success: true, method: 'multiple_choice_safe_submit' };
                    }
                }
            } else {
                const rejectOption = findVisibleByTextScoped(optionSelectors, [
                    'no (tell',
                    'no',
                    'reject',
                    'deny'
                ]);

                if (rejectOption) {
                    rejectOption.click();
                    await new Promise(r => setTimeout(r, 200));

                    const submitBtn = findVisibleByTextScoped('button, [role="button"], a', ['submit', 'proceed', 'confirm', 'reject', 'deny']);
                    if (submitBtn) {
                        submitBtn.click();
                        return { success: true, method: 'multiple_choice_reject_submit' };
                    }
                }
            }

            const allBtns = Array.from(searchRoot.querySelectorAll('button, [role="button"], a'));
            const acceptTexts = ['run command', 'allow', 'accept', 'run', 'yes', 'confirm',
                                 'allow once', 'allow this conversation', 'continue', 'proceed', 'submit'];
            const rejectTexts = ['reject', 'deny', 'cancel', 'no', 'abort'];
            
            const targetTexts = ${isAccept} ? acceptTexts : rejectTexts;
            const visibleBtns = allBtns.filter(btn => isVisible(btn));
            
            const targetBtns = visibleBtns.filter(btn => {
                const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                if (dangerousTexts.some(d => text.includes(d))) return false;
                return targetTexts.some(t => text === t || text.startsWith(t) || text.includes(t));
            });
            
            if (targetBtns.length === 0) {
                return { error: 'Action button not found' };
            }
            
            let clicked = 0;
            for (let i = 0; i < targetBtns.length; i++) {
                const delay = i * 800;
                if (delay > 0) await new Promise(r => setTimeout(r, delay));
                targetBtns[i].click();
                clicked++;
            }
            return { success: true, buttonsClicked: clicked, method: 'fallback_buttons' };
        } catch (e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) {}
    }
    return { error: 'Context failed' };
}

// hashString → src/utils/hash.js
// isLocalRequest → src/utils/network.js
// initCDP → src/cdp/connection.js

/**
 * Background polling with exponential backoff and CDP status broadcast.
 * @param {import('ws').WebSocketServer} wss
 * @returns {Promise<void>}
 */
/**
 * Inspect only the small amount of live UI state needed to detect when a
 * response starts and finishes. Unlike captureSnapshot, this does not clone or
 * serialize the conversation DOM.
 * @param {import('./state.js').CDPConnection} cdp
 */
async function inspectAgentState(cdp) {
    const EXP = `(() => {
        const isVisible = (element) => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const stopSelectors = [
            '[data-tooltip-id="input-send-button-cancel-tooltip"]',
            'button svg.lucide-square',
            'button[aria-label*="stop" i]',
            'button[title*="stop" i]'
        ];
        const busy = stopSelectors.some(selector => {
            const found = document.querySelector(selector);
            const button = found?.closest?.('button') || found;
            return isVisible(button);
        });
        const articles = Array.from(document.querySelectorAll('[role="article"]'))
            .filter(isVisible);
        const latest = articles.at(-1) || null;
        const latestText = (latest?.innerText || latest?.textContent || '')
            .replace(/\\s+/g, ' ')
            .trim()
            .slice(-6000);
        const latestRole = latest?.querySelector('[data-testid="user-input-step"]')
            ? 'user'
            : latest ? 'assistant' : 'none';
        return {
            busy,
            latestText,
            latestRole,
            path: location.pathname,
            hasChat: articles.length > 0
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call('Runtime.evaluate', {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (result.result?.value) {
                const value = result.result.value;
                value.signature = hashString(`${value.latestRole}:${value.latestText}`);
                return value;
            }
        } catch (e) {}
    }
    return null;
}

function processAgentProbe(probe, hasPendingAction) {
    if (!probe) return;
    const previous = lastAgentProbe;
    const rpcOwnsCompletion = Boolean(
        conversationReadService.getActiveConversationId()
    );
    const cancellationChanged =
        probe.latestRole === 'assistant' &&
        probe.signature !== previous?.signature &&
        isCancellationMessage(probe.latestText);

    if (cancellationChanged && !rpcOwnsCompletion) {
        responseWatch.active = false;
        pendingAgentCompletion = true;
        broadcastAgentState('cancelled');
        requestSnapshotRefresh('response_cancelled');
        lastAgentProbe = probe;
        return;
    }

    if (!responseWatch.active && probe.busy && !previous?.busy) {
        beginResponseWatch();
    }

    if (responseWatch.active) {
        if (hasPendingAction) {
            broadcastAgentState('permission_required');
        } else if (probe.busy) {
            responseWatch.observedBusy = true;
            responseWatch.stableTicks = 0;
            broadcastAgentState('responding');
        } else if (rpcOwnsCompletion) {
            // Structured RPC status owns completion for a selected conversation.
            // DOM text can lag or freeze while Antigravity is minimized or locked.
            broadcastAgentState('preparing');
        } else {
            const responseChanged =
                probe.latestRole === 'assistant' &&
                probe.signature !== responseWatch.baselineSignature;
            if (responseChanged && probe.signature === responseWatch.lastSignature) {
                responseWatch.stableTicks += 1;
            } else {
                responseWatch.lastSignature = probe.signature;
                responseWatch.stableTicks = 0;
            }

            const stableResponse = responseChanged && responseWatch.stableTicks >= 2;
            const busyFinished =
                responseWatch.observedBusy &&
                responseChanged &&
                Date.now() - responseWatch.startedAt > 1200;
            if (stableResponse || busyFinished) {
                responseWatch.active = false;
                pendingAgentCompletion = true;
                requestSnapshotRefresh('response_complete');
            } else if (!hasPendingAction) {
                broadcastAgentState('preparing');
            }
        }
    } else if (!hasPendingAction && probe.signature !== lastCapturedProbeSignature) {
        if (probe.signature === idleCandidateSignature) {
            idleStableTicks += 1;
        } else {
            idleCandidateSignature = probe.signature;
            idleStableTicks = 0;
        }
        if (idleStableTicks >= 2) {
            requestSnapshotRefresh('stable_content_change');
        }
    } else {
        idleCandidateSignature = '';
        idleStableTicks = 0;
    }

    lastAgentProbe = probe;
}

async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;
    let reconnectDelay = 2000; // Start at 2s, max 30s
    const MAX_RECONNECT_DELAY = 30000;
    let reconnectAttempts = 0;
    let heartbeatInterval = null;
    let lastAgentNotificationKey = '';
    let lastActionNotificationTime = 0;
    let actionWasPending = false;
    let lastAutoApprovalTime = 0;
    let lastDialogErrorTime = 0;
    let rpcPollInFlight = false;

    // WebSocket ping/pong heartbeat (every 30s)
    heartbeatInterval = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping();
            }
        });
    }, 30000);

    // Keep response detection independent from legacy CDP inspection. Renderer
    // calls can stall while Windows is locked, but the Language Server remains
    // responsive and should still deliver the final answer promptly.
    setInterval(async () => {
        if (rpcPollInFlight || !responseWatch.active) return;
        rpcPollInFlight = true;
        try {
            await pollActiveRpcConversation();
        } catch (_) { 
            // A later tick retries transient Language Server failures.
        } finally {
            rpcPollInFlight = false;
        }
    }, POLL_INTERVAL);

    // Broadcast CDP status to all mobile clients
    /** @param {string} status */
function broadcastCDPStatus(status) {
        broadcast({ type: 'cdp_status', status, timestamp: new Date().toISOString() });
    }

    const poll = async () => {
        // Periodically refresh available targets list (multi-window)
        try {
            availableTargets = await discoverAllCDP();
            if (!activeTargetId && availableTargets.length === 1) {
                activeTargetId = availableTargets[0].id;
            }
        } catch (e) { /* ignore */ }

        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
                broadcastCDPStatus('reconnecting');
            }
            if (cdpConnection) {
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                await stopScreencast();
                cdpConnection = null;
            }
            try {
                cdpConnection = await initCDP();
                if (cdpConnection) {
                    console.log('✅ CDP Connection established from polling loop');
                    isConnecting = false;
                    reconnectDelay = 2000; // Reset backoff
                    reconnectAttempts = 0;
                    sessionStats.increment('reconnections');
                    sessionStats.logAction('cdp_reconnected');
                    broadcastCDPStatus('connected');
                }
            } catch (e) { const err = /** @type {Error} */ (e);
                reconnectAttempts++;
                reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
                if (reconnectAttempts % 5 === 0) {
                    console.log(`   ⏳ Reconnect attempt #${reconnectAttempts} (next in ${Math.round(reconnectDelay/1000)}s)`);
                }
            }
            setTimeout(poll, reconnectDelay);
            return;
        }

        try {
            // ─── Dialog Error Scanner (outside chat container) ────────
            // Scans for full-page modal errors in ALL CDP contexts
            // Pattern from tody-agent/AntigravityMobile:checkErrorDialogs
            const nowTime = Date.now();
            if (nowTime - lastDialogErrorTime > 30000) { // 30s cooldown
                try {
                    const dialogError = await checkErrorDialogs(cdpConnection);
                    if (dialogError) {
                        lastDialogErrorTime = nowTime;
                        sessionStats.increment('dialogErrorsDetected');
                        sessionStats.logError(dialogError.type, dialogError.error);
                        const typeEmoji = {
                            terminated: '💀', quota: '📊', rate_limit: '⏱️',
                            high_traffic: '🔥', server_error: '💥', network_error: '🌐'
                        };
                        const emoji = typeEmoji[dialogError.type] || '🚨';
                        console.log(`${emoji} Dialog error detected: [${dialogError.type}] ${dialogError.error}`);
                        broadcast({
                            type: 'notification',
                            event: 'dialog_error',
                            errorType: dialogError.type,
                            message: `${emoji} ${dialogError.error}`,
                            timestamp: new Date().toISOString()
                        });
                        sendTelegramNotification(`${emoji} <b>Antigravity Alert:</b> ${dialogError.error}`).then((sent) => {
                            trackTelegramNotification(sent);
                        }).catch(() => {});
                    }
                } catch (dialogErr) {
                    // non-critical — don't break polling
                }
            }

            const probe = await inspectAgentState(cdpConnection);
            const hasPendingAction = await hasPendingActionVisible(cdpConnection);
            processAgentProbe(probe, hasPendingAction);

            if (hasPendingAction !== actionWasPending) {
                requestSnapshotRefresh(
                    hasPendingAction ? 'permission_required' : 'permission_cleared'
                );
            }

            const heartbeatDue =
                !responseWatch.active &&
                Date.now() - lastSnapshotCaptureAt >= 60000;
            const shouldCapture =
                snapshotRefreshRequested ||
                !lastSnapshot ||
                heartbeatDue;

            if (!shouldCapture) {
                setTimeout(poll, POLL_INTERVAL);
                return;
            }

            const captureReason = snapshotRefreshRequested
                ? snapshotRequestReason
                : 'heartbeat';
            snapshotRefreshRequested = false;
            const snapshot = await captureSnapshot(cdpConnection);
            lastSnapshotCaptureAt = Date.now();
            if (snapshot && !snapshot.error) {
                sessionStats.increment('snapshotsProcessed');
                const hash = hashString(snapshot.html);
                lastCapturedProbeSignature = probe?.signature || lastCapturedProbeSignature;
                idleCandidateSignature = '';
                idleStableTicks = 0;

                // 1. Check for Pending Actions (e.g., Run command) with specific cooldown
                if (hasPendingAction) {
                    actionWasPending = true;
                    if (aiSupervisor.isSuggestModeEnabled()) {
                        const commandText = extractPendingCommand(snapshot.html);
                        if (!suggestQueue.hasPendingCommand(commandText)) {
                            try {
                                const review = await aiSupervisor.reviewPendingAction({ html: snapshot.html });
                                const result = suggestQueue.add({
                                    action: review.suggestedAction,
                                    command: review.commandText,
                                    reason: review.reason,
                                    source: review.source,
                                    summary: review.summary
                                });
                                if (result.created) {
                                    console.log(`📝 Supervisor queued suggestion (${review.suggestedAction}) for pending action`);
                                }
                            } catch (e) { const error = /** @type {Error} */ (e);
                                console.warn(`Supervisor suggest-mode review failed: ${error.message}`);
                            }
                        }
                    } else {
                        if (nowTime - lastAutoApprovalTime > 15000) {
                            try {
                                const decision = await aiSupervisor.shouldApprove({ html: snapshot.html });
                                if (decision.approved) {
                                    const approval = await completePendingAction(cdpConnection, 'accept');
                                    if (approval.success) {
                                        lastAutoApprovalTime = nowTime;
                                        lastActionNotificationTime = nowTime;
                                        sessionStats.increment('actionsApproved');
                                        sessionStats.increment('actionsAutoApproved');
                                        sessionStats.logAction('action_auto_approved', {
                                            reason: decision.reason
                                        });
                                        broadcast({
                                            type: 'notification',
                                            event: 'action_auto_approved',
                                            message: `Supervisor local aprovou a acao pendente (${decision.reason}).`,
                                            timestamp: new Date().toISOString()
                                        });
                                        sendTelegramNotification('✅ <b>Antigravity Supervisor:</b> uma aprovacao segura foi liberada automaticamente.').then((sent) => {
                                            trackTelegramNotification(sent);
                                        }).catch(() => {});
                                    }
                                }
                            } catch (e) { const error = /** @type {Error} */ (e);
                                console.warn(`Supervisor check failed: ${error.message}`);
                            }
                        }

                        if (nowTime - lastActionNotificationTime > 15000 && nowTime - lastAutoApprovalTime > 5000) {
                            lastActionNotificationTime = nowTime;
                            getPendingActionDetails(cdpConnection).then(actionDetails => {
                                const msg = actionDetails ? actionDetails.title : 'Agent requires approval format (Run Command).';
                                const options = actionDetails ? actionDetails.options : [];
                                const contextStr = actionDetails ? actionDetails.context : '';
                                broadcast({
                                    type: 'notification',
                                    event: 'action_required',
                                    message: msg,
                                    options: options,
                                    context: contextStr,
                                    timestamp: new Date().toISOString()
                                });
                                console.log(`⚠️ Alert triggered: Action Pending - ${msg}`);
                            }).catch(err => {
                                console.error('Failed to get pending action details:', err);
                                broadcast({
                                    type: 'notification',
                                    event: 'action_required',
                                    message: 'Agent requires approval format (Run Command).',
                                    options: [],
                                    timestamp: new Date().toISOString()
                                });
                            });
                            
                            sendTelegramNotification('⚠️ <b>Antigravity Action Required!</b>\nO Agente parou a execução e aguarda aprovação manual.').then((sent) => {
                                trackTelegramNotification(sent);
                            }).catch(() => {});
                        }
                    }
                } else if (actionWasPending) {
                    actionWasPending = false;
                    lastActionNotificationTime = 0;
                    broadcast({
                        type: 'notification',
                        event: 'action_cleared',
                        timestamp: new Date().toISOString()
                    });
                }

                // 2. Notify only from the newest assistant response for this
                // send. Scanning the complete transcript re-fired old errors.
                const agentNotification = classifyCurrentAgentNotification({
                    probe,
                    responseWatch
                });
                if (
                    agentNotification &&
                    agentNotification.key !== lastAgentNotificationKey
                ) {
                        lastAgentNotificationKey = agentNotification.key;
                        const notifyType = agentNotification.event;
                        const notifyMessage = agentNotification.message;
                        if (notifyType === 'quota_error') {
                            sessionStats.increment('quotaWarnings');
                            sessionStats.logError('quota', notifyMessage);
                        } else if (notifyType === 'agent_error') {
                            sessionStats.logError('agent_error', notifyMessage);
                        } else if (notifyType === 'rate_limit') {
                            sessionStats.increment('rateLimitHits');
                            sessionStats.logError('rate_limit', notifyMessage);
                        } else if (notifyType === 'task_completed') {
                            sessionStats.logAction('task_completed');
                        }
                        broadcast({
                            type: 'notification',
                            event: notifyType,
                            message: notifyMessage,
                            timestamp: new Date().toISOString()
                        });
                        console.log(`⚠️ Alert triggered: ${notifyMessage}`);
                        
                        const emoji = notifyType === 'task_completed' ? '✅' : '🚨';
                        sendTelegramNotification(`${emoji} <b>Antigravity Notification:</b> ${notifyMessage}`).then((sent) => {
                            trackTelegramNotification(sent);
                        }).catch(() => {});
                }
                // ---------------------------------------------------------------

                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;
                    sessionStats.increment('snapshotUpdatesBroadcast');
                    broadcast({
                        type: 'snapshot_update',
                        timestamp: new Date().toISOString()
                    });

                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
                if (pendingAgentCompletion) {
                    pendingAgentCompletion = false;
                    broadcastAgentState('complete');
                }
                if (captureReason !== 'heartbeat') {
                    sessionStats.logAction('snapshot_on_demand', {
                        reason: captureReason
                    });
                }
            } else {
                setTimeout(() => requestSnapshotRefresh('capture_retry'), 5000);
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    sessionStats.logError('snapshot_capture', errorMsg);
                    console.warn(`⚠️  Snapshot capture issue: ${errorMsg} `);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in Antigravity)');
                    }
                    if (cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Antigravity window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (e) { const err = /** @type {Error} */ (e);
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

// Create Express app
async function createServer() {
    const app = express();
    await ensureWorkspaceData();

    // Check for SSL certificates
    const keyPath = join(PROJECT_ROOT, 'certs', 'server.key');
    const certPath = join(PROJECT_ROOT, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });
    websocketServer = wss;
    await screenshotTimeline.init();
    if (!suggestionQueueUnsubscribe) {
        suggestionQueueUnsubscribe = suggestQueue.subscribe((event, payload) => {
            if (event === 'added') {
                sessionStats.increment('suggestionsCreated');
                sessionStats.logAction('suggestion_created', {
                    action: payload.action,
                    reason: payload.reason
                });
            } else if (event === 'approved') {
                sessionStats.increment('suggestionsApproved');
                sessionStats.logAction('suggestion_approved', {
                    action: payload.action
                });
            } else if (event === 'rejected') {
                sessionStats.increment('suggestionsRejected');
                sessionStats.logAction('suggestion_rejected', {
                    action: payload.action
                });
            } else if (event === 'expired' && payload?.command) {
                sessionStats.logAction('suggestion_expired', {
                    command: payload.command
                });
            }

            if (event === 'added') {
                broadcast({
                    type: 'suggestion',
                    event: 'new_suggestion',
                    suggestion: payload,
                    pendingCount: suggestQueue.getPendingCount(),
                    timestamp: new Date().toISOString()
                });
                sendSuggestionRequired(payload).then((sent) => {
                    trackTelegramNotification(sent);
                }).catch(() => {});
            } else {
                broadcast({
                    type: 'suggestion',
                    event,
                    suggestion: payload?.id ? payload : null,
                    pendingCount: suggestQueue.getPendingCount(),
                    timestamp: new Date().toISOString()
                });
            }

            broadcastSuggestionState();
        });
    }
    if (!sessionStatsUnsubscribe) {
        sessionStatsUnsubscribe = sessionStats.subscribe(() => {
            broadcastStatsState();
        });
    }
    if (!quotaServiceUnsubscribe) {
        quotaServiceUnsubscribe = quotaService.subscribe((event, summary) => {
            broadcastQuotaState();
            if (event !== 'updated' || !Array.isArray(summary?.alerts) || !summary.alerts.length) {
                return;
            }

            const lines = summary.alerts.slice(0, 4).map((model) =>
                `• <b>${model.name}</b>: ${model.usagePercent}% used`
            );
            sendTypedNotification(
                'warning',
                [
                    '⚠️ <b>Model quota alert</b>',
                    ...lines,
                    summary.lastUpdated
                        ? `Updated: ${new Date(summary.lastUpdated).toLocaleTimeString()}`
                        : ''
                ].filter(Boolean).join('\n')
            ).then((sent) => {
                trackTelegramNotification(sent);
            }).catch(() => {});
        });
    }
    if (!timelineUnsubscribe) {
        timelineUnsubscribe = screenshotTimeline.subscribe((event, summary, payload) => {
            if (event === 'captured' && payload?.entry) {
                sessionStats.increment('timelineCaptures');
                sessionStats.logAction('timeline_capture_saved', {
                    reason: payload.entry.reason,
                    filename: payload.entry.filename
                });
            } else if (event === 'cleared') {
                sessionStats.logAction('timeline_cleared', {
                    cleared: payload?.cleared || 0
                });
            }

            broadcastTimelineState();
        });
    }
    quotaService.start();
    quotaService.refresh().catch(() => {});
    screenshotTimeline.start({
        getSnapshotHash: () => lastSnapshotHash || '',
        captureScreenshot: () => captureCurrentScreenshot({
            format: 'jpeg',
            quality: 70
        })
    });
    terminalManager.on('output', (entry) => {
        broadcast({ type: 'terminal_output', entry });
    });
    terminalManager.on('exit', (terminalState) => {
        broadcast({ type: 'terminal_state', state: terminalState });
    });
    Object.entries(tunnelManagers).forEach(([provider, manager]) => {
        manager.on('url', () => {
            tunnelProvider = provider;
            broadcastTunnelStatus();
        });
        manager.on('exit', () => {
            if (tunnelProvider === provider) {
                broadcastTunnelStatus();
            }
        });
    });

    // Initialize session security & token
    AUTH_TOKEN = hashString(APP_PASSWORD + AUTH_SALT + Date.now().toString());

    // Check for --launch argument
    if (process.argv.includes('--launch')) {
        console.log('CLI flag --launch detected. Spawning new Antigravity instance...');
        try {
            await launchAntigravity();
        } catch (e) {
            console.error('Failed to auto-launch Antigravity:', e.message);
        }
    }

    app.use(compression());
    app.use(express.json({ limit: JSON_BODY_LIMIT }));
    app.use(cookieParser(COOKIE_SECRET));
    app.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        next();
    });

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    const setupPagePath = join(PROJECT_ROOT, 'public', 'download.html');
    const mobileMetadataPath = join(PROJECT_ROOT, 'public', 'mobile-app.json');
    const preferredMobileApkPath = join(PROJECT_ROOT, 'public', 'liftoff.apk');
    const legacyMobileApkPath = join(PROJECT_ROOT, 'public', 'antigravity-remote.apk');
    const mobileApkPath = fs.existsSync(preferredMobileApkPath)
        ? preferredMobileApkPath
        : legacyMobileApkPath;
    const publicPaths = new Set([
        '/',
        '/download',
        '/download-qr.svg',
        '/mobile-app.json',
        '/liftoff.apk',
        '/antigravity-remote.apk',
        '/favicon.ico',
        '/setup-assets/download.css',
        '/setup-assets/download.js',
        '/setup-assets/liftoff-icon.png',
        '/login',
        '/api/discovery',
        '/api/desktop/status'
    ]);

    function getDownloadOrigin(req) {
        const requestOrigin = `${req.protocol}://${req.get('host')}`;
        const hostname = String(req.hostname || '').toLowerCase();
        if (
            pairingInfo?.url &&
            (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
        ) {
            return pairingInfo.url;
        }
        return requestOrigin;
    }

    function requireDesktopPassword(req, res, next) {
        const suppliedPassword = req.get('x-liftoff-password');
        if (!isDesktopPasswordValid(suppliedPassword, APP_PASSWORD)) {
            return res.status(401).json({ error: 'Invalid LiftOff password' });
        }
        return next();
    }

    function requireTrayManagement(_req, res, next) {
        if (!isTrayManaged()) {
            return res.status(409).json({
                error: 'This bridge was not started by the LiftOff tray app'
            });
        }
        return next();
    }

    // Authentication protects the companion API. Download/setup resources are
    // intentionally public so a new phone can install the app before pairing.
    app.use((req, res, next) => {
        if (publicPaths.has(req.path)) {
            return next();
        }

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            return next();
        }

        // Magic Link / QR Code Auto-Login
        if (req.query.key === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Remove the key from the URL by redirecting to the setup page.
            return res.redirect('/');
        }

        const token = req.signedCookies[AUTH_COOKIE_NAME];
        if (token === AUTH_TOKEN) {
            return next();
        }

        // If it's an API request, return 401, otherwise redirect to login
        if (
            req.xhr ||
            req.headers.accept?.includes('json') ||
            req.path.startsWith('/api/') ||
            ['/snapshot', '/send', '/chat-history', '/app-state', '/cdp-targets'].some(
                (path) => req.path.startsWith(path)
            )
        ) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/');
        }
    });

    app.get(['/', '/download'], (_req, res) => {
        res.sendFile(setupPagePath);
    });

    app.get('/setup-assets/download.css', (_req, res) => {
        res.sendFile(join(PROJECT_ROOT, 'public', 'css', 'download.css'));
    });

    app.get('/setup-assets/download.js', (_req, res) => {
        res.sendFile(join(PROJECT_ROOT, 'public', 'js', 'download.js'));
    });

    app.get(['/setup-assets/liftoff-icon.png', '/favicon.ico'], (_req, res) => {
        res.sendFile(join(PROJECT_ROOT, 'public', 'icons', 'liftoff-icon.png'));
    });

    app.get('/mobile-app.json', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(mobileMetadataPath);
    });

    app.get(['/liftoff.apk', '/antigravity-remote.apk'], (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.download(mobileApkPath, 'liftoff.apk');
    });

    app.get('/download-qr.svg', async (req, res) => {
        try {
            const downloadUrl = new URL('/liftoff.apk', `${getDownloadOrigin(req)}/`).toString();
            const svg = await QRCode.toString(downloadUrl, {
                type: 'svg',
                errorCorrectionLevel: 'M',
                margin: 1,
                width: 360,
                color: {
                    dark: '#10211d',
                    light: '#f3f1e8'
                }
            });
            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(svg);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(500).type('text/plain').send(`Unable to create download QR code: ${error.message}`);
        }
    });

    // The inherited browser client remains in source for rollback archaeology,
    // but it is no longer a served product surface.
    app.get([
        '/index.html',
        '/admin',
        '/admin.html',
        '/minimal',
        '/minimal.html',
        '/login.html'
    ], (_req, res) => {
        res.redirect(302, '/');
    });

    app.use('/uploads', express.static(uploadsDir));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Get current snapshot
    app.get('/snapshot', async (req, res) => {
        const requestedRevision = normalizeEntityTag(req.get('if-none-match'));
        const activeRpcConversationId = conversationReadService.getActiveConversationId();
        if (
            requestedRevision &&
            requestedRevision === lastRpcSnapshotRevision &&
            lastRpcConversation?.id === activeRpcConversationId &&
            Date.now() - lastRpcSnapshotLoadedAt < RPC_REVISION_FAST_PATH_MS
        ) {
            res.setHeader('ETag', formatEntityTag(requestedRevision));
            res.setHeader('Cache-Control', 'private, no-cache');
            return res.status(304).end();
        }
        let revision = await getRpcSnapshotRevision();
        if (revision && requestedRevision === revision) {
            res.setHeader('ETag', formatEntityTag(revision));
            res.setHeader('Cache-Control', 'private, no-cache');
            return res.status(304).end();
        }

        // The response watcher has already rendered the new revision before it
        // broadcasts snapshot_update. Reuse that exact snapshot instead of
        // downloading the complete trajectory a second time for Android.
        const freshRpcSnapshot =
            revision &&
            lastRpcSnapshotRevision === revision &&
            lastRpcConversation?.id === activeRpcConversationId
                ? lastRpcSnapshot
                : null;
        const rpcSnapshot = freshRpcSnapshot || await loadRpcSnapshot();
        const cachedRpcSnapshot =
            lastRpcSnapshot?.conversationId === activeRpcConversationId
                ? lastRpcSnapshot
                : null;
        if (activeRpcConversationId && !rpcSnapshot && !cachedRpcSnapshot) {
            return res.status(503).json({
                error: 'The selected conversation is still loading from Antigravity',
                source: 'language-server-rpc'
            });
        }
        const snapshot = rpcSnapshot || cachedRpcSnapshot || lastSnapshot;
        if (!snapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        revision = rpcSnapshot
            ? (lastRpcSnapshotRevision || revision || hashString(snapshot.html))
            : hashString(snapshot.html);
        if (requestedRevision && requestedRevision === revision) {
            res.setHeader('ETag', formatEntityTag(revision));
            res.setHeader('Cache-Control', 'private, no-cache');
            return res.status(304).end();
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('ETag', formatEntityTag(revision));
        res.setHeader('Cache-Control', 'private, no-cache');
        res.json({ ...snapshot, revision });
    });

    app.get('/api/conversations/:id/media/:stepIndex/:mediaIndex', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const stepIndex = Number.parseInt(String(req.params.stepIndex || ''), 10);
            const mediaIndex = Number.parseInt(String(req.params.mediaIndex || ''), 10);
            if (
                !conversationId ||
                !Number.isInteger(stepIndex) ||
                stepIndex < 0 ||
                !Number.isInteger(mediaIndex) ||
                mediaIndex < 0
            ) {
                return res.status(400).json({ error: 'Invalid conversation image reference' });
            }

            const conversation =
                lastRpcConversation?.id === conversationId
                    ? lastRpcConversation
                    : await conversationReadService.loadConversation(
                        conversationId,
                        { force: false }
                    );
            const media = findTrajectoryMedia(
                conversation?.messages,
                stepIndex,
                mediaIndex
            );
            if (!media) {
                return res.status(404).json({ error: 'Conversation image not found' });
            }

            const mimeType = String(media.mimeType || 'image/png').toLowerCase();
            const inlineData = String(media.inlineData || '').replace(/\s+/g, '');
            if (
                !mimeType.startsWith('image/') ||
                !inlineData ||
                inlineData.length > Math.ceil(MAX_RPC_IMAGE_BYTES * 4 / 3) + 8
            ) {
                return res.status(413).json({ error: 'Conversation image is unavailable' });
            }
            const image = Buffer.from(inlineData, 'base64');
            if (!image.length || image.length > MAX_RPC_IMAGE_BYTES) {
                return res.status(413).json({ error: 'Conversation image is too large' });
            }

            res.setHeader('Content-Type', mimeType);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(image);
        } catch (_) {
            res.status(503).json({
                error: 'The conversation image is temporarily unavailable'
            });
        }
    });

    app.get('/api/conversations/:id/changes/:stepIndex', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const stepIndex = Number.parseInt(String(req.params.stepIndex || ''), 10);
            if (!conversationId || !Number.isInteger(stepIndex) || stepIndex < 0) {
                return res.status(400).json({ error: 'Invalid file-change reference' });
            }

            const changes = await conversationReadService.loadConversationFileChanges(
                conversationId,
                stepIndex,
                { force: false }
            );
            if (!changes.length) {
                return res.status(404).json({ error: 'File changes not found' });
            }
            const totalBytes = changes.reduce(
                (total, change) => total + Buffer.byteLength(String(change.diff || '')),
                0
            );
            if (totalBytes > MAX_RPC_DIFF_BYTES) {
                return res.status(413).json({ error: 'This file-change set is too large to display' });
            }
            res.setHeader('Cache-Control', 'private, no-store');
            res.json({
                conversationId,
                files: changes.map((change) => ({
                    name: change.name,
                    path: change.path,
                    diff: change.diff,
                    additions: change.additions,
                    deletions: change.deletions
                }))
            });
        } catch (_) {
            res.status(503).json({
                error: 'The file changes are temporarily unavailable'
            });
        }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1, // WebSocket.OPEN = 1
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: hasSSL,
            clients: getOpenClientCount(),
            tunnel: {
                provider: tunnelProvider,
                ...getTunnelStatus()
            },
            version: VERSION
        });
    });

    // Public metadata lets discovery clients verify that they found this app.
    // Passwords and authentication tokens are never returned here.
    app.get('/api/discovery', (req, res) => {
        res.json({
            service: 'antigravity-remote',
            ...(pairingInfo || { version: VERSION }),
            discoveryPort: DISCOVERY_PORT
        });
    });

    app.get('/api/desktop/status', (_req, res) => {
        const trayState = readTrayState();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            running: true,
            managed: isTrayManaged(),
            version: VERSION,
            uptime: process.uptime(),
            startedAt: serverStartedAt,
            https: hasSSL,
            autostart: trayState.autostart,
            trayStateUpdatedAt: trayState.updatedAt
        });
    });

    app.get('/api/desktop/logs', requireDesktopPassword, (req, res) => {
        const requestedLimit = Number(req.query.limit || 80);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(200, Math.max(20, Math.trunc(requestedLimit)))
            : 80;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ logs: getServerLogs(limit) });
    });

    app.post(
        '/api/desktop/restart',
        requireDesktopPassword,
        requireTrayManagement,
        (_req, res) => {
            res.status(202).json({ success: true, message: 'Restart requested' });
            setTimeout(() => emitTrayCommand('restart'), 50);
        }
    );

    app.post(
        '/api/desktop/stop',
        requireDesktopPassword,
        requireTrayManagement,
        (_req, res) => {
            res.status(202).json({ success: true, message: 'Stop requested' });
            setTimeout(() => emitTrayCommand('stop'), 50);
        }
    );

    app.post(
        '/api/desktop/autostart',
        requireDesktopPassword,
        requireTrayManagement,
        (req, res) => {
            if (typeof req.body?.enabled !== 'boolean') {
                return res.status(400).json({ error: 'enabled must be a boolean' });
            }
            const command = req.body.enabled ? 'autostart:on' : 'autostart:off';
            res.status(202).json({
                success: true,
                message: req.body.enabled
                    ? 'Start with Windows requested'
                    : 'Start with Windows disabled request accepted'
            });
            setTimeout(() => emitTrayCommand(command), 50);
        }
    );

    // SSL status endpoint
    app.get('/ssl-status', (req, res) => {
        const keyPath = join(PROJECT_ROOT, 'certs', 'server.key');
        const certPath = join(PROJECT_ROOT, 'certs', 'server.cert');
        const certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
        res.json({
            enabled: hasSSL,
            certsExist: certsExist,
            message: hasSSL ? 'HTTPS is active' :
                certsExist ? 'Certificates exist, restart server to enable HTTPS' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node scripts/generate_ssl.js', { cwd: PROJECT_ROOT, stdio: 'pipe' });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    });

    // Debug UI Endpoint
    app.get('/debug-ui', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    // Set Mode
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    // Set Model
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    // Get Available Models
    app.get('/api/models', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected', models: [] });
        try {
            const models = await scrapeAvailableModels(cdpConnection);
            if (models && models.length > 0) {
                return res.json({ success: true, models });
            }
            res.json({ success: false, error: 'Could not scrape models' });
        } catch (e) {
            const err = /** @type {Error} */ (e);
            res.status(500).json({ error: err.message });
        }
    });


    // Stop Generation
    app.post('/stop', async (req, res) => {
        let result;
        try {
            result = await conversationWriteService.cancel({
                fallback: async (rpcError) => {
                    if (!cdpConnection) throw rpcError;
                    const fallback = await stopGeneration(cdpConnection);
                    return {
                        ...fallback,
                        success: fallback.success === true,
                        method: fallback.method || 'cdp_fallback',
                        transport: 'cdp',
                        rpcFallbackReason: rpcError.code || 'RPC_UNAVAILABLE',
                        deduplicated: false
                    };
                }
            });
        } catch (e) {
            const error = /** @type {Error & {code?: string, mutationAttempted?: boolean}} */ (e);
            sessionStats.logError('generation_stop', error.message);
            return res.status(error.mutationAttempted ? 502 : 503).json({
                success: false,
                error: error.message,
                code: error.code || 'STOP_UNAVAILABLE',
                retrySafe: !error.mutationAttempted
            });
        }
        if (result.success) {
            responseWatch.active = false;
            broadcastAgentState('cancelled');
            if (result.transport === 'rpc') {
                conversationReadService.invalidateSummaries();
            } else {
                requestSnapshotRefresh('stop_requested');
            }
        }
        res.json(result);
    });

    // Interact with pending actions (Accept/Reject)
    app.post('/api/interact-action', async (req, res) => {
        const { action, selectedOption } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await completePendingAction(cdpConnection, action, selectedOption);
        if (result.success) {
            if (action === 'accept') {
                sessionStats.increment('actionsApproved');
            } else if (action === 'reject') {
                sessionStats.increment('actionsRejected');
            }
            sessionStats.logAction('manual_pending_action', { action, selectedOption });
        }
        res.json(result);
    });

    app.get('/api/suggestions', (req, res) => {
        res.json(getSuggestionState());
    });

    app.get('/api/suggestions/pending', (req, res) => {
        res.json({
            suggestMode: aiSupervisor.isSuggestModeEnabled(),
            pendingCount: suggestQueue.getPendingCount(),
            suggestions: suggestQueue.getPending()
        });
    });

    app.post('/api/suggestions/:id/approve', async (req, res) => {
        const result = await approveQueuedSuggestion(String(req.params.id || ''));
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });

    app.post('/api/suggestions/:id/reject', (req, res) => {
        const result = rejectQueuedSuggestion(String(req.params.id || ''));
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });

    app.delete('/api/suggestions', (req, res) => {
        const cleared = suggestQueue.clear();
        res.json({ success: true, cleared });
    });

    app.get('/api/stats', (req, res) => {
        res.json(getStatsState());
    });

    app.get('/api/quota', async (req, res) => {
        const summary = await Promise.race([
            quotaService.refresh(),
            new Promise((resolve) => {
                setTimeout(() => resolve(quotaService.getSummary()), 1500);
            })
        ]);
        res.json(summary);
    });

    app.get('/api/timeline', async (req, res) => {
        await screenshotTimeline.init();
        res.json(getTimelineState());
    });

    app.get('/api/timeline/:filename', async (req, res) => {
        const file = await screenshotTimeline.resolveFile(String(req.params.filename || ''));
        if (!file) {
            return res.status(404).json({ error: 'Screenshot not found' });
        }

        res.type(file.entry.mimeType || 'image/jpeg');
        res.sendFile(file.path);
    });

    app.post('/api/timeline/capture', async (req, res) => {
        try {
            const result = await screenshotTimeline.captureNow({
                reason: String(req.body?.reason || 'manual'),
                snapshotHash: lastSnapshotHash || '',
                force: true
            });
            res.json(result);
        } catch (e) { const error = /** @type {Error} */ (e);
            sessionStats.logError('timeline_capture', error.message);
            res.status(error.message.includes('CDP disconnected') ? 503 : 500).json({
                error: error.message,
                ...getTimelineState()
            });
        }
    });

    app.delete('/api/timeline', async (req, res) => {
        const result = await screenshotTimeline.clear();
        res.json(result);
    });

    app.get('/api/assist/history', (req, res) => {
        res.json({ messages: aiSupervisor.getAssistHistory() });
    });

    app.delete('/api/assist/history', (req, res) => {
        aiSupervisor.clearAssistHistory();
        sessionStats.logAction('assist_history_cleared');
        res.json({ success: true, messages: [] });
    });

    app.post('/api/assist/chat', async (req, res) => {
        const message = String(req.body?.message || '').trim();
        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        try {
            const result = await aiSupervisor.chatWithUser(message, getAssistContext());
            sessionStats.logAction('assist_chat_message', {
                source: result.source,
                length: message.length
            });
            res.json(result);
        } catch (e) { const error = /** @type {Error} */ (e);
            sessionStats.logError('assist_chat', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Send message
    app.post('/send', async (req, res) => {
        const message = String(req.body?.message || '');
        const requestId = String(req.body?.requestId || '');

        if (!message.trim()) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!conversationReadService.getActiveConversationId() && cdpConnection) {
            const activeId = await detectActiveConversationId(cdpConnection);
            if (activeId) conversationReadService.setActiveConversationId(activeId);
        }

        let result;
        try {
            result = await conversationWriteService.sendText(message, {
                requestId,
                fallback: async (rpcError) => {
                    if (!cdpConnection) throw rpcError;
                    const fallback = await injectMessage(cdpConnection, message);
                    return {
                        ...fallback,
                        success: fallback.ok !== false,
                        method: fallback.method || 'cdp_fallback',
                        transport: 'cdp',
                        rpcFallbackReason: rpcError.code || 'RPC_UNAVAILABLE',
                        deduplicated: false
                    };
                }
            });
        } catch (e) {
            const error = /** @type {Error & {code?: string, mutationAttempted?: boolean}} */ (e);
            sessionStats.logError('message_send', error.message);
            return res.status(error.mutationAttempted ? 502 : 503).json({
                success: false,
                error: error.message,
                code: error.code || 'SEND_UNAVAILABLE',
                retrySafe: !error.mutationAttempted
            });
        }

        if (result.ok !== false) {
            beginResponseWatch();
            if (result.transport === 'rpc') {
                scheduleDesktopConversationFocus(result.conversationId);
            }
            if (!result.deduplicated) {
                sessionStats.increment('messagesSent');
                sessionStats.logAction('message_sent', {
                    length: message.length,
                    transport: result.transport || result.method || 'unknown'
                });
            }
        }

        res.json({
            success: result.success !== false && result.ok !== false,
            method: result.method || 'attempted',
            transport: result.transport || 'unknown',
            deduplicated: Boolean(result.deduplicated),
            details: result
        });
    });

    // Quick Commands
    app.get('/api/quick-commands', async (req, res) => {
        try {
            const commands = await loadQuickCommands();
            res.json({ commands });
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(500).json({ error: error.message });
        }
    });

    // Workspace file browser
    app.get('/api/fs/ls', async (req, res) => {
        try {
            const data = await listWorkspace(String(req.query.path || '.'));
            res.json(data);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.get('/api/fs/cat', async (req, res) => {
        try {
            const data = await readWorkspaceFile(String(req.query.path || ''));
            res.json(data);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    // Remote terminal
    app.get('/api/terminal/history', (req, res) => {
        res.json(terminalManager.getState());
    });

    app.post('/api/terminal/run', async (req, res) => {
        try {
            const data = await terminalManager.run(String(req.body.command || ''));
            res.json(data);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/terminal/stop', async (req, res) => {
        const result = await terminalManager.stop();
        res.json(result);
    });

    // Git panel
    app.get('/api/git/status', async (req, res) => {
        try {
            const summary = await getGitSummary();
            res.json(summary);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/git/add', async (req, res) => {
        try {
            const result = await gitAdd(Array.isArray(req.body.paths) ? req.body.paths : []);
            res.json(result);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/git/commit', async (req, res) => {
        try {
            const result = await gitCommit(String(req.body.message || ''));
            res.json(result);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/git/push', async (req, res) => {
        try {
            const result = await gitPush();
            res.json(result);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    // Screencast status + controls
    app.get('/api/screencast/status', (req, res) => {
        res.json(getScreencastStatus());
    });

    app.post('/api/screencast/start', async (req, res) => {
        try {
            const status = await startScreencast();
            res.json(status);
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.post('/api/screencast/stop', async (req, res) => {
        await stopScreencast();
        res.json(getScreencastStatus());
    });

    // Image upload bridge
    app.post('/api/upload-image', async (req, res) => {
        try {
            const { data, mimeType, name, prompt = '', inject = true } = req.body || {};
            if (!data) {
                return res.status(400).json({ error: 'Image base64 data is required' });
            }

            const cleanData = String(data).replace(/^data:[^;]+;base64,/, '');
            const saved = await saveUploadedImage({
                name,
                mimeType,
                data: cleanData
            });

            let injection = null;
            if (inject) {
                if (!cdpConnection) {
                    return res.status(503).json({ error: 'CDP not connected', upload: saved });
                }

                injection = await injectImage(cdpConnection, {
                    data: cleanData,
                    mimeType,
                    name: saved.fileName,
                    prompt: String(prompt || '').trim()
                });
            }

            res.json({
                success: true,
                upload: saved,
                injection
            });
            if (inject && injection && injection.ok !== false) {
                beginResponseWatch();
                sessionStats.increment('uploadsInjected');
                sessionStats.logAction('image_uploaded', {
                    name: saved.fileName
                });
            }
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    // Admin endpoints
    app.get('/api/admin/logs', (req, res) => {
        const limit = Number(req.query.limit || 80);
        res.json({ logs: getServerLogs(limit) });
    });

    app.get('/api/admin/metrics', async (req, res) => {
        try {
            const commands = await loadQuickCommands();
            res.json({
                startedAt: serverStartedAt,
                uptime: process.uptime(),
                version: VERSION,
                https: hasSSL,
                workspaceRoot,
                wsClients: getOpenClientCount(),
                cdpConnected: cdpConnection?.ws?.readyState === WebSocket.OPEN,
                cdpContexts: cdpConnection?.contexts.length || 0,
                availableTargets,
                activeTargetId,
                lastSnapshotStats: lastSnapshot?.stats || null,
                terminal: terminalManager.getState(),
                tunnel: {
                    provider: tunnelProvider,
                    ...getTunnelStatus()
                },
                supervisor: aiSupervisor.getStatus(),
                suggestions: getSuggestionState(),
                quota: getQuotaState(),
                timeline: getTimelineState(),
                screencast: getScreencastStatus(),
                quickCommandsCount: commands.length,
                recentLogs: getServerLogs(40)
            });
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(500).json({ error: error.message });
        }
    });

    app.put('/api/admin/quick-commands', async (req, res) => {
        try {
            const commands = await saveQuickCommands(req.body.commands);
            broadcast({ type: 'quick_commands_updated', commands, timestamp: new Date().toISOString() });
            res.json({ commands });
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(400).json({ error: error.message });
        }
    });

    app.get('/api/admin/tunnel', (req, res) => {
        res.json({
            provider: tunnelProvider,
            ...getTunnelStatus()
        });
    });

    app.post('/api/admin/tunnel/start', async (req, res) => {
        const provider = String(req.body.provider || 'cloudflare').toLowerCase();
        if (!getTunnelManager(provider)) {
            return res.status(400).json({ error: `Unsupported tunnel provider: ${provider}` });
        }

        try {
            const url = await startTunnel(provider, Number(SERVER_PORT), { tls: hasSSL, sniServerName: '127.0.0.1' });
            broadcastTunnelStatus();
            res.json({ success: true, url, provider });
        } catch (e) { const error = /** @type {Error} */ (e);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/admin/tunnel/stop', async (req, res) => {
        await stopActiveTunnel();
        broadcastTunnelStatus();
        res.json({ success: true, provider: tunnelProvider, ...getTunnelStatus() });
    });

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (e) { const err = /** @type {Error} */ (e);
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    });

    // WebSocket connection with Auth check
    wss.on('connection', (ws, req) => {
        // Parse cookies from headers
        const rawCookies = req.headers.cookie || '';
        const parsedCookies = {};
        rawCookies.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k && v) {
                try {
                    parsedCookies[k] = decodeURIComponent(v);
                } catch (e) {
                    parsedCookies[k] = v;
                }
            }
        });

        // Verify signed cookie manually
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = false;

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const token = cookieParser.signedCookie(signedToken, COOKIE_SECRET);
            if (token === AUTH_TOKEN) {
                isAuthenticated = true;
            }
        }

        if (!isAuthenticated) {
            console.log('🚫 Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log('📱 Client connected (Authenticated)');

        ws.send(JSON.stringify({
            type: 'terminal_state',
            state: terminalManager.getState()
        }));
        ws.send(JSON.stringify({
            type: 'screen_status',
            status: getScreencastStatus()
        }));
        ws.send(JSON.stringify({
            type: 'tunnel_status',
            status: {
                provider: tunnelProvider,
                ...getTunnelStatus()
            }
        }));
        ws.send(JSON.stringify({
            type: 'suggestion_state',
            ...getSuggestionState()
        }));
        ws.send(JSON.stringify({
            type: 'stats_state',
            stats: getStatsState()
        }));
        ws.send(JSON.stringify({
            type: 'quota_state',
            quota: getQuotaState()
        }));
        ws.send(JSON.stringify({
            type: 'timeline_state',
            timeline: getTimelineState()
        }));
        ws.send(JSON.stringify({
            type: 'cdp_status',
            status: cdpConnection?.ws?.readyState === WebSocket.OPEN ? 'connected' : 'reconnecting'
        }));

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    return { server, wss, app, hasSSL };
}

// Main
async function main() {
    try {
        cdpConnection = await initCDP();
    } catch (e) { const err = /** @type {Error} */ (e);
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=7800 to connect.');
    }

    try {
        const { server, wss, app, hasSSL } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Remote Click
        app.post('/remote-click', async (req, res) => {
            const { selector, index, textContent, liftoffIndex } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await clickElement(cdpConnection, { selector, index, textContent, liftoffIndex });
            res.json(result);
        });

        // Multi-Window: List all available CDP targets
        app.get('/cdp-targets', async (req, res) => {
            res.json({
                targets: availableTargets,
                activeTarget: activeTargetId,
                connected: !!cdpConnection
            });
        });

        // Multi-Window: Switch to a different CDP target
        app.post('/select-target', async (req, res) => {
            const { targetId } = req.body;
            if (!targetId) return res.status(400).json({ error: 'targetId required' });

            const target = availableTargets.find(t => t.id === targetId);
            if (!target) return res.status(404).json({ error: 'Target not found. Refresh targets.' });

            try {
                // Close existing connection
                if (cdpConnection?.ws) {
                    await stopScreencast();
                    cdpConnection.ws.close();
                    cdpConnection = null;
                }

                console.log(`🔀 Switching to target: ${target.title} (port ${target.port})`);
                cdpConnection = await connectCDP(target.wsUrl);
                activeTargetId = targetId;
                lastSnapshot = null;
                lastSnapshotHash = null;
                conversationReadService.clearActiveConversation();
                lastRpcSnapshot = null;
                lastRpcSnapshotHash = null;
                lastRpcSnapshotRevision = null;
                lastRpcSnapshotLoadedAt = 0;
                lastRpcConversation = null;
                console.log(`✅ Connected to: ${target.title}`);
                res.json({ success: true, target: target.title });
            } catch (e) { const err = /** @type {Error} */ (e);
                res.status(500).json({ error: `Failed to connect: ${err.message}` });
            }
        });

        // Remote Scroll - sync phone scroll to desktop
        app.post('/remote-scroll', async (req, res) => {
            const { scrollTop, scrollPercent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
            if (result.success !== false) requestSnapshotRefresh('remote_scroll');
            res.json(result);
        });

        // Get App State
        app.get('/app-state', async (req, res) => {
            if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
            const result = await getAppState(cdpConnection);
            res.json(result);
        });

        // Start New Chat
        app.post('/new-chat', async (req, res) => {
            let result;
            try {
                result = await conversationWriteService.startConversation({
                    fallback: async (rpcError) => {
                        if (!cdpConnection) throw rpcError;
                        const fallback = await startNewChat(cdpConnection);
                        return {
                            ...fallback,
                            success: fallback.success === true,
                            method: fallback.method || 'cdp_fallback',
                            transport: 'cdp',
                            rpcFallbackReason: rpcError.code || 'RPC_UNAVAILABLE',
                            deduplicated: false
                        };
                    }
                });
            } catch (e) {
                const error = /** @type {Error & {code?: string, mutationAttempted?: boolean}} */ (e);
                sessionStats.logError('new_chat', error.message);
                return res.status(error.mutationAttempted ? 502 : 503).json({
                    success: false,
                    error: error.message,
                    code: error.code || 'NEW_CHAT_UNAVAILABLE',
                    retrySafe: !error.mutationAttempted
                });
            }
            if (result.success) {
                sessionStats.reset('new-chat');
                sessionStats.logAction('new_chat_started', {
                    transport: result.transport || result.method || 'unknown'
                });
                aiSupervisor.clearAssistHistory();
                if (result.transport !== 'rpc') {
                    conversationReadService.clearActiveConversation();
                }
                lastRpcSnapshot = null;
                lastRpcSnapshotHash = null;
                lastRpcSnapshotRevision = null;
                lastRpcSnapshotLoadedAt = 0;
                lastRpcConversation = null;
                if (result.transport !== 'rpc') {
                    requestSnapshotRefresh('new_chat');
                } else {
                    scheduleDesktopConversationFocus(result.conversationId);
                }
            }
            res.json(result);
        });

        // Get Chat History
        app.get('/chat-history', async (req, res) => {
            try {
                if (!conversationReadService.getActiveConversationId() && cdpConnection) {
                    const activeId = await detectActiveConversationId(cdpConnection);
                    if (activeId) conversationReadService.setActiveConversationId(activeId);
                }
                const result = await conversationReadService.listConversations();
                return res.json(result);
            } catch (_) {
                if (!cdpConnection) {
                    return res.json({
                        error: 'Conversation service unavailable',
                        projects: [],
                        chats: []
                    });
                }
                const result = await getChatHistory(cdpConnection);
                return res.json(result);
            }
        });

        // Select a Chat (by conversation id when available, title as fallback)
        app.post('/select-chat', async (req, res) => {
            const { title, id } = req.body;
            if (!title && !id) return res.status(400).json({ error: 'Chat title or id required' });
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectChat(cdpConnection, title || '', id || '');
            if (result.success) {
                // Do not let clients render the previous conversation while
                // Antigravity mounts the newly selected transcript.
                lastSnapshot = null;
                lastSnapshotHash = null;
                conversationReadService.setActiveConversationId(id || '');
                lastRpcSnapshot = null;
                lastRpcSnapshotHash = null;
                lastRpcSnapshotRevision = null;
                lastRpcSnapshotLoadedAt = 0;
                lastRpcConversation = null;
                lastCapturedProbeSignature = '';
                requestSnapshotRefresh('conversation_selected');
            }
            res.json(result);
        });

        // Check if Chat is Open
        app.get('/chat-status', async (req, res) => {
            if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
            const result = await hasChatOpen(cdpConnection);
            res.json(result);
        });

        // Launch a new window
        app.post('/api/launch-window', async (req, res) => {
            try {
                const newPort = await launchAntigravity();
                // We don't automatically connect here; the polling loop will see it 
                // and the user can select it via the UI context menu.
                res.json({ success: true, port: newPort });
            } catch (e) { const err = /** @type {Error} */ (e);
                console.error('Failed to launch new window:', err);
                res.status(500).json({ error: err.message });
            }
        });

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        const localUrl = `${protocol}://${localIP}:${SERVER_PORT}`;
        pairingInfo = {
            name: process.env.COMPUTERNAME || 'LiftOff',
            url: localUrl,
            version: VERSION
        };
        server.listen(SERVER_PORT, '0.0.0.0', () => {
            const url = localUrl;
            const ver = VERSION;

            // ANSI 256-color helpers
            const R  = '\x1b[0m';
            const B  = '\x1b[1m';
            const DIM = '\x1b[2m';
            const c1 = '\x1b[38;5;99m';
            const c2 = '\x1b[38;5;135m';
            const c3 = '\x1b[38;5;141m';
            const c4 = '\x1b[38;5;147m';
            const GR = '\x1b[38;5;82m';
            const CY = '\x1b[38;5;81m';
            const WH = '\x1b[38;5;255m';

            const line = `${c1}${B}  ${'─'.repeat(50)}${R}`;

            console.log('');
            console.log(`${c2}${B}   ██████╗ ███╗   ███╗███╗   ██╗██╗${R}`);
            console.log(`${c2}${B}  ██╔═══██╗████╗ ████║████╗  ██║██║${R}`);
            console.log(`${c3}${B}  ██║   ██║██╔████╔██║██╔██╗ ██║██║${R}`);
            console.log(`${c3}${B}  ██║   ██║██║╚██╔╝██║██║╚██╗██║██║${R}`);
            console.log(`${c4}${B}  ╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║${R}`);
            console.log(`${c4}${B}   ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝${R}`);
            console.log('');
            console.log(`  ${WH}${B}LiftOff Antigravity Bridge${R}  ${DIM}v${ver}${R}`);
            console.log(`  ${DIM}Mobile remote control for AI sessions${R}`);
            console.log('');
            console.log(line);
            console.log('');
            console.log(`  ${GR}${B}▸${R} ${WH}${B}Server${R}     ${CY}${url}${R}`);
            console.log(`  ${GR}${B}▸${R} ${WH}${B}Protocol${R}   ${hasSSL ? `${GR}HTTPS 🔒` : 'HTTP'}${R}`);
            console.log(`  ${GR}${B}▸${R} ${WH}${B}CDP${R}        ${DIM}ports 7800-7803${R}`);
            console.log(`  ${GR}${B}▸${R} ${WH}${B}Workspace${R}  ${DIM}${workspaceRoot}${R}`);
            console.log('');
            console.log(line);
            console.log('');
            console.log(`  ${DIM}📱 Open this URL on your phone${R}`);
            console.log(`  ${DIM}🪟 Multi-window switching supported${R}`);
            console.log(`  ${DIM}⏹  Press Ctrl+C to stop${R}`);
            console.log('');

            discoveryResponder?.close();
            discoveryResponder = startDiscoveryResponder(pairingInfo);

            const pairUri = new URL('antigravity-remote://pair');
            pairUri.searchParams.set('url', url);
            pairUri.searchParams.set('password', APP_PASSWORD);
            console.log(`  ${WH}${B}Scan to pair the native app:${R}`);
            qrcode.generate(pairUri.toString(), { small: true }, (code) => console.log(code));

            maybeStartAutoTunnel({ tls: hasSSL, sniServerName: '127.0.0.1' });

            // Initialize Telegram bot with interactive commands
            initTelegramBot().then(active => {
                if (active) {
                    console.log(`  ${GR}${B}▸${R} ${WH}${B}Telegram${R}   ${GR}Bot active ✅${R}`);
                    registerTelegramHooks({
                        onApprove: async () => {
                            const pendingSuggestion = getLatestPendingSuggestion();
                            if (pendingSuggestion) {
                                return approveQueuedSuggestion(pendingSuggestion.id);
                            }
                            return cdpConnection ? completePendingAction(cdpConnection, 'accept') : { error: 'No CDP' };
                        },
                        onReject: async () => {
                            const pendingSuggestion = getLatestPendingSuggestion();
                            if (pendingSuggestion) {
                                return rejectQueuedSuggestion(pendingSuggestion.id);
                            }
                            return cdpConnection ? completePendingAction(cdpConnection, 'reject') : { error: 'No CDP' };
                        },
                        onStatus: () => ({
                            cdpConnected: !!(cdpConnection?.ws?.readyState === WebSocket.OPEN),
                            supervisorEnabled: aiSupervisor.enabled,
                            suggestMode: aiSupervisor.isSuggestModeEnabled(),
                            pendingSuggestions: suggestQueue.getPendingCount(),
                            model: 'via /app-state',
                            mode: 'via /app-state',
                            targetsCount: availableTargets.length,
                            uptime: process.uptime() > 3600
                                ? `${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m`
                                : `${Math.floor(process.uptime()/60)}m`
                        }),
                        onStats: () => getStatsState(),
                        onQuota: () => quotaService.refresh(),
                        onScreenshot: async () => {
                            const result = await captureCurrentScreenshot({
                                format: 'jpeg',
                                quality: 70
                            });
                            if (!result.success) {
                                return { data: null };
                            }
                            sessionStats.increment('screenCaptures');
                            sessionStats.logAction('screenshot_captured');
                            return { data: result.data };
                        },
                        onSuggestionApprove: (id) => approveQueuedSuggestion(id),
                        onSuggestionReject: (id) => rejectQueuedSuggestion(id)
                    });
                }
            }).catch(() => {});
        });

        // Graceful shutdown handlers
        let shutdownStarted = false;
        const gracefulShutdown = async (signal, exitCode = 0) => {
            if (shutdownStarted) return;
            shutdownStarted = true;
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            await stopScreencast();
            screenshotTimeline.stop();
            await Promise.all(Object.values(tunnelManagers).map((manager) => manager.stop()));
            discoveryResponder?.close();
            discoveryResponder = null;
            await stopTelegramBot();
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(exitCode), 1000);
        };

        if (isTrayManaged()) {
            process.stdin.setEncoding('utf8');
            let trayInputBuffer = '';
            process.stdin.on('data', (chunk) => {
                trayInputBuffer += chunk;
                const lines = trayInputBuffer.split(/\r?\n/);
                trayInputBuffer = lines.pop() || '';
                for (const line of lines) {
                    const command = line.trim().toLowerCase();
                    if (command === 'stop') gracefulShutdown('tray stop');
                    if (command === 'restart') gracefulShutdown('tray restart', 75);
                }
            });
            process.stdin.resume();
        }

        process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
        process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

    } catch (e) { const err = /** @type {Error} */ (e);
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
