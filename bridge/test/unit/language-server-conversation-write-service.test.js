import { describe, expect, it, vi } from 'vitest';
import {
  ConversationWriteError,
  deriveCascadeConfigFromSteps,
  LanguageServerConversationWriteService,
} from '../../src/language-server/conversation-write-service.js';

function createReadService(instance = { pid: 71 }) {
  let activeConversationId = 'cascade-1';
  const summary = {
    stepCount: 612,
    lastUserInputStepIndex: 611,
  };
  return {
    client: {
      callReadOnly: vi.fn(async () => ({
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: {
              lastUserConfig: {
                plannerConfig: {
                  conversational: {},
                  requestedModel: { model: 'MODEL_PLACEHOLDER_M16' },
                },
              },
            },
          },
        ],
      })),
    },
    getActiveConversationId: vi.fn(() => activeConversationId),
    getInstances: vi.fn(async () => [instance]),
    getConversationMutationTarget: vi.fn(async () => ({ instance, summary })),
    setActiveConversationId: vi.fn((conversationId) => {
      activeConversationId = conversationId;
    }),
    invalidateSummaries: vi.fn(),
  };
}

describe('Language Server conversation write service', () => {
  it('derives only the model and planner type needed for a safe send', () => {
    expect(
      deriveCascadeConfigFromSteps([
        {
          userInput: {
            lastUserConfig: {
              plannerConfig: {
                planning: { plannerMode: 'hidden-detail' },
                toolConfig: { permissionConfig: { private: true } },
                requestedModel: { model: ' MODEL_PLACEHOLDER_M35 ' },
              },
            },
          },
        },
      ])
    ).toEqual({
      plannerConfig: {
        plannerTypeConfig: { planning: {} },
        requestedModel: { model: 'MODEL_PLACEHOLDER_M35' },
      },
    });
  });

  it('sends the exact text contract to the confirmed conversation owner', async () => {
    const instance = { pid: 71, httpsPort: 58001, csrfToken: 'token' };
    const readService = createReadService(instance);
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 58001,
      })),
      callMutation: vi.fn(async () => ({})),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
      metadata: { ideVersion: '9.9.9', extensionVersion: '9.9.9' },
    });

    const result = await service.sendText('Hello from phone');

    expect(client.callMutation).toHaveBeenCalledTimes(1);
    expect(client.callMutation).toHaveBeenCalledWith(
      'SendUserCascadeMessage',
      {
        metadata: {
          ideName: 'LiftOff',
          ideVersion: '9.9.9',
          extensionVersion: '9.9.9',
        },
        cascadeId: 'cascade-1',
        items: [{ type: 'text', text: 'Hello from phone' }],
        cascadeConfig: {
          plannerConfig: {
            plannerTypeConfig: { conversational: {} },
            requestedModel: { model: 'MODEL_PLACEHOLDER_M16' },
          },
        },
      },
      instance,
      { protocol: 'https', port: 58001 }
    );
    expect(readService.invalidateSummaries).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      method: 'language_server_rpc',
      transport: 'rpc',
      deduplicated: false,
    });
    expect(readService.client.callReadOnly).toHaveBeenCalledWith(
      'GetCascadeTrajectorySteps',
      { cascadeId: 'cascade-1', stepOffset: 547 },
      instance
    );
  });

  it('coalesces concurrent duplicate sends into one mutation', async () => {
    const readService = createReadService();
    let releaseMutation;
    const mutationGate = new Promise((resolve) => {
      releaseMutation = resolve;
    });
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 59001,
      })),
      callMutation: vi.fn(async () => mutationGate),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    const first = service.sendText('Only once');
    const second = service.sendText('Only once');
    releaseMutation({});

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(client.callMutation).toHaveBeenCalledTimes(1);
    expect(firstResult.deduplicated).toBe(false);
    expect(secondResult.deduplicated).toBe(true);
  });

  it('deduplicates an immediate completed retry but permits it after the window', async () => {
    let currentTime = 1000;
    const readService = createReadService();
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 60001,
      })),
      callMutation: vi.fn(async () => ({})),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
      dedupeWindowMs: 1500,
      now: () => currentTime,
    });

    await service.sendText('Retry guard');
    const duplicate = await service.sendText('Retry guard');
    currentTime += 1501;
    const later = await service.sendText('Retry guard');

    expect(duplicate.deduplicated).toBe(true);
    expect(later.deduplicated).toBe(false);
    expect(client.callMutation).toHaveBeenCalledTimes(2);
  });

  it('marks preflight failures as safe for a CDP fallback', async () => {
    const readService = createReadService();
    const client = {
      preflightConversation: vi.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      }),
      callMutation: vi.fn(),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    await expect(service.sendText('Fallback safely')).rejects.toEqual(
      expect.objectContaining({
        name: 'ConversationWriteError',
        code: 'ECONNREFUSED',
        mutationAttempted: false,
      })
    );
    expect(client.callMutation).not.toHaveBeenCalled();
  });

  it('falls back before mutation when no valid model can be inherited', async () => {
    const readService = createReadService();
    readService.client.callReadOnly.mockResolvedValue({ steps: [] });
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 60002,
      })),
      callMutation: vi.fn(),
    };
    const fallback = vi.fn(async () => ({
      success: true,
      method: 'cdp_fallback',
      transport: 'cdp',
      deduplicated: false,
    }));
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    const result = await service.sendText('Use safe fallback', { fallback });

    expect(result.method).toBe('cdp_fallback');
    expect(fallback).toHaveBeenCalledOnce();
    expect(client.callMutation).not.toHaveBeenCalled();
  });

  it('coalesces concurrent duplicates through one fallback invocation', async () => {
    const readService = createReadService();
    const client = {
      preflightConversation: vi.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
      }),
      callMutation: vi.fn(),
    };
    const fallback = vi.fn(async () => ({
      success: true,
      method: 'cdp_fallback',
      transport: 'cdp',
      deduplicated: false,
    }));
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    const [first, second] = await Promise.all([
      service.sendText('Fallback once', { fallback }),
      service.sendText('Fallback once', { fallback }),
    ]);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it('marks an ambiguous mutation failure as unsafe to retry or fall back', async () => {
    const readService = createReadService();
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 61001,
      })),
      callMutation: vi.fn(async () => {
        throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
      }),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    await expect(service.sendText('Do not resend')).rejects.toEqual(
      expect.objectContaining({
        name: 'ConversationWriteError',
        code: 'ECONNRESET',
        mutationAttempted: true,
      })
    );
    expect(client.callMutation).toHaveBeenCalledTimes(1);
  });

  it('rejects empty text before discovery or mutation', async () => {
    const readService = createReadService();
    const service = new LanguageServerConversationWriteService({
      readService,
      client: {},
    });

    await expect(service.sendText('   ')).rejects.toBeInstanceOf(
      ConversationWriteError
    );
    expect(readService.getConversationMutationTarget).not.toHaveBeenCalled();
  });

  it('cancels the confirmed conversation owner through RPC', async () => {
    const instance = { pid: 81, httpsPort: 62001, csrfToken: 'token' };
    const readService = createReadService(instance);
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 62001,
      })),
      callMutation: vi.fn(async () => ({})),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    const result = await service.cancel();

    expect(client.callMutation).toHaveBeenCalledOnce();
    expect(client.callMutation).toHaveBeenCalledWith(
      'CancelCascadeInvocation',
      { cascadeId: 'cascade-1' },
      instance,
      { protocol: 'https', port: 62001 }
    );
    expect(result).toMatchObject({
      success: true,
      transport: 'rpc',
      conversationId: 'cascade-1',
    });
  });

  it('does not fall back after an ambiguous cancellation mutation failure', async () => {
    const readService = createReadService();
    const fallback = vi.fn();
    const client = {
      preflightConversation: vi.fn(async () => ({
        protocol: 'https',
        port: 62002,
      })),
      callMutation: vi.fn(async () => {
        throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
      }),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    await expect(service.cancel({ fallback })).rejects.toMatchObject({
      code: 'ECONNRESET',
      mutationAttempted: true,
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(client.callMutation).toHaveBeenCalledOnce();
  });

  it('starts and selects a conversation on the active owner through RPC', async () => {
    let now = 0;
    const instance = { pid: 82, httpsPort: 63001, csrfToken: 'token' };
    const readService = createReadService(instance);
    const client = {
      preflightInstance: vi.fn(async () => ({
        protocol: 'https',
        port: 63001,
      })),
      preflightConversation: vi.fn(),
      callMutation: vi.fn(async (method) =>
        method === 'StartCascade' ? { cascadeId: 'cascade-new' } : {}
      ),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
      metadata: { ideVersion: '9.9.9' },
      provisionalOwnerWindowMs: 100,
      now: () => now,
    });

    const result = await service.startConversation();

    expect(client.callMutation).toHaveBeenCalledWith(
      'StartCascade',
      {
        metadata: { ideName: 'LiftOff', ideVersion: '9.9.9' },
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      },
      instance,
      { protocol: 'https', port: 63001 }
    );
    expect(readService.setActiveConversationId).toHaveBeenCalledWith(
      'cascade-new'
    );
    expect(result).toMatchObject({
      success: true,
      transport: 'rpc',
      cascadeId: 'cascade-new',
    });

    now = 1000;
    const fallback = vi.fn();
    const sendResult = await service.sendText('test', { fallback });

    expect(client.preflightConversation).not.toHaveBeenCalled();
    expect(client.callMutation).toHaveBeenNthCalledWith(
      2,
      'SendUserCascadeMessage',
      {
        metadata: { ideName: 'LiftOff', ideVersion: '9.9.9' },
        cascadeId: 'cascade-new',
        items: [{ type: 'text', text: 'test' }],
        cascadeConfig: {
          plannerConfig: {
            plannerTypeConfig: { conversational: {} },
            requestedModel: { model: 'MODEL_PLACEHOLDER_M16' },
          },
        },
      },
      instance,
      { protocol: 'https', port: 63001 }
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(sendResult).toMatchObject({
      success: true,
      transport: 'rpc',
      conversationId: 'cascade-new',
    });
  });

  it('never falls back into the desktop chat when provisional-owner preflight fails', async () => {
    const instance = { pid: 83, httpsPort: 63002, csrfToken: 'token' };
    const readService = createReadService(instance);
    const fallback = vi.fn();
    const client = {
      preflightInstance: vi
        .fn()
        .mockResolvedValueOnce({ protocol: 'https', port: 63002 })
        .mockRejectedValueOnce(
          Object.assign(new Error('owner disappeared'), { code: 'ECONNREFUSED' })
        ),
      callMutation: vi.fn(async () => ({ cascadeId: 'cascade-new' })),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    await service.startConversation();
    await expect(service.sendText('test', { fallback })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
      mutationAttempted: true,
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(client.callMutation).toHaveBeenCalledOnce();
  });

  it('falls back before creating when no single owner can be selected', async () => {
    const readService = createReadService();
    readService.getActiveConversationId.mockReturnValue('');
    readService.getInstances.mockResolvedValue([{ pid: 1 }, { pid: 2 }]);
    const fallback = vi.fn(async () => ({
      success: true,
      transport: 'cdp',
      method: 'cdp_fallback',
    }));
    const client = {
      preflightInstance: vi.fn(),
      callMutation: vi.fn(),
    };
    const service = new LanguageServerConversationWriteService({
      readService,
      client,
    });

    const result = await service.startConversation({ fallback });

    expect(result.transport).toBe('cdp');
    expect(fallback).toHaveBeenCalledOnce();
    expect(client.callMutation).not.toHaveBeenCalled();
  });
});
