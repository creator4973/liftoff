// @ts-check

import http from 'http';
import https from 'https';

const SERVICE_PREFIX = 'exa.language_server_pb.LanguageServerService';
const CSRF_HEADER = 'x-codeium-csrf-token';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export const READ_ONLY_RPC_METHODS = Object.freeze([
  'GetWorkspaceInfos',
  'GetAllCascadeTrajectories',
  'GetCascadeTrajectorySteps',
  'GetUserStatus',
]);

export const MUTATION_RPC_METHODS = Object.freeze([
  'SendUserCascadeMessage',
  'StartCascade',
  'CancelCascadeInvocation',
]);

const READ_ONLY_RPC_METHOD_SET = new Set(READ_ONLY_RPC_METHODS);
const MUTATION_RPC_METHOD_SET = new Set(MUTATION_RPC_METHODS);

export class LanguageServerRpcError extends Error {
  constructor(message, code, statusCode = null) {
    super(message);
    this.name = 'LanguageServerRpcError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function asPort(value) {
  const port = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : 0;
}

export function buildReadOnlyRpcPath(method) {
  if (!READ_ONLY_RPC_METHOD_SET.has(method)) {
    throw new LanguageServerRpcError(
      `RPC method is not in the read-only allowlist: ${method}`,
      'METHOD_NOT_ALLOWED'
    );
  }
  return `/${SERVICE_PREFIX}/${method}`;
}

export function buildMutationRpcPath(method) {
  if (!MUTATION_RPC_METHOD_SET.has(method)) {
    throw new LanguageServerRpcError(
      `RPC method is not in the mutation allowlist: ${method}`,
      'METHOD_NOT_ALLOWED'
    );
  }
  return `/${SERVICE_PREFIX}/${method}`;
}

export function buildTransportCandidates(instance) {
  const candidates = [];
  const seen = new Set();
  const add = (protocol, value) => {
    const port = asPort(value);
    const key = `${protocol}:${port}`;
    if (!port || seen.has(key)) return;
    seen.add(key);
    candidates.push({ protocol, port });
  };

  add('https', instance?.httpsPort);
  add('http', instance?.httpPort);
  add('https', instance?.extensionServerPort);
  add('http', instance?.extensionServerPort);
  for (const port of instance?.ports || []) {
    add('https', port);
    add('http', port);
  }

  return candidates;
}

function assertRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LanguageServerRpcError(
      'RPC request body must be a JSON object',
      'INVALID_BODY'
    );
  }
}

function transportCacheKey(instance) {
  return JSON.stringify({
    pid: Number(instance?.pid || 0),
    workspaceId: String(instance?.workspaceId || ''),
    ports: buildTransportCandidates(instance),
  });
}

function assertTransport(instance, transport) {
  const allowed = buildTransportCandidates(instance);
  const match = allowed.find(
    (candidate) =>
      candidate.protocol === transport?.protocol &&
      candidate.port === transport?.port
  );
  if (!match) {
    throw new LanguageServerRpcError(
      'Language Server mutation transport was not preflighted',
      'TRANSPORT_NOT_PREFLIGHTED'
    );
  }
  return match;
}

function requestJson({
  protocol,
  port,
  path,
  payload,
  csrfToken,
  timeoutMs,
  maxResponseBytes,
}) {
  return new Promise((resolve, reject) => {
    const requestFn = protocol === 'https' ? https.request : http.request;
    const request = requestFn(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          [CSRF_HEADER]: csrfToken,
        },
        ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks = [];
        let receivedBytes = 0;
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            request.destroy(
              new LanguageServerRpcError(
                'Language Server response exceeded the configured size limit',
                'RESPONSE_TOO_LARGE'
              )
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode || 500;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new LanguageServerRpcError(
                `Language Server returned HTTP ${statusCode}`,
                statusCode === 401 || statusCode === 403
                  ? 'AUTHENTICATION_FAILED'
                  : 'HTTP_ERROR',
                statusCode
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(responseBody || '{}'));
          } catch (_) {
            reject(
              new LanguageServerRpcError(
                'Language Server returned invalid JSON',
                'INVALID_RESPONSE'
              )
            );
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new LanguageServerRpcError(
          'Language Server request timed out',
          'TIMEOUT'
        )
      );
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

export class ReadOnlyLanguageServerRpcClient {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    request = requestJson,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.request = request;
    this.transportCache = new Map();
  }

  async callReadOnly(method, body = {}, instance) {
    const result = await this.callReadOnlyWithTransport(method, body, instance);
    return result.data;
  }

  async callReadOnlyWithTransport(method, body = {}, instance) {
    const path = buildReadOnlyRpcPath(method);
    assertRequestBody(body);

    const csrfToken = String(instance?.csrfToken || '').trim();
    if (!csrfToken) {
      throw new LanguageServerRpcError(
        'Language Server authentication token is unavailable',
        'AUTHENTICATION_UNAVAILABLE'
      );
    }

    const cacheKey = transportCacheKey(instance);
    const cached = this.transportCache.get(cacheKey);
    const candidates = buildTransportCandidates(instance);
    if (cached) {
      const cachedIndex = candidates.findIndex(
        (candidate) =>
          candidate.protocol === cached.protocol &&
          candidate.port === cached.port
      );
      if (cachedIndex > 0) {
        candidates.unshift(...candidates.splice(cachedIndex, 1));
      }
    }
    if (!candidates.length) {
      throw new LanguageServerRpcError(
        'Language Server has no usable loopback transport',
        'TRANSPORT_UNAVAILABLE'
      );
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const data = await this.request({
          ...candidate,
          path,
          payload: JSON.stringify(body),
          csrfToken,
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        });
        this.transportCache.set(cacheKey, candidate);
        return { data, transport: candidate };
      } catch (error) {
        lastError = error;
        if (
          cached?.protocol === candidate.protocol &&
          cached?.port === candidate.port
        ) {
          this.transportCache.delete(cacheKey);
        }
        if (error?.code === 'AUTHENTICATION_FAILED') throw error;
      }
    }

    throw new LanguageServerRpcError(
      'Unable to reach the Antigravity Language Server over loopback',
      lastError?.code || 'TRANSPORT_FAILED'
    );
  }
}

export class LanguageServerMutationRpcClient {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    request = requestJson,
    readClient = new ReadOnlyLanguageServerRpcClient({
      timeoutMs,
      maxResponseBytes,
      request,
    }),
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.request = request;
    this.readClient = readClient;
  }

  async preflightConversation(conversationId, instance) {
    const id = String(conversationId || '').trim();
    if (!id) {
      throw new LanguageServerRpcError(
        'Conversation id is required for mutation preflight',
        'INVALID_BODY'
      );
    }
    const result = await this.readClient.callReadOnlyWithTransport(
      'GetAllCascadeTrajectories',
      {},
      instance
    );
    if (!result.data?.trajectorySummaries?.[id]) {
      throw new LanguageServerRpcError(
        'Conversation is not available on the preflighted Language Server',
        'CONVERSATION_NOT_FOUND'
      );
    }
    return result.transport;
  }

  async preflightInstance(instance) {
    const result = await this.readClient.callReadOnlyWithTransport(
      'GetWorkspaceInfos',
      {},
      instance
    );
    return result.transport;
  }

  async callMutation(method, body, instance, transport) {
    const path = buildMutationRpcPath(method);
    assertRequestBody(body);
    const candidate = assertTransport(instance, transport);
    const csrfToken = String(instance?.csrfToken || '').trim();
    if (!csrfToken) {
      throw new LanguageServerRpcError(
        'Language Server authentication token is unavailable',
        'AUTHENTICATION_UNAVAILABLE'
      );
    }

    // Mutation calls are deliberately single-shot. Retrying another protocol
    // after an ambiguous failure could deliver the same user message twice.
    return this.request({
      ...candidate,
      path,
      payload: JSON.stringify(body),
      csrfToken,
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
    });
  }
}
