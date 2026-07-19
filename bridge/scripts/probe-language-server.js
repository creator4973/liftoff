#!/usr/bin/env node
// @ts-check

import {
  discoverLanguageServerInstances,
  sanitizeLanguageServerInstance,
} from '../src/language-server/discovery.js';
import { ReadOnlyLanguageServerRpcClient } from '../src/language-server/rpc-client.js';
import {
  conversationDirectoriesForInstances,
  scanDiskConversations,
} from '../src/language-server/conversation-disk-store.js';

async function main() {
  const instances = await discoverLanguageServerInstances();
  if (!instances.length) {
    console.error('No readable Antigravity Language Server instance found.');
    process.exitCode = 1;
    return;
  }

  const client = new ReadOnlyLanguageServerRpcClient();
  const results = [];
  const loadedConversationIds = new Set();

  for (const instance of instances) {
    const safe = sanitizeLanguageServerInstance(instance);
    const result = { ...safe, readable: false };
    try {
      const workspaces = await client.callReadOnly(
        'GetWorkspaceInfos',
        {},
        instance
      );
      const conversations = await client.callReadOnly(
        'GetAllCascadeTrajectories',
        {},
        instance
      );
      result.readable = true;
      result.workspaceCount = Array.isArray(workspaces?.workspaceInfos)
        ? workspaces.workspaceInfos.length
        : 0;
      result.conversationCount = Object.keys(
        conversations?.trajectorySummaries || {}
      ).length;
      for (const id of Object.keys(conversations?.trajectorySummaries || {})) {
        loadedConversationIds.add(id);
      }
    } catch (error) {
      result.errorCode = error?.code || 'READ_FAILED';
    }
    results.push(result);
  }

  const diskConversations = await scanDiskConversations({
    directories: conversationDirectoriesForInstances(instances),
  });
  const availableConversationIds = new Set(loadedConversationIds);
  for (const conversation of diskConversations) {
    availableConversationIds.add(conversation.id);
  }

  console.log(JSON.stringify({
    instances: results,
    history: {
      loadedConversationCount: loadedConversationIds.size,
      diskConversationCount: diskConversations.length,
      availableConversationCount: availableConversationIds.size,
    },
  }, null, 2));
  if (!results.some((result) => result.readable)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Language Server probe failed: ${error?.message || error}`);
  process.exitCode = 1;
});
