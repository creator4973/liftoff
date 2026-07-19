// @ts-check
/**
 * Enhanced Telegram Bot — Interactive notifications and remote control.
 *
 * Features inspired by tody-agent/AntigravityMobile:
 * - Interactive commands (/status, /screenshot, /approve, /reject, /help)
 * - Message threading (grouped notifications)
 * - Rate limiting (configurable per-minute cap)
 * - Inline keyboard buttons for approve/reject actions
 * - Notification type toggles (error, warning, progress, complete)
 * - Lazy-loaded dependency (won't crash if node-telegram-bot-api missing)
 *
 * @module telegram
 */

// ─── Configuration ──────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const RATE_LIMIT_PER_MIN = parseInt(process.env.TELEGRAM_RATE_LIMIT || '30', 10);
const THREAD_TTL_MS = 5 * 60 * 1000; // 5 min: group related messages in same thread

// ─── State ──────────────────────────────────────────────────────────

/** @type {any} */
let bot = null;
let botInitialized = false;
let botAvailable = false;

/** Rate limiting sliding window */
/** @type {number[]} */
const rateLimitWindow = [];

/** Message threading: type → { messageId, timestamp } */
const threads = new Map();

/** Notification toggles (all enabled by default) */
const notificationToggles = {
    error: true,
    warning: true,
    progress: true,
    complete: true,
    action_required: true,
    auto_approved: true,
    dialog_error: true,
    info: true
};

/** External hooks (set by server.js) */
/** @type {(() => Promise<any>) | null} */
let onApproveAction = null;
/** @type {(() => Promise<any>) | null} */
let onRejectAction = null;
/** @type {(() => Promise<any>) | null} */
let onStatusRequest = null;
/** @type {(() => Promise<any>) | null} */
let onStatsRequest = null;
/** @type {(() => Promise<any>) | null} */
let onQuotaRequest = null;
/** @type {(() => Promise<any>) | null} */
let onScreenshotRequest = null;
/** @type {((id: string) => Promise<any>) | null} */
let onSuggestionApprove = null;
/** @type {((id: string) => Promise<any>) | null} */
let onSuggestionReject = null;

// ─── Lazy Load ──────────────────────────────────────────────────────

/**
 * Attempt to lazy-load node-telegram-bot-api.
 * Returns false if the package is not installed — no crash.
 */
async function ensureBotLoaded() {
    if (botInitialized) return botAvailable;
    botInitialized = true;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('[Telegram] Bot disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
        return false;
    }

    try {
        const mod = await import('node-telegram-bot-api');
        const TelegramBot = mod.default;
        bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
        botAvailable = true;

        // Register commands menu
        await bot.setMyCommands([
            { command: 'status', description: '📊 Show connection & supervisor status' },
            { command: 'stats', description: '📈 Show live session analytics' },
            { command: 'quota', description: '📊 Show model quota status' },
            { command: 'approve', description: '✅ Approve pending action' },
            { command: 'reject', description: '❌ Reject pending action' },
            { command: 'screenshot', description: '📸 Capture current screen' },
            { command: 'toggles', description: '🔔 Show notification toggles' },
            { command: 'help', description: '❓ Show available commands' }
        ]);

        registerCommandHandlers();
        registerCallbackHandlers();

        console.log('[Telegram] Bot initialized with polling ✅');
        return true;
    } catch (e) {
        console.log(`[Telegram] Bot unavailable: ${(/** @type {Error} */ (e)).message}`);
        console.log('[Telegram] Install with: npm install node-telegram-bot-api');
        return false;
    }
}

// ─── Rate Limiting ──────────────────────────────────────────────────

function isRateLimited() {
    const now = Date.now();
    // Purge entries older than 1 minute
    while (rateLimitWindow.length > 0 && now - rateLimitWindow[0] > 60000) {
        rateLimitWindow.shift();
    }
    if (rateLimitWindow.length >= RATE_LIMIT_PER_MIN) {
        return true;
    }
    rateLimitWindow.push(now);
    return false;
}

// ─── Message Threading ──────────────────────────────────────────────

/**
 * Get the reply_to_message_id for a thread type, if recent enough.
 * @param {string} threadType
 * @returns {number | undefined}
 */
function getThreadId(threadType) {
    const entry = threads.get(threadType);
    if (entry && Date.now() - entry.timestamp < THREAD_TTL_MS) {
        return entry.messageId;
    }
    threads.delete(threadType);
    return undefined;
}

/**
 * Save a message ID as the thread head for a type.
 * @param {string} threadType
 * @param {number} messageId
 */
function setThreadId(threadType, messageId) {
    threads.set(threadType, { messageId, timestamp: Date.now() });
}

// ─── Core Send Functions ────────────────────────────────────────────

/**
 * Send a text message via Telegram (simple webhook fallback if bot unavailable).
 * @param {string} message - HTML-formatted message
 * @param {{threadType?: string, inlineKeyboard?: Array<Array<{text: string, callback_data: string}>>}} [options={}] - Extra options
 * @returns {Promise<boolean>}
 */
export async function sendTelegramNotification(message, options = {}) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return true;

    // Try bot first (interactive mode)
    if (botAvailable && bot) {
        return sendViaBotApi(message, options);
    }

    // Fallback: simple webhook (original behavior)
    return sendViaWebhook(message);
}

/**
 * Send via the full bot API with threading and inline keyboards.
 * @param {string} message
 * @param {{threadType?: string, inlineKeyboard?: Array<Array<{text: string, callback_data: string}>>}} [options={}]
 */
async function sendViaBotApi(message, options = {}) {
    if (isRateLimited()) {
        console.log('[Telegram] Rate limited, skipping message');
        return false;
    }

    try {
        /** @type {Record<string, any>} */
        const sendOptions = {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        };

        // Threading
        if (options.threadType) {
            const replyTo = getThreadId(options.threadType);
            if (replyTo) {
                sendOptions.reply_to_message_id = replyTo;
            }
        }

        // Inline keyboard
        if (options.inlineKeyboard) {
            sendOptions.reply_markup = {
                inline_keyboard: options.inlineKeyboard
            };
        }

        const sent = await bot.sendMessage(TELEGRAM_CHAT_ID, message, sendOptions);

        // Save thread reference
        if (options.threadType && sent?.message_id) {
            setThreadId(options.threadType, sent.message_id);
        }

        return true;
    } catch (e) {
        console.error(`[Telegram] Send failed: ${(/** @type {Error} */ (e)).message}`);
        return false;
    }
}

/**
 * Fallback: send via simple HTTP webhook (no bot API dependency).
 * @param {string} message
 */
async function sendViaWebhook(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });

        if (!response.ok) {
            console.error('[Telegram] Webhook send failed:', response.statusText);
            return false;
        }
        return true;
    } catch (error) {
        console.error('[Telegram] Webhook error:', (/** @type {Error} */ (error)).message);
        return false;
    }
}

// ─── Typed Notification Senders ────────────────────────────────────

/**
 * Send a notification with type-based toggle filtering and threading.
 * @param {string} type - Notification type (error, warning, complete, etc.)
 * @param {string} message - HTML message
 * @param {object} [extra] - Extra options (inlineKeyboard, etc.)
 */
export async function sendTypedNotification(type, message, extra = {}) {
    // Check toggle
    if (type in notificationToggles && !/** @type {Record<string, boolean>} */ (notificationToggles)[type]) {
        return true;
    }

    return sendTelegramNotification(message, {
        threadType: type,
        ...extra
    });
}

/**
 * Send an action-required notification with approve/reject inline buttons.
 * @param {string} message
 */
export async function sendActionRequired(message) {
    return sendTypedNotification('action_required', message, {
        inlineKeyboard: [[
            { text: '✅ Approve', callback_data: 'action_approve' },
            { text: '❌ Reject', callback_data: 'action_reject' }
        ]]
    });
}

/**
 * @param {{id: string, action: 'accept' | 'reject', reason: string, command: string, summary?: string}} suggestion
 */
export async function sendSuggestionRequired(suggestion) {
    const actionLabel = suggestion.action === 'accept' ? 'approve' : 'reject';
    const command = String(suggestion.command || 'Pending action').slice(0, 220);
    const summary = suggestion.summary ? `${suggestion.summary}\n` : '';
    return sendTypedNotification('action_required', [
        '🤖 <b>Supervisor Suggestion</b>',
        summary.trim(),
        `Suggested action: <b>${actionLabel}</b>`,
        `Reason: <code>${suggestion.reason}</code>`,
        '',
        `<code>${command}</code>`
    ].filter(Boolean).join('\n'), {
        inlineKeyboard: [[
            { text: '✅ Approve Suggestion', callback_data: `suggest_approve:${suggestion.id}` },
            { text: '❌ Reject Suggestion', callback_data: `suggest_reject:${suggestion.id}` }
        ]]
    });
}

/**
 * @param {number|string} usagePercent
 * @param {number} [width=10]
 */
function buildQuotaBar(usagePercent, width = 10) {
    const clamped = Math.max(0, Math.min(100, Number(usagePercent) || 0));
    const filled = Math.round((clamped / 100) * width);
    return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/**
 * @param {string|Date|number} resetTime
 */
function formatQuotaReset(resetTime) {
    if (!resetTime) return 'Unknown';
    const parsed = new Date(resetTime);
    if (Number.isNaN(parsed.getTime())) return resetTime;
    return parsed.toLocaleTimeString();
}

/**
 * @param {Record<string, any>} summary
 */
function formatQuotaMessage(summary) {
    if (!summary?.available) {
        return [
            '📊 <b>Model Quota Status</b>',
            '',
            summary?.error || 'Quota data is currently unavailable.',
            summary?.enabled ? '' : 'Background polling is disabled (`QUOTA_ENABLED=false`).'
        ].filter(Boolean).join('\n');
    }

    const lines = ['📊 <b>Model Quota Status</b>', ''];
    const models = Array.isArray(summary.models) ? summary.models : [];

    if (summary.credits?.prompt) {
        lines.push(
            `Prompt Credits: ${summary.credits.prompt.usagePercent}% used (${summary.credits.prompt.used}/${summary.credits.prompt.monthly})`
        );
    }
    if (summary.credits?.flow) {
        lines.push(
            `Flow Credits: ${summary.credits.flow.usagePercent}% used (${summary.credits.flow.used}/${summary.credits.flow.monthly})`
        );
    }
    if (summary.credits?.prompt || summary.credits?.flow) {
        lines.push('');
    }

    for (const model of models) {
        lines.push(`${model.name}`);
        lines.push(
            `${buildQuotaBar(model.usagePercent)} ${model.usagePercent}% used · ${model.remainingPercent}% left`
        );
        lines.push(`Reset: ${formatQuotaReset(model.resetTime)}`);
        lines.push('');
    }

    lines.push(
        `Critical Models: ${summary.criticalModels || 0}/${summary.totalModels || 0}`
    );
    if (summary.lastUpdated) {
        lines.push(
            `Updated: ${new Date(summary.lastUpdated).toLocaleTimeString()}`
        );
    }

    return lines.join('\n').trim();
}

// ─── Command Handlers ──────────────────────────────────────────────

function registerCommandHandlers() {
    if (!bot) return;

    bot.onText(/\/start/, (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        bot.sendMessage(msg.chat.id,
            '🤖 <b>LiftOff Antigravity Bridge</b>\n\n' +
            'Connected! Use the commands below to control your Antigravity session.\n\n' +
            '/status — Connection & supervisor status\n' +
            '/stats — Live session analytics\n' +
            '/quota — Model quota status\n' +
            '/approve — Approve pending action\n' +
            '/reject — Reject pending action\n' +
            '/screenshot — Capture current screen\n' +
            '/toggles — Notification settings\n' +
            '/help — This help message',
            { parse_mode: 'HTML' }
        );
    });

    bot.onText(/\/help/, (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        bot.sendMessage(msg.chat.id,
            '📋 <b>Available Commands:</b>\n\n' +
            '📊 /status — Show connection status\n' +
            '📈 /stats — Show live session analytics\n' +
            '📊 /quota — Show model quota status\n' +
            '✅ /approve — Approve pending action\n' +
            '❌ /reject — Reject pending action\n' +
            '📸 /screenshot — Capture screen\n' +
            '🔔 /toggles — Toggle notification types\n' +
            '❓ /help — Show this help',
            { parse_mode: 'HTML' }
        );
    });

    bot.onText(/\/status/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (onStatusRequest) {
            try {
                const status = await onStatusRequest();
                const cdpStatus = status.cdpConnected ? '🟢 Connected' : '🔴 Disconnected';
                const supervisorStatus = status.supervisorEnabled ? '🟢 Enabled' : '⚪ Disabled';
                bot.sendMessage(msg.chat.id,
                    `📊 <b>Status Report</b>\n\n` +
                    `CDP: ${cdpStatus}\n` +
                    `Supervisor: ${supervisorStatus}\n` +
                    `Suggest Mode: ${status.suggestMode ? '🟡 Enabled' : '⚪ Disabled'}\n` +
                    `Pending Suggestions: ${status.pendingSuggestions || 0}\n` +
                    `Model: ${status.model || 'Unknown'}\n` +
                    `Mode: ${status.mode || 'Unknown'}\n` +
                    `Targets: ${status.targetsCount || 0}\n` +
                    `Uptime: ${status.uptime || 'N/A'}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(msg.chat.id, '❌ Failed to get status');
            }
        } else {
            bot.sendMessage(msg.chat.id, '⚪ Status hook not configured');
        }
    });

    bot.onText(/\/stats/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (!onStatsRequest) {
            bot.sendMessage(msg.chat.id, '⚪ Stats hook not configured');
            return;
        }

        try {
            const stats = await onStatsRequest();
            bot.sendMessage(msg.chat.id,
                `📈 <b>Session Stats</b>\n\n` +
                `Uptime: ${stats.uptime}\n` +
                `Messages: ${stats.metrics?.messagesSent || 0}\n` +
                `Snapshots: ${stats.metrics?.snapshotsProcessed || 0}\n` +
                `Approved: ${stats.metrics?.actionsApproved || 0}\n` +
                `Rejected: ${stats.metrics?.actionsRejected || 0}\n` +
                `Auto-approved: ${stats.metrics?.actionsAutoApproved || 0}\n` +
                `Errors: ${stats.metrics?.errorsDetected || 0} (${stats.errorRate || '0.00%'})\n` +
                `Suggestions Pending: ${stats.pendingSuggestions || 0}\n` +
                `Approval Rate: ${stats.approvalRate || '0%'}`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            bot.sendMessage(msg.chat.id, '❌ Failed to get stats');
        }
    });

    bot.onText(/\/quota/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (!onQuotaRequest) {
            bot.sendMessage(msg.chat.id, '⚪ Quota hook not configured');
            return;
        }

        try {
            const summary = await onQuotaRequest();
            bot.sendMessage(msg.chat.id, formatQuotaMessage(summary), {
                parse_mode: 'HTML'
            });
        } catch (e) {
            bot.sendMessage(msg.chat.id, '❌ Failed to get quota');
        }
    });

    bot.onText(/\/approve/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (onApproveAction) {
            try {
                const result = await onApproveAction();
                const emoji = result.success ? '✅' : '❌';
                bot.sendMessage(msg.chat.id,
                    `${emoji} ${result.success ? 'Action approved' : (result.error || 'Approve failed')}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(msg.chat.id, '❌ Approve failed');
            }
        } else {
            bot.sendMessage(msg.chat.id, '⚪ No pending action');
        }
    });

    bot.onText(/\/reject/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (onRejectAction) {
            try {
                const result = await onRejectAction();
                const emoji = result.success ? '✅' : '❌';
                bot.sendMessage(msg.chat.id,
                    `${emoji} ${result.success ? 'Action rejected' : (result.error || 'Reject failed')}`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {
                bot.sendMessage(msg.chat.id, '❌ Reject failed');
            }
        } else {
            bot.sendMessage(msg.chat.id, '⚪ No pending action');
        }
    });

    bot.onText(/\/screenshot/, async (msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        if (onScreenshotRequest) {
            try {
                const result = await onScreenshotRequest();
                if (result.data) {
                    const buffer = Buffer.from(result.data, 'base64');
                    await bot.sendPhoto(msg.chat.id, buffer, {
                        caption: `📸 Screenshot at ${new Date().toLocaleTimeString()}`
                    });
                } else {
                    bot.sendMessage(msg.chat.id, '❌ Screenshot capture failed');
                }
            } catch (e) {
                bot.sendMessage(msg.chat.id, `❌ Screenshot error: ${(/** @type {Error} */ (e)).message}`);
            }
        } else {
            bot.sendMessage(msg.chat.id, '⚪ Screenshot hook not configured');
        }
    });

    bot.onText(/\/toggles/, (/** @type {any} */ msg) => {
        if (String(msg.chat.id) !== TELEGRAM_CHAT_ID) return;
        const toggleList = Object.entries(notificationToggles)
            .map(([key, val]) => `${val ? '🟢' : '⚪'} ${key}`)
            .join('\n');

        const keyboard = Object.keys(notificationToggles).map(key => [{
            text: `${/** @type {Record<string, boolean>} */ (notificationToggles)[key] ? '🟢' : '⚪'} ${key}`,
            callback_data: `toggle_${key}`
        }]);

        bot.sendMessage(msg.chat.id,
            `🔔 <b>Notification Toggles:</b>\n\n${toggleList}\n\nTap to toggle:`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            }
        );
    });
}

// ─── Callback (Inline Button) Handlers ─────────────────────────────

function registerCallbackHandlers() {
    if (!bot) return;

    bot.on('callback_query', async (/** @type {any} */ query) => {
        if (String(query.message?.chat?.id) !== TELEGRAM_CHAT_ID) return;

        const data = query.data || '';

        // Approve/Reject actions from inline buttons
        if (data === 'action_approve' && onApproveAction) {
            try {
                const result = await onApproveAction();
                await bot.answerCallbackQuery(query.id, {
                    text: result.success ? '✅ Approved' : '❌ Failed',
                    show_alert: !result.success
                });
                if (result.success) {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }
            } catch (e) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true });
            }
            return;
        }

        if (data === 'action_reject' && onRejectAction) {
            try {
                const result = await onRejectAction();
                await bot.answerCallbackQuery(query.id, {
                    text: result.success ? '✅ Rejected' : '❌ Failed',
                    show_alert: !result.success
                });
                if (result.success) {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }
            } catch (e) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true });
            }
            return;
        }

        if (data.startsWith('suggest_approve:') && onSuggestionApprove) {
            const suggestionId = data.split(':')[1] || '';
            try {
                const result = await onSuggestionApprove(suggestionId);
                await bot.answerCallbackQuery(query.id, {
                    text: result.success ? '✅ Suggestion approved' : (result.error || '❌ Failed'),
                    show_alert: !result.success
                });
                if (result.success) {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }
            } catch (e) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true });
            }
            return;
        }

        if (data.startsWith('suggest_reject:') && onSuggestionReject) {
            const suggestionId = data.split(':')[1] || '';
            try {
                const result = await onSuggestionReject(suggestionId);
                await bot.answerCallbackQuery(query.id, {
                    text: result.success ? '✅ Suggestion rejected' : (result.error || '❌ Failed'),
                    show_alert: !result.success
                });
                if (result.success) {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }
            } catch (e) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true });
            }
            return;
        }

        // Toggle notifications
        if (data.startsWith('toggle_')) {
            const key = data.replace('toggle_', '');
            if (key in notificationToggles) {
                const toggles = /** @type {Record<string, boolean>} */ (notificationToggles);
                toggles[key] = !toggles[key];
                await bot.answerCallbackQuery(query.id, {
                    text: `${key}: ${toggles[key] ? 'ON 🟢' : 'OFF ⚪'}`
                });

                // Update the keyboard
                const keyboard = Object.keys(notificationToggles).map(k => [{
                    text: `${toggles[k] ? '🟢' : '⚪'} ${k}`,
                    callback_data: `toggle_${k}`
                }]);
                try {
                    await bot.editMessageReplyMarkup(
                        { inline_keyboard: keyboard },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                } catch (e) { /* edit may fail if keyboard unchanged */ }
            }
            return;
        }

        await bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
    });
}

// ─── External Hook Registration ────────────────────────────────────

/**
 * Register server-side action hooks for Telegram commands.
 * @param {object} hooks
 * @param {() => Promise<any>} [hooks.onApprove] - Called when /approve or inline approve pressed
 * @param {() => Promise<any>} [hooks.onReject] - Called when /reject or inline reject pressed
 * @param {() => Promise<any>} [hooks.onStatus] - Called when /status pressed
 * @param {() => Promise<any>} [hooks.onStats] - Called when /stats pressed
 * @param {() => Promise<any>} [hooks.onQuota] - Called when /quota pressed
 * @param {() => Promise<any>} [hooks.onScreenshot] - Called when /screenshot pressed
 * @param {(id: string) => Promise<any>} [hooks.onSuggestionApprove] - Called when a suggestion approve inline button is pressed
 * @param {(id: string) => Promise<any>} [hooks.onSuggestionReject] - Called when a suggestion reject inline button is pressed
 */
export function registerTelegramHooks(hooks = {}) {
    if (hooks.onApprove) onApproveAction = hooks.onApprove;
    if (hooks.onReject) onRejectAction = hooks.onReject;
    if (hooks.onStatus) onStatusRequest = hooks.onStatus;
    if (hooks.onStats) onStatsRequest = hooks.onStats;
    if (hooks.onQuota) onQuotaRequest = hooks.onQuota;
    if (hooks.onScreenshot) onScreenshotRequest = hooks.onScreenshot;
    if (hooks.onSuggestionApprove) onSuggestionApprove = hooks.onSuggestionApprove;
    if (hooks.onSuggestionReject) onSuggestionReject = hooks.onSuggestionReject;
}

/**
 * Initialize the Telegram bot (call at server startup).
 * Non-blocking — will log a message if dependencies are missing.
 */
export async function initTelegramBot() {
    return ensureBotLoaded();
}

/**
 * Check if the bot is actively connected.
 */
export function isBotActive() {
    return botAvailable && bot !== null;
}

/**
 * Get notification toggle states.
 */
export function getNotificationToggles() {
    return { ...notificationToggles };
}

/**
 * Gracefully stop the bot polling.
 */
export async function stopBot() {
    if (bot && botAvailable) {
        try {
            await bot.stopPolling();
            console.log('[Telegram] Bot stopped');
        } catch (e) {
            console.error('[Telegram] Stop error:', (/** @type {Error} */ (e)).message);
        }
    }
}
