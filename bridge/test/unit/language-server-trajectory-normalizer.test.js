import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  findTrajectoryFileChanges,
  findTrajectoryMedia,
  formatRelativeTime,
  normalizeMediaAttachments,
  normalizeTrajectorySummaries,
  renderTrajectorySnapshot,
  trajectoryStepsToMessages,
} from '../../src/language-server/trajectory-normalizer.js';

describe('Language Server trajectory normalizer', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z');

  it('groups summaries by workspace and preserves the mobile history contract', () => {
    const result = normalizeTrajectorySummaries(
      {
        older: {
          trajectoryId: 'older',
          summary: 'Older task',
          lastModifiedTime: '2026-07-12T12:00:00.000Z',
          workspaces: [{ repository: { computedName: 'Project A' } }],
        },
        latest: {
          trajectoryId: 'nested-trajectory-id',
          summary: 'Latest task',
          lastModifiedTime: '2026-07-14T11:55:00.000Z',
          trajectoryMetadata: {
            workspaces: [
              { workspaceFolderAbsoluteUri: 'file:///C:/work/Project%20B' },
            ],
          },
        },
      },
      { activeConversationId: 'latest', now }
    );

    expect(result.source).toBe('language-server-rpc');
    expect(result.projects).toEqual([
      {
        title: 'Project B',
        conversations: [
          { id: 'latest', title: 'Latest task', time: '5m', active: true },
        ],
      },
      {
        title: 'Project A',
        conversations: [
          { id: 'older', title: 'Older task', time: '2d', active: false },
        ],
      },
    ]);
    expect(result.chats[0]).toEqual({
      id: 'latest',
      title: 'Latest task',
      date: '5m',
      active: true,
    });
  });

  it('normalizes only user inputs and final planner responses', () => {
    const messages = trajectoryStepsToMessages([
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: {
          items: [{ text: 'Please inspect this' }],
          media: [{ mimeType: 'image/png', inlineData: 'aW1hZ2U=' }],
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        viewFile: { absolutePathUri: 'file:///private/path.js' },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: {
          modifiedResponse: 'Final answer',
          response: 'Unmodified answer',
          thinking: 'Private chain of thought',
          items: [{ text: 'Item answer' }],
        },
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: 'Please inspect this',
        attachmentCount: 1,
        media: [
          {
            mimeType: 'image/png',
            inlineData: 'aW1hZ2U=',
            mediaIndex: 0,
          },
        ],
        stepIndex: 0,
      },
      { role: 'assistant', content: 'Final answer', stepIndex: 2 },
    ]);
  });

  it('renders escaped semantic message markup for the existing Flutter styles', () => {
    const snapshot = renderTrajectorySnapshot(
      [
        { role: 'user', content: '<script>alert(1)</script>' },
        { role: 'assistant', content: 'Safe & sound' },
      ],
      { conversationId: 'abc', title: 'A < B', status: 'IDLE' }
    );

    expect(snapshot.html).toContain('data-liftoff-role="user"');
    expect(snapshot.html).toContain('data-liftoff-role="assistant"');
    expect(snapshot.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(snapshot.html).not.toContain('<script>');
    expect(snapshot.source).toBe('language-server-rpc');
  });

  it('renders lazy image references without embedding image bytes', () => {
    const inlineData = Buffer.from('private-image-bytes').toString('base64');
    const media = normalizeMediaAttachments([
      { mimeType: 'image/png', inlineData },
      {
        mimeType: 'image/jpeg',
        payload: { case: 'inlineData', value: 'second-image' },
      },
    ]);
    const messages = [
      {
        role: 'user',
        content: 'Please inspect this image',
        stepIndex: 14,
        media,
      },
    ];
    const snapshot = renderTrajectorySnapshot(messages, {
      conversationId: 'conversation-id',
    });

    expect(media).toHaveLength(2);
    expect(findTrajectoryMedia(messages, 14, 1)?.inlineData).toBe(
      'second-image'
    );
    expect(snapshot.html).toContain(
      '/api/conversations/conversation-id/media/14/0'
    );
    expect(snapshot.html).toContain('data-liftoff-media-name="Image 2"');
    expect(snapshot.html).not.toContain(inlineData);
    expect(snapshot.html).not.toContain('second-image');
  });

  it('restores compacted earlier context and groups file diffs with the final reply', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY',
        conversationHistory: { content: 'Earlier user and assistant context' },
      },
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        codeAction: {
          actionResult: {
            edit: {
              absoluteUri: 'file:///C:/work/src/example.js',
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: { response: 'Implemented the change' },
      },
    ];
    const messages = trajectoryStepsToMessages(steps);

    expect(messages[0]).toMatchObject({
      role: 'context',
      content: 'Earlier user and assistant context',
    });
    expect(findTrajectoryFileChanges(steps, 2)).toEqual([
      expect.objectContaining({
        name: 'example.js',
        path: 'work/src/example.js',
        additions: 1,
        deletions: 1,
      }),
    ]);

    const snapshot = renderTrajectorySnapshot(messages, {
      conversationId: 'conversation-id',
    });
    expect(snapshot.html).toContain('data-liftoff-role="context"');
    expect(snapshot.html).toContain('1 file changed +1 -1');
    expect(snapshot.html).toContain(
      '/api/conversations/conversation-id/changes/2'
    );
    expect(snapshot.html).not.toContain('@@ -1 +1 @@');
  });

  it('normalizes Antigravity unifiedDiff line objects into a file-change card', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        codeAction: {
          actionResult: {
            edit: {
              absoluteUri: 'file:///C:/work/test.md',
              diff: {
                unifiedDiff: {
                  lines: [
                    { type: 'UNIFIED_DIFF_LINE_TYPE_DELETE', text: 'old' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_INSERT', text: 'new' },
                  ],
                },
              },
            },
          },
        },
      },
    ];

    expect(findTrajectoryFileChanges(steps, 0)).toEqual([
      expect.objectContaining({
        name: 'test.md',
        diff: '-old\n+new',
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it('formats timestamps and escapes attribute-sensitive characters', () => {
    expect(formatRelativeTime('2026-07-14T11:00:00.000Z', now)).toBe('1h');
    expect(formatRelativeTime('', now)).toBe('Recent');
    expect(escapeHtml('"<&')).toBe('&quot;&lt;&amp;');
  });
});
