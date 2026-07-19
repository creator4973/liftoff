// @ts-check

import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export const KNOWN_ANTIGRAVITY_APP_DATA_DIRS = Object.freeze([
  'antigravity',
  'antigravity-ide',
]);

const CONVERSATION_EXTENSION_SET = new Set(['.pb', '.db']);
const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedAppDataDir(value) {
  return String(value || '').trim().toLowerCase();
}

export function conversationIdFromFilename(filename) {
  const name = String(filename || '');
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  const extension = name.slice(dotIndex).toLowerCase();
  if (!CONVERSATION_EXTENSION_SET.has(extension)) return '';
  const id = name.slice(0, dotIndex);
  return CONVERSATION_ID_PATTERN.test(id) ? id : '';
}

export function conversationDirectoriesForInstances(
  instances,
  { homeDirectory = homedir() } = {}
) {
  const known = new Set(KNOWN_ANTIGRAVITY_APP_DATA_DIRS);
  const activeStores = new Set();
  for (const instance of instances || []) {
    const appDataDir = normalizedAppDataDir(instance?.appDataDir);
    if (known.has(appDataDir)) activeStores.add(appDataDir);
  }
  return [...activeStores].map((store) =>
    join(homeDirectory, '.gemini', store, 'conversations')
  );
}

export async function scanDiskConversations({
  directories,
  readDirectory = readdir,
  statFile = stat,
} = {}) {
  const conversations = new Map();
  for (const directory of directories || []) {
    let files;
    try {
      files = await readDirectory(directory);
    } catch (_) {
      continue;
    }
    for (const filename of files) {
      const id = conversationIdFromFilename(filename);
      if (!id) continue;
      let modifiedAt = new Date(0).toISOString();
      try {
        const fileStat = await statFile(join(directory, filename));
        modifiedAt = fileStat.mtime.toISOString();
      } catch (_) { }
      const existing = conversations.get(id);
      if (!existing || existing.modifiedAt < modifiedAt) {
        conversations.set(id, { id, modifiedAt });
      }
    }
  }
  return [...conversations.values()];
}
