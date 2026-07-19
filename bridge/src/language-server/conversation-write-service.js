// @ts-check

import { LanguageServerMutationRpcClient } from './rpc-client.js';

const DEFAULT_DEDUPE_WINDOW_MS = 1500;
const DEFAULT_PROVISIONAL_OWNER_WINDOW_MS = 120000;
const MODEL_CONFIG_LOOKBACK_STEPS = 64;

export function deriveCascadeConfigFromSteps(steps) {
  if (!Array.isArray(steps)) return null;

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const plannerConfig = steps[index]?.userInput?.lastUserConfig?.plannerConfig;
    const model = String(plannerConfig?.requestedModel?.model || '').trim();
    if (!model) continue;

    return {
      plannerConfig: {
        plannerTypeConfig: plannerConfig?.planning
          ? { planning: {} }
          : { conversational: {} },
        requestedModel: { model },
      },
    };
  }

  return null;
}

export class ConversationWriteError extends Error {
  constructor(message, code = 'WRITE_FAILED', mutationAttempted = false) {
    super(message);
    this.name = 'ConversationWriteError';
    this.code = code;
    this.mutationAttempted = mutationAttempted;
  }
}

export class LanguageServerConversationWriteService {
  constructor({
    readService,
    client = new LanguageServerMutationRpcClient({
      readClient: readService?.client,
    }),
    metadata = {},
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    provisionalOwnerWindowMs = DEFAULT_PROVISIONAL_OWNER_WINDOW_MS,
    now = () => Date.now(),
  } = {}) {
    if (!readService) {
      throw new TypeError('readService is required');
    }
    this.readService = readService;
    this.client = client;
    this.metadata = {
      ideName: 'LiftOff',
      ...metadata,
    };
    this.dedupeWindowMs = dedupeWindowMs;
    this.provisionalOwnerWindowMs = provisionalOwnerWindowMs;
    this.now = now;
    this.inFlight = new Map();
    this.completed = new Map();
    this.provisionalConversations = new Map();
  }

  async sendText(text, { requestId = '', fallback = null } = {}) {
    const message = String(text || '');
    if (!message.trim()) {
      throw new ConversationWriteError('Message required', 'INVALID_MESSAGE');
    }
    const conversationId = this.readService.getActiveConversationId();

    this.pruneCompleted();
    const key = this.dedupeKey(
      conversationId || 'unselected',
      message,
      requestId
    );
    const pending = this.inFlight.get(key);
    if (pending) {
      const result = await pending;
      return { ...result, deduplicated: true };
    }
    const recent = this.completed.get(key);
    if (recent) {
      return { ...recent.result, deduplicated: true };
    }

    const operation = this.dispatchWithFallback(
      conversationId,
      message,
      fallback
    );
    this.inFlight.set(key, operation);
    try {
      const result = await operation;
      this.completed.set(key, { completedAt: this.now(), result });
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async dispatchWithFallback(conversationId, message, fallback) {
    try {
      return await this.dispatchText(conversationId, message);
    } catch (error) {
      if (!error?.mutationAttempted && typeof fallback === 'function') {
        return fallback(error);
      }
      throw error;
    }
  }

  async cancel({ fallback = null } = {}) {
    const conversationId = this.readService.getActiveConversationId();
    return this.runDeduplicatedOperation(
      `cancel\0${conversationId || 'unselected'}`,
      () => this.dispatchOperationWithFallback(
        () => this.dispatchCancel(conversationId),
        fallback
      )
    );
  }

  async startConversation({ fallback = null } = {}) {
    return this.runDeduplicatedOperation(
      'start-conversation',
      () => this.dispatchOperationWithFallback(
        () => this.dispatchStartConversation(),
        fallback
      )
    );
  }

  async dispatchOperationWithFallback(operation, fallback) {
    try {
      return await operation();
    } catch (error) {
      if (!error?.mutationAttempted && typeof fallback === 'function') {
        return fallback(error);
      }
      throw error;
    }
  }

  async dispatchCancel(conversationId) {
    if (!conversationId) {
      throw new ConversationWriteError(
        'No active conversation is selected',
        'CONVERSATION_NOT_SELECTED'
      );
    }

    let target;
    let transport;
    const provisional = this.getProvisionalConversation(conversationId);
    try {
      if (provisional) {
        target = { instance: provisional.instance };
        transport = await this.client.preflightInstance(target.instance);
      } else {
        target = await this.readService.getConversationMutationTarget(
          conversationId,
          { force: true }
        );
        transport = await this.client.preflightConversation(
          conversationId,
          target.instance
        );
      }
    } catch (error) {
      throw new ConversationWriteError(
        'Language Server cancellation is unavailable for this conversation',
        error?.code || 'RPC_PREFLIGHT_FAILED',
        Boolean(provisional)
      );
    }

    try {
      await this.client.callMutation(
        'CancelCascadeInvocation',
        { cascadeId: conversationId },
        target.instance,
        transport
      );
      this.readService.invalidateSummaries();
      return {
        success: true,
        method: 'language_server_rpc',
        transport: 'rpc',
        conversationId,
        deduplicated: false,
      };
    } catch (error) {
      throw new ConversationWriteError(
        'Antigravity did not confirm the Language Server cancellation request',
        error?.code || 'RPC_MUTATION_FAILED',
        true
      );
    }
  }

  async dispatchStartConversation() {
    let instance;
    let transport;
    let cascadeConfig;
    try {
      const activeId = this.readService.getActiveConversationId();
      if (!activeId) {
        throw Object.assign(
          new Error('An active conversation is required to inherit a model'),
          { code: 'MODEL_CONFIG_UNAVAILABLE' }
        );
      }
      const target = await this.readService.getConversationMutationTarget(
        activeId,
        { force: true }
      );
      instance = target.instance;
      cascadeConfig = await this.resolveCascadeConfig(activeId, target);
      transport = await this.client.preflightInstance(instance);
    } catch (error) {
      throw new ConversationWriteError(
        'Language Server conversation creation is unavailable',
        error?.code || 'RPC_PREFLIGHT_FAILED',
        false
      );
    }

    let response;
    try {
      response = await this.client.callMutation(
        'StartCascade',
        {
          metadata: this.metadata,
          source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        },
        instance,
        transport
      );
    } catch (error) {
      throw new ConversationWriteError(
        'Antigravity did not confirm the new Language Server conversation',
        error?.code || 'RPC_MUTATION_FAILED',
        true
      );
    }

    const conversationId = String(response?.cascadeId || '').trim();
    if (!conversationId) {
      throw new ConversationWriteError(
        'Antigravity returned no id for the new conversation',
        'INVALID_MUTATION_RESPONSE',
        true
      );
    }
    this.provisionalConversations.set(conversationId, {
      instance,
      transport,
      cascadeConfig,
      firstSentAt: 0,
    });
    this.readService.setActiveConversationId(conversationId);
    this.readService.invalidateSummaries();
    return {
      success: true,
      method: 'language_server_rpc',
      transport: 'rpc',
      conversationId,
      cascadeId: conversationId,
      deduplicated: false,
    };
  }

  async runDeduplicatedOperation(key, operation) {
    this.pruneCompleted();
    const pending = this.inFlight.get(key);
    if (pending) {
      const result = await pending;
      return { ...result, deduplicated: true };
    }
    const recent = this.completed.get(key);
    if (recent) return { ...recent.result, deduplicated: true };

    const pendingOperation = operation();
    this.inFlight.set(key, pendingOperation);
    try {
      const result = await pendingOperation;
      this.completed.set(key, { completedAt: this.now(), result });
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async dispatchText(conversationId, message) {
    if (!conversationId) {
      throw new ConversationWriteError(
        'No active conversation is selected',
        'CONVERSATION_NOT_SELECTED'
      );
    }
    let target;
    let transport;
    let cascadeConfig;
    const provisional = this.getProvisionalConversation(conversationId);
    try {
      if (provisional) {
        target = { instance: provisional.instance };
        transport = await this.client.preflightInstance(target.instance);
        cascadeConfig = provisional.cascadeConfig;
      } else {
        target = await this.readService.getConversationMutationTarget(
          conversationId,
          { force: true }
        );
        transport = await this.client.preflightConversation(
          conversationId,
          target.instance
        );
        cascadeConfig = await this.resolveCascadeConfig(
          conversationId,
          target
        );
      }
    } catch (error) {
      throw new ConversationWriteError(
        'Language Server text sending is unavailable for this conversation',
        error?.code || 'RPC_PREFLIGHT_FAILED',
        Boolean(provisional)
      );
    }

    try {
      await this.client.callMutation(
        'SendUserCascadeMessage',
        {
          metadata: this.metadata,
          cascadeId: conversationId,
          items: [{ type: 'text', text: message }],
          cascadeConfig,
        },
        target.instance,
        transport
      );
      if (provisional) provisional.firstSentAt = this.now();
      this.readService.invalidateSummaries();
      return {
        success: true,
        method: 'language_server_rpc',
        transport: 'rpc',
        conversationId,
        deduplicated: false,
      };
    } catch (error) {
      throw new ConversationWriteError(
        'Antigravity did not confirm the Language Server message request',
        error?.code || 'RPC_MUTATION_FAILED',
        true
      );
    }
  }

  getProvisionalConversation(conversationId) {
    const id = String(conversationId || '').trim();
    const provisional = this.provisionalConversations.get(id);
    if (!provisional) return null;
    if (
      provisional.firstSentAt > 0
      && this.now() - provisional.firstSentAt > this.provisionalOwnerWindowMs
    ) {
      this.provisionalConversations.delete(id);
      return null;
    }
    return provisional;
  }

  async resolveCascadeConfig(conversationId, target) {
    const stepCount = Math.max(0, Number(target?.summary?.stepCount) || 0);
    const rawConfiguredIndex = target?.summary?.lastUserInputStepIndex;
    const configuredIndex = Number(rawConfiguredIndex);
    const anchorIndex = rawConfiguredIndex != null
      && Number.isInteger(configuredIndex)
      && configuredIndex >= 0
      ? configuredIndex
      : Math.max(0, stepCount - 1);
    const stepOffset = Math.max(0, anchorIndex - MODEL_CONFIG_LOOKBACK_STEPS);
    const response = await this.readService.client.callReadOnly(
      'GetCascadeTrajectorySteps',
      { cascadeId: conversationId, stepOffset },
      target.instance
    );
    const config = deriveCascadeConfigFromSteps(response?.steps);
    if (!config) {
      throw Object.assign(
        new Error(
          'No valid model configuration is available for this conversation'
        ),
        { code: 'MODEL_CONFIG_UNAVAILABLE' }
      );
    }
    return config;
  }

  dedupeKey(conversationId, message, requestId) {
    const id = String(requestId || '').trim();
    return id
      ? `${conversationId}\0request:${id}`
      : `${conversationId}\0message:${message}`;
  }

  pruneCompleted() {
    const cutoff = this.now() - this.dedupeWindowMs;
    for (const [key, entry] of this.completed) {
      if (entry.completedAt < cutoff) this.completed.delete(key);
    }
  }
}
