import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_RATE_LIMIT',
];

const ENV_SNAPSHOT = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let botInstances = [];

class FakeTelegramBot {
  constructor(token, options) {
    this.token = token;
    this.options = options;
    this.commands = [];
    this.textHandlers = [];
    this.eventHandlers = new Map();
    this.sentMessages = [];
    this.sentPhotos = [];
    this.callbackAnswers = [];
    this.replyMarkupEdits = [];
    this.stopped = false;
    botInstances.push(this);
  }

  async setMyCommands(commands) {
    this.commands = commands;
  }

  onText(regex, handler) {
    this.textHandlers.push({ regex, handler });
  }

  on(event, handler) {
    this.eventHandlers.set(event, handler);
  }

  async sendMessage(chatId, text, options = {}) {
    const message = {
      chatId,
      text,
      options,
      message_id: this.sentMessages.length + 1,
    };
    this.sentMessages.push(message);
    return message;
  }

  async sendPhoto(chatId, buffer, options = {}) {
    this.sentPhotos.push({ chatId, buffer, options });
    return { chatId, buffer, options };
  }

  async answerCallbackQuery(id, payload) {
    this.callbackAnswers.push({ id, payload });
  }

  async editMessageReplyMarkup(markup, target) {
    this.replyMarkupEdits.push({ markup, target });
  }

  async stopPolling() {
    this.stopped = true;
  }

  async emitText(text, overrides = {}) {
    const entry = this.textHandlers.find(({ regex }) => regex.test(text));
    if (!entry) {
      throw new Error(`No text handler registered for ${text}`);
    }

    return entry.handler({
      text,
      chat: { id: 'chat-1' },
      ...overrides,
    });
  }

  async emitCallback(data, overrides = {}) {
    const handler = this.eventHandlers.get('callback_query');
    if (!handler) {
      throw new Error('No callback_query handler registered');
    }

    return handler({
      id: 'callback-1',
      data,
      message: {
        chat: { id: 'chat-1' },
        message_id: 99,
      },
      ...overrides,
    });
  }
}

vi.mock('node-telegram-bot-api', () => ({
  default: FakeTelegramBot,
}));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const original = ENV_SNAPSHOT.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

async function loadTelegram(overrides = {}) {
  restoreEnv();
  for (const key of ENV_KEYS) {
    if (!(key in overrides)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, overrides);
  await vi.resetModules();
  return import('../../src/utils/telegram.js');
}

beforeEach(() => {
  botInstances = [];
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('telegram utils', () => {
  it('reports the bot as inactive when no credentials are configured', async () => {
    const telegram = await loadTelegram();
    expect(telegram.isBotActive()).toBe(false);
  });

  it('returns true for plain notifications when the bot is not configured', async () => {
    const telegram = await loadTelegram();
    await expect(telegram.sendTelegramNotification('test message')).resolves.toBe(
      true
    );
  });

  it('uses the webhook fallback when credentials exist but the bot was not initialized', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });

    await expect(telegram.sendTelegramNotification('webhook path')).resolves.toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/bottoken-1/sendMessage');
  });

  it('initializes the bot, registers commands, and tracks active state', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });

    await expect(telegram.initTelegramBot()).resolves.toBe(true);
    expect(telegram.isBotActive()).toBe(true);
    expect(botInstances).toHaveLength(1);
    expect(botInstances[0].commands).toHaveLength(8);
  });

  it('uses bot threading for repeated typed notifications', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    await telegram.sendTypedNotification('error', 'first error');
    await telegram.sendTypedNotification('error', 'second error');

    expect(botInstances[0].sentMessages).toHaveLength(2);
    expect(botInstances[0].sentMessages[0].options.reply_to_message_id).toBe(
      undefined
    );
    expect(botInstances[0].sentMessages[1].options.reply_to_message_id).toBe(1);
  });

  it('enforces the configured bot rate limit', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
      TELEGRAM_RATE_LIMIT: '1',
    });
    await telegram.initTelegramBot();

    await expect(
      telegram.sendTelegramNotification('first allowed message')
    ).resolves.toBe(true);
    await expect(
      telegram.sendTelegramNotification('second blocked message')
    ).resolves.toBe(false);
  });

  it('sends action-required and suggestion notifications via the bot', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    await telegram.sendActionRequired('Needs approval');
    await telegram.sendSuggestionRequired({
      id: 'suggestion-1',
      action: 'accept',
      reason: 'heuristic-safe-command',
      command: 'Run Command npm test',
      summary: 'Safe read-only command',
    });

    expect(botInstances[0].sentMessages).toHaveLength(2);
    expect(
      botInstances[0].sentMessages[0].options.reply_markup.inline_keyboard[0][0]
        .callback_data
    ).toBe('action_approve');
    expect(
      botInstances[0].sentMessages[1].options.reply_markup.inline_keyboard[0][0]
        .callback_data
    ).toBe('suggest_approve:suggestion-1');
  });

  it('formats /status, /stats, and /quota responses from registered hooks', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    telegram.registerTelegramHooks({
      onStatus: async () => ({
        cdpConnected: true,
        supervisorEnabled: true,
        suggestMode: true,
        pendingSuggestions: 2,
        model: 'GPT-OSS 120B',
        mode: 'Planning',
        targetsCount: 3,
        uptime: '12m',
      }),
      onStats: async () => ({
        uptime: '12m',
        metrics: {
          messagesSent: 4,
          snapshotsProcessed: 12,
          actionsApproved: 3,
          actionsRejected: 1,
          actionsAutoApproved: 2,
          errorsDetected: 1,
        },
        errorRate: '8.33%',
        approvalRate: '75%',
        pendingSuggestions: 2,
      }),
      onQuota: async () => ({
        available: true,
        criticalModels: 1,
        totalModels: 2,
        lastUpdated: '2026-03-29T12:27:56Z',
        credits: {
          prompt: { usagePercent: 99, used: 49500, monthly: 50000 },
          flow: { usagePercent: 100, used: 149900, monthly: 150000 },
        },
        models: [
          {
            name: 'Claude Sonnet 4.6 (Thinking)',
            usagePercent: 80,
            remainingPercent: 20,
            resetTime: '2026-03-29T12:27:56Z',
          },
        ],
      }),
    });

    const bot = botInstances[0];
    await bot.emitText('/status');
    await bot.emitText('/stats');
    await bot.emitText('/quota');

    expect(bot.sentMessages[0].text).toContain('Suggest Mode: 🟡 Enabled');
    expect(bot.sentMessages[0].text).toContain('Pending Suggestions: 2');
    expect(bot.sentMessages[1].text).toContain('Messages: 4');
    expect(bot.sentMessages[1].text).toContain('Approval Rate: 75%');
    expect(bot.sentMessages[2].text).toContain('Claude Sonnet 4.6 (Thinking)');
    expect(bot.sentMessages[2].text).toContain('Critical Models: 1/2');
  });

  it('runs approve, reject, and screenshot hooks through command handlers', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    telegram.registerTelegramHooks({
      onApprove: async () => ({ success: true }),
      onReject: async () => ({ success: false, error: 'Rejected by policy' }),
      onScreenshot: async () => ({
        data: Buffer.from('image-bytes').toString('base64'),
      }),
    });

    const bot = botInstances[0];
    await bot.emitText('/approve');
    await bot.emitText('/reject');
    await bot.emitText('/screenshot');

    expect(bot.sentMessages[0].text).toContain('Action approved');
    expect(bot.sentMessages[1].text).toContain('Rejected by policy');
    expect(bot.sentPhotos).toHaveLength(1);
  });

  it('toggles notification settings via callback queries', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    const bot = botInstances[0];
    await bot.emitText('/toggles');
    await bot.emitCallback('toggle_error');

    expect(telegram.getNotificationToggles().error).toBe(false);
    expect(bot.callbackAnswers.at(-1).payload.text).toContain('error: OFF');
    expect(bot.replyMarkupEdits.at(-1).markup.inline_keyboard).toBeTruthy();

    const beforeCount = bot.sentMessages.length;
    await expect(
      telegram.sendTypedNotification('error', 'this should be suppressed')
    ).resolves.toBe(true);
    expect(bot.sentMessages).toHaveLength(beforeCount);
  });

  it('routes inline approve and suggestion callbacks through registered hooks', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    const onApprove = vi.fn().mockResolvedValue({ success: true });
    const onReject = vi.fn().mockResolvedValue({ success: true });
    const onSuggestionApprove = vi.fn().mockResolvedValue({ success: true });
    const onSuggestionReject = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'No longer valid' });

    telegram.registerTelegramHooks({
      onApprove,
      onReject,
      onSuggestionApprove,
      onSuggestionReject,
    });

    const bot = botInstances[0];
    await bot.emitCallback('action_approve');
    await bot.emitCallback('action_reject');
    await bot.emitCallback('suggest_approve:s-1');
    await bot.emitCallback('suggest_reject:s-2');

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onSuggestionApprove).toHaveBeenCalledWith('s-1');
    expect(onSuggestionReject).toHaveBeenCalledWith('s-2');
    expect(bot.callbackAnswers.at(-1).payload.text).toContain('No longer valid');
  });

  it('stops polling cleanly when requested', async () => {
    const telegram = await loadTelegram({
      TELEGRAM_BOT_TOKEN: 'token-1',
      TELEGRAM_CHAT_ID: 'chat-1',
    });
    await telegram.initTelegramBot();

    await telegram.stopBot();
    expect(botInstances[0].stopped).toBe(true);
  });
});
