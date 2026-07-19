import { describe, expect, it, vi } from 'vitest';
import {
  buildConversationRevision,
  ConversationReadError,
  LanguageServerConversationReadService,
} from '../../src/language-server/conversation-read-service.js';

describe('Language Server conversation read service', () => {
  const diskId = '33333333-3333-4333-8333-333333333333';

  it('merges summaries across instances and reads steps from the best source', async () => {
    const first = { pid: 1, csrfToken: 'one', ports: [5001] };
    const second = { pid: 2, csrfToken: 'two', ports: [5002] };
    const client = {
      callReadOnly: vi.fn(async (method, body, instance) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              shared: {
                trajectoryId: 'nested-id-that-is-not-the-cascade-id',
                summary: instance === first ? 'Old copy' : 'Current copy',
                stepCount: instance === first ? 2 : 4,
                lastModifiedTime: '2026-07-14T10:00:00.000Z',
              },
            },
          };
        }
        expect(method).toBe('GetCascadeTrajectorySteps');
        expect(body).toEqual({ cascadeId: 'shared', stepOffset: 0 });
        expect(instance).toBe(second);
        return {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              userInput: { items: [{ text: 'Hello' }] },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              plannerResponse: { response: 'Hi there' },
            },
          ],
        };
      }),
    };
    const service = new LanguageServerConversationReadService({
      discover: vi.fn(async () => [first, second]),
      client,
      now: () => Date.parse('2026-07-14T12:00:00.000Z'),
    });
    service.setActiveConversationId('shared');

    const history = await service.listConversations({ force: true });
    const conversation = await service.loadActiveConversation({ force: false });

    expect(history.chats).toEqual([
      {
        id: 'shared',
        title: 'Current copy',
        date: '2h',
        active: true,
      },
    ]);
    expect(conversation.messages.map((message) => message.content)).toEqual([
      'Hello',
      'Hi there',
    ]);
    expect(conversation.snapshot.html).toContain('data-liftoff-role="assistant"');
    expect(conversation.revision).toBe(
      buildConversationRevision('shared', {
        trajectoryId: 'nested-id-that-is-not-the-cascade-id',
        summary: 'Current copy',
        stepCount: 4,
        lastModifiedTime: '2026-07-14T10:00:00.000Z',
      })
    );
  });

  it('returns a stable active revision without loading trajectory steps', async () => {
    const client = {
      callReadOnly: vi.fn(async (method) => {
        expect(method).toBe('GetAllCascadeTrajectories');
        return {
          trajectorySummaries: {
            active: {
              summary: 'Cached task',
              stepCount: 42,
              lastModifiedTime: '2026-07-17T10:00:00.000Z',
              status: 'CASCADE_RUN_STATUS_IDLE',
            },
          },
        };
      }),
    };
    const service = new LanguageServerConversationReadService({
      discover: async () => [{ pid: 91 }],
      client,
    });
    service.setActiveConversationId('active');

    await expect(service.getActiveConversationRevision()).resolves.toBe(
      buildConversationRevision('active', {
        summary: 'Cached task',
        stepCount: 42,
        lastModifiedTime: '2026-07-17T10:00:00.000Z',
        status: 'CASCADE_RUN_STATUS_IDLE',
      })
    );
    expect(client.callReadOnly).toHaveBeenCalledTimes(1);
  });

  it('keeps successful instances when another instance cannot be read', async () => {
    const client = {
      callReadOnly: vi.fn(async (_method, _body, instance) => {
        if (instance.pid === 1) throw new Error('unreachable');
        return { trajectorySummaries: {} };
      }),
    };
    const service = new LanguageServerConversationReadService({
      discover: async () => [{ pid: 1 }, { pid: 2 }],
      client,
    });

    await expect(service.listConversations({ force: true })).resolves.toMatchObject({
      success: true,
      projects: [],
      chats: [],
    });
  });

  it('retries trajectory steps on another instance that listed the same id', async () => {
    const first = { pid: 1 };
    const second = { pid: 2 };
    const client = {
      callReadOnly: vi.fn(async (method, _body, instance) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: {
              shared: {
                trajectoryId: 'shared',
                summary: 'Shared task',
                stepCount: instance === first ? 5 : 4,
              },
            },
          };
        }
        if (instance === first) throw new Error('wrong owner');
        return {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              plannerResponse: { response: 'Readable elsewhere' },
            },
          ],
        };
      }),
    };
    const service = new LanguageServerConversationReadService({
      discover: async () => [first, second],
      client,
    });
    service.setActiveConversationId('shared');

    const result = await service.loadActiveConversation();

    expect(result.messages[0].content).toBe('Readable elsewhere');
    expect(client.callReadOnly).toHaveBeenCalledWith(
      'GetCascadeTrajectorySteps',
      { cascadeId: 'shared', stepOffset: 0 },
      second
    );
  });

  it('returns a stable error when every instance fails', async () => {
    const service = new LanguageServerConversationReadService({
      discover: async () => [{ pid: 1 }],
      client: { callReadOnly: vi.fn(async () => { throw new Error('secret'); }) },
    });

    await expect(service.listConversations({ force: true })).rejects.toEqual(
      expect.objectContaining({
        name: 'ConversationReadError',
        code: 'READ_FAILED',
        message: 'Antigravity conversation data is temporarily unavailable',
      })
    );
  });

  it('requires an explicitly selected conversation before loading steps', async () => {
    const service = new LanguageServerConversationReadService({
      discover: async () => [],
    });

    await expect(service.loadActiveConversation()).rejects.toBeInstanceOf(
      ConversationReadError
    );
    await expect(service.loadActiveConversation()).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_SELECTED',
    });
  });

  it('returns the sole instance that lists a conversation as its mutation target', async () => {
    const owner = { pid: 41 };
    const service = new LanguageServerConversationReadService({
      discover: async () => [owner],
      client: {
        callReadOnly: vi.fn(async () => ({
          trajectorySummaries: {
            owned: { summary: 'Owned conversation', stepCount: 2 },
          },
        })),
      },
    });

    await expect(
      service.getConversationMutationTarget('owned')
    ).resolves.toMatchObject({ instance: owner });
  });

  it('uses the single running source when duplicate summaries exist', async () => {
    const idle = { pid: 51 };
    const running = { pid: 52 };
    const service = new LanguageServerConversationReadService({
      discover: async () => [idle, running],
      client: {
        callReadOnly: vi.fn(async (_method, _body, instance) => ({
          trajectorySummaries: {
            shared: {
              summary: 'Shared conversation',
              status:
                instance === running
                  ? 'CASCADE_TRAJECTORY_STATUS_RUNNING'
                  : 'CASCADE_TRAJECTORY_STATUS_IDLE',
            },
          },
        })),
      },
    });

    await expect(
      service.getConversationMutationTarget('shared')
    ).resolves.toMatchObject({ instance: running });
  });

  it('refuses to guess when multiple mutation owners remain possible', async () => {
    const service = new LanguageServerConversationReadService({
      discover: async () => [{ pid: 61 }, { pid: 62 }],
      client: {
        callReadOnly: vi.fn(async () => ({
          trajectorySummaries: {
            shared: { summary: 'Ambiguous conversation', stepCount: 3 },
          },
        })),
      },
    });

    await expect(
      service.getConversationMutationTarget('shared')
    ).rejects.toMatchObject({ code: 'OWNER_AMBIGUOUS' });
  });

  it('lists disk-only conversations and warms them into structured summaries', async () => {
    const instance = { pid: 71, appDataDir: 'antigravity' };
    let warmed = false;
    let releaseWarmup;
    const warmupGate = new Promise((resolve) => {
      releaseWarmup = resolve;
    });
    const client = {
      callReadOnly: vi.fn(async (method, body) => {
        if (method === 'GetAllCascadeTrajectories') {
          return {
            trajectorySummaries: warmed
              ? {
                  [diskId]: {
                    summary: 'Recovered conversation',
                    stepCount: 8,
                    lastModifiedTime: '2026-07-15T12:00:00.000Z',
                    workspaces: [
                      {
                        workspaceFolderAbsoluteUri:
                          'file:///C:/Work/RecoveredProject',
                      },
                    ],
                  },
                }
              : {},
          };
        }
        expect(body).toEqual({ cascadeId: diskId, stepOffset: 999999 });
        await warmupGate;
        warmed = true;
        return { steps: [] };
      }),
    };
    const service = new LanguageServerConversationReadService({
      discover: async () => [instance],
      client,
      getConversationDirectories: () => ['trusted-store'],
      scanDisk: vi.fn(async () => [
        { id: diskId, modifiedAt: '2026-07-15T12:00:00.000Z' },
      ]),
    });

    const initial = await service.listConversations({ force: true });
    expect(initial.chats).toHaveLength(1);
    expect(initial.chats[0].title).toMatch(/^Loading conversation/);

    const warmup = service.warmupPromise;
    releaseWarmup();
    await warmup;

    const refreshed = await service.listConversations({ force: true });
    expect(refreshed.chats[0].title).toBe('Recovered conversation');
    expect(refreshed.projects[0].title).toBe('RecoveredProject');
    expect(client.callReadOnly).toHaveBeenCalledWith(
      'GetCascadeTrajectorySteps',
      { cascadeId: diskId, stepOffset: 999999 },
      instance
    );
  });

  it('caps merged live and disk history by most recent modification time', async () => {
    const instance = { pid: 81, appDataDir: 'antigravity' };
    const ids = [
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const client = {
      callReadOnly: vi.fn(async (method) =>
        method === 'GetAllCascadeTrajectories'
          ? { trajectorySummaries: {} }
          : { steps: [] }
      ),
    };
    const service = new LanguageServerConversationReadService({
      discover: async () => [instance],
      client,
      maxConversations: 2,
      getConversationDirectories: () => ['trusted-store'],
      scanDisk: async () => ids.map((id, index) => ({
        id,
        modifiedAt: `2026-07-${13 + index}T12:00:00.000Z`,
      })),
    });

    const history = await service.listConversations({ force: true });
    expect(history.chats.map((chat) => chat.id)).toEqual([ids[2], ids[1]]);
    await service.warmupPromise;
  });
});
