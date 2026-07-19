import { describe, expect, it, vi } from 'vitest';
import {
  conversationDirectoriesForInstances,
  conversationIdFromFilename,
  scanDiskConversations,
} from '../../src/language-server/conversation-disk-store.js';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

describe('Language Server conversation disk store', () => {
  it('accepts only UUID-named protobuf and database files', () => {
    expect(conversationIdFromFilename(`${FIRST_ID}.pb`)).toBe(FIRST_ID);
    expect(conversationIdFromFilename(`${FIRST_ID}.DB`)).toBe(FIRST_ID);
    expect(conversationIdFromFilename('not-a-conversation.pb')).toBe('');
    expect(conversationIdFromFilename(`${FIRST_ID}.json`)).toBe('');
  });

  it('scans only the trusted app-data store used by a running instance', () => {
    const directories = conversationDirectoriesForInstances(
      [
        { appDataDir: 'antigravity' },
        { appDataDir: 'untrusted-store' },
      ],
      { homeDirectory: 'C:\\Users\\Test' }
    );

    expect(directories).toHaveLength(1);
    expect(directories[0]).toContain('antigravity');
    expect(directories[0]).not.toContain('untrusted-store');
    expect(conversationDirectoriesForInstances([{ pid: 1 }])).toEqual([]);
  });

  it('deduplicates IDs across files and keeps the newest mtime', async () => {
    const readDirectory = vi.fn(async (directory) =>
      directory === 'first'
        ? [`${FIRST_ID}.pb`, `${SECOND_ID}.db`, 'ignore.txt']
        : [`${FIRST_ID}.db`]
    );
    const statFile = vi.fn(async (filename) => ({
      mtime: new Date(
        filename.includes('second')
          ? '2026-07-15T12:00:00.000Z'
          : '2026-07-14T12:00:00.000Z'
      ),
    }));

    const result = await scanDiskConversations({
      directories: ['first', 'second'],
      readDirectory,
      statFile,
    });

    expect(result).toHaveLength(2);
    expect(result.find((entry) => entry.id === FIRST_ID)).toEqual({
      id: FIRST_ID,
      modifiedAt: '2026-07-15T12:00:00.000Z',
    });
  });

  it('ignores missing stores and unreadable file metadata', async () => {
    const result = await scanDiskConversations({
      directories: ['missing', 'readable'],
      readDirectory: vi.fn(async (directory) => {
        if (directory === 'missing') throw new Error('missing');
        return [`${FIRST_ID}.pb`];
      }),
      statFile: vi.fn(async () => {
        throw new Error('locked');
      }),
    });

    expect(result).toEqual([
      { id: FIRST_ID, modifiedAt: new Date(0).toISOString() },
    ]);
  });
});
