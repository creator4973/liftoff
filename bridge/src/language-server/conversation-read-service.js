// @ts-check

import { discoverLanguageServerInstances } from './discovery.js';
import {
  conversationDirectoriesForInstances,
  scanDiskConversations,
} from './conversation-disk-store.js';
import { ReadOnlyLanguageServerRpcClient } from './rpc-client.js';
import {
  findTrajectoryFileChanges,
  normalizeTrajectorySummaries,
  renderTrajectorySnapshot,
  trajectoryStepsToMessages,
} from './trajectory-normalizer.js';

const DEFAULT_MAX_CONVERSATIONS = 100;
const DEFAULT_WARMUP_CONCURRENCY = 8;
const DEFAULT_WARMUP_TTL_MS = 5 * 60 * 1000;
const DISK_WARMUP_STEP_OFFSET = 999999;
const TRANSCRIPT_RENDERER_VERSION = 4;

export class ConversationReadError extends Error {
  constructor(message, code = 'READ_FAILED') {
    super(message);
    this.name = 'ConversationReadError';
    this.code = code;
  }
}

function modifiedTimestamp(summary) {
  const value = Date.parse(String(summary?.lastModifiedTime || ''));
  return Number.isFinite(value) ? value : 0;
}

function preferSummary(left, right) {
  const leftSteps = Number(left?.summary?.stepCount || 0);
  const rightSteps = Number(right?.summary?.stepCount || 0);
  if (rightSteps !== leftSteps) return rightSteps > leftSteps ? right : left;
  return modifiedTimestamp(right?.summary) > modifiedTimestamp(left?.summary)
    ? right
    : left;
}

function instanceIdentity(instance) {
  const pid = Number(instance?.pid || 0);
  if (pid) return `pid:${pid}`;
  return JSON.stringify({
    workspaceId: String(instance?.workspaceId || ''),
    ports: Array.isArray(instance?.ports) ? instance.ports : [],
  });
}

function isRunningSummary(summary) {
  return String(summary?.status || '').toUpperCase().includes('RUNNING');
}

export function buildConversationRevision(conversationId, summary) {
  return JSON.stringify({
    rendererVersion: TRANSCRIPT_RENDERER_VERSION,
    conversationId: String(conversationId || ''),
    stepCount: Number(summary?.stepCount || 0),
    lastModifiedTime: String(summary?.lastModifiedTime || ''),
    status: String(summary?.status || ''),
    title: String(summary?.summary || ''),
  });
}

export class LanguageServerConversationReadService {
  constructor({
    discover = discoverLanguageServerInstances,
    client = new ReadOnlyLanguageServerRpcClient(),
    scanDisk = scanDiskConversations,
    getConversationDirectories = conversationDirectoriesForInstances,
    instanceCacheMs = 5000,
    summaryCacheMs = 1000,
    maxConversations = DEFAULT_MAX_CONVERSATIONS,
    warmupConcurrency = DEFAULT_WARMUP_CONCURRENCY,
    warmupTtlMs = DEFAULT_WARMUP_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.discover = discover;
    this.client = client;
    this.scanDisk = scanDisk;
    this.getConversationDirectories = getConversationDirectories;
    this.instanceCacheMs = instanceCacheMs;
    this.summaryCacheMs = summaryCacheMs;
    this.maxConversations = Math.max(1, Number(maxConversations) || 1);
    this.warmupConcurrency = Math.max(1, Number(warmupConcurrency) || 1);
    this.warmupTtlMs = Math.max(0, Number(warmupTtlMs) || 0);
    this.now = now;
    this.activeConversationId = '';
    this.instances = [];
    this.instancesLoadedAt = 0;
    this.summaryIndex = new Map();
    this.summariesLoadedAt = 0;
    this.warmedAt = new Map();
    this.warmupPromise = null;
  }

  setActiveConversationId(id) {
    this.activeConversationId = typeof id === 'string' ? id.trim() : '';
  }

  getActiveConversationId() {
    return this.activeConversationId;
  }

  clearActiveConversation() {
    this.activeConversationId = '';
  }

  invalidateSummaries() {
    this.summariesLoadedAt = 0;
  }

  async getInstances({ force = false } = {}) {
    if (
      !force &&
      this.instances.length &&
      this.now() - this.instancesLoadedAt < this.instanceCacheMs
    ) {
      return this.instances;
    }
    this.instances = await this.discover();
    this.instancesLoadedAt = this.now();
    return this.instances;
  }

  async refreshSummaries({ force = false } = {}) {
    if (
      !force &&
      this.summaryIndex.size &&
      this.now() - this.summariesLoadedAt < this.summaryCacheMs
    ) {
      return this.summaryIndex;
    }
    const instances = await this.getInstances({ force });
    if (!instances.length) {
      throw new ConversationReadError(
        'No Antigravity Language Server instance is available',
        'INSTANCE_UNAVAILABLE'
      );
    }
    const responses = await Promise.allSettled(
      instances.map(async (instance) => ({
        instance,
        response: await this.client.callReadOnly(
          'GetAllCascadeTrajectories',
          {},
          instance
        ),
      }))
    );
    const nextIndex = new Map();
    let successfulInstances = 0;
    for (const result of responses) {
      if (result.status !== 'fulfilled') continue;
      successfulInstances += 1;
      const { instance, response } = result.value;
      for (const [key, summary] of Object.entries(
        response?.trajectorySummaries || {}
      )) {
        const id = String(key || summary?.trajectoryId || '').trim();
        if (!id) continue;
        const candidate = {
          instance,
          summary: summary || {},
          sources: [{ instance, summary: summary || {} }],
        };
        const existing = nextIndex.get(id);
        if (!existing) {
          nextIndex.set(id, candidate);
          continue;
        }
        const preferred = preferSummary(existing, candidate);
        nextIndex.set(id, {
          instance: preferred.instance,
          summary: preferred.summary,
          sources: [...existing.sources, ...candidate.sources],
        });
      }
    }
    if (!successfulInstances) {
      throw new ConversationReadError(
        'Antigravity conversation data is temporarily unavailable'
      );
    }
    let diskConversations = [];
    try {
      const directories = this.getConversationDirectories(instances);
      diskConversations = await this.scanDisk({ directories });
    } catch (_) { }

    const candidates = [];
    for (const [id, entry] of nextIndex) {
      candidates.push({
        id,
        entry,
        modifiedAt: modifiedTimestamp(entry.summary),
        diskOnly: false,
      });
    }
    for (const diskConversation of diskConversations) {
      if (nextIndex.has(diskConversation.id)) continue;
      const summary = {
        summary: `Loading conversation ${diskConversation.id.slice(0, 8)}...`,
        stepCount: 0,
        status: 'CASCADE_RUN_STATUS_UNLOADED',
        lastModifiedTime: diskConversation.modifiedAt,
        createdTime: diskConversation.modifiedAt,
        trajectoryId: diskConversation.id,
        _diskOnly: true,
      };
      candidates.push({
        id: diskConversation.id,
        entry: {
          instance: instances[0],
          summary,
          sources: instances.map((instance) => ({ instance, summary })),
        },
        modifiedAt: Date.parse(diskConversation.modifiedAt) || 0,
        diskOnly: true,
      });
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const limitedCandidates = candidates.slice(0, this.maxConversations);
    this.summaryIndex = new Map(
      limitedCandidates.map((candidate) => [candidate.id, candidate.entry])
    );
    this.summariesLoadedAt = this.now();
    this.queueDiskWarmup(
      limitedCandidates
        .filter((candidate) => candidate.diskOnly)
        .map((candidate) => candidate.id),
      instances
    );
    return this.summaryIndex;
  }

  queueDiskWarmup(ids, instances) {
    if (this.warmupPromise || !ids.length || !instances.length) return;
    const now = this.now();
    const pending = ids.filter((id) => {
      if (!this.warmedAt.has(id)) return true;
      const warmedAt = this.warmedAt.get(id) || 0;
      return now - warmedAt >= this.warmupTtlMs;
    });
    if (!pending.length) return;
    for (const id of pending) this.warmedAt.set(id, now);

    const operation = (async () => {
      for (let index = 0; index < pending.length; index += this.warmupConcurrency) {
        const batch = pending.slice(index, index + this.warmupConcurrency);
        await Promise.allSettled(
          batch.map(async (cascadeId) => {
            for (const instance of instances) {
              try {
                await this.client.callReadOnly(
                  'GetCascadeTrajectorySteps',
                  { cascadeId, stepOffset: DISK_WARMUP_STEP_OFFSET },
                  instance
                );
                return;
              } catch (_) { }
            }
          })
        );
      }
    })();
    this.warmupPromise = operation;
    void operation.finally(() => {
      if (this.warmupPromise === operation) this.warmupPromise = null;
      this.invalidateSummaries();
    });
  }

  async listConversations({ force = false } = {}) {
    const index = await this.refreshSummaries({ force });
    const summaries = Object.fromEntries(
      Array.from(index, ([id, entry]) => [id, entry.summary])
    );
    return normalizeTrajectorySummaries(summaries, {
      activeConversationId: this.activeConversationId,
      now: this.now(),
    });
  }

  async getConversationMutationTarget(conversationId, { force = true } = {}) {
    const id = String(conversationId || '').trim();
    if (!id) {
      throw new ConversationReadError(
        'No active conversation is selected',
        'CONVERSATION_NOT_SELECTED'
      );
    }
    const index = await this.refreshSummaries({ force });
    const entry = index.get(id);
    if (!entry) {
      throw new ConversationReadError(
        'The selected conversation is no longer available',
        'CONVERSATION_NOT_FOUND'
      );
    }

    const uniqueSources = [];
    const seen = new Set();
    for (const source of entry.sources) {
      const identity = instanceIdentity(source.instance);
      if (seen.has(identity)) continue;
      seen.add(identity);
      uniqueSources.push(source);
    }
    if (uniqueSources.length === 1) return uniqueSources[0];

    const runningSources = uniqueSources.filter((source) =>
      isRunningSummary(source.summary)
    );
    if (runningSources.length === 1) return runningSources[0];

    throw new ConversationReadError(
      'The selected conversation owner is ambiguous',
      'OWNER_AMBIGUOUS'
    );
  }

  async getConversationRevision(
    conversationId = this.activeConversationId,
    { force = false } = {}
  ) {
    const id = String(conversationId || '').trim();
    if (!id) {
      throw new ConversationReadError(
        'No active conversation is selected',
        'CONVERSATION_NOT_SELECTED'
      );
    }
    const index = await this.refreshSummaries({ force });
    const entry = index.get(id);
    if (!entry) {
      throw new ConversationReadError(
        'The selected conversation is no longer available',
        'CONVERSATION_NOT_FOUND'
      );
    }
    return buildConversationRevision(id, entry.summary);
  }

  async getActiveConversationRevision(options) {
    return this.getConversationRevision(this.activeConversationId, options);
  }

  async loadConversationSteps(conversationId, { force = true } = {}) {
    const id = String(conversationId || '').trim();
    if (!id) {
      throw new ConversationReadError(
        'No active conversation is selected',
        'CONVERSATION_NOT_SELECTED'
      );
    }
    const index = await this.refreshSummaries({ force });
    const entry = index.get(id);
    if (!entry) {
      throw new ConversationReadError(
        'The selected conversation is no longer available',
        'CONVERSATION_NOT_FOUND'
      );
    }
    let response = null;
    let readableSummary = entry.summary;
    const preferredSource = entry.sources.find(
      (source) => source.instance === entry.instance
    );
    const sources = [
      ...(preferredSource ? [preferredSource] : []),
      ...entry.sources.filter((source) => source !== preferredSource),
    ];
    for (const source of sources) {
      try {
        response = await this.client.callReadOnly(
          'GetCascadeTrajectorySteps',
          { cascadeId: id, stepOffset: 0 },
          source.instance
        );
        readableSummary = source.summary;
        break;
      } catch (_) { }
    }
    if (!response) {
      throw new ConversationReadError(
        'The selected conversation messages are temporarily unavailable',
        'STEPS_UNAVAILABLE'
      );
    }
    return {
      id,
      summary: readableSummary,
      steps: Array.isArray(response?.steps) ? response.steps : [],
    };
  }

  async loadConversation(conversationId, options = {}) {
    const loaded = await this.loadConversationSteps(conversationId, options);
    const { id, summary: readableSummary, steps } = loaded;
    const messages = trajectoryStepsToMessages(steps);
    const snapshot = renderTrajectorySnapshot(messages, {
      conversationId: id,
      title: readableSummary?.summary || '',
      status: readableSummary?.status || '',
    });
    return {
      id,
      summary: readableSummary,
      revision: buildConversationRevision(id, readableSummary),
      messages,
      snapshot,
    };
  }

  async loadConversationFileChanges(conversationId, stepIndex, options = {}) {
    const { steps } = await this.loadConversationSteps(conversationId, options);
    return findTrajectoryFileChanges(steps, stepIndex);
  }

  async loadActiveConversation(options) {
    return this.loadConversation(this.activeConversationId, options);
  }
}
