import { describe, expect, it, vi } from 'vitest';
import {
  LanguageServerRpcError,
  LanguageServerMutationRpcClient,
  MUTATION_RPC_METHODS,
  READ_ONLY_RPC_METHODS,
  ReadOnlyLanguageServerRpcClient,
  buildMutationRpcPath,
  buildReadOnlyRpcPath,
  buildTransportCandidates,
} from '../../src/language-server/rpc-client.js';

describe('read-only Language Server RPC client', () => {
  it('exposes only the approved read methods', () => {
    expect(READ_ONLY_RPC_METHODS).toEqual([
      'GetWorkspaceInfos',
      'GetAllCascadeTrajectories',
      'GetCascadeTrajectorySteps',
      'GetUserStatus',
    ]);
    expect(buildReadOnlyRpcPath('GetWorkspaceInfos')).toContain(
      '/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos'
    );
    expect(() => buildReadOnlyRpcPath('SendUserCascadeMessage')).toThrow(
      /not in the read-only allowlist/
    );
  });

  it('builds deduplicated loopback transport candidates', () => {
    expect(
      buildTransportCandidates({
        httpsPort: 50001,
        httpPort: 50002,
        extensionServerPort: 50001,
        ports: [50001, 50002],
      })
    ).toEqual([
      { protocol: 'https', port: 50001 },
      { protocol: 'http', port: 50002 },
      { protocol: 'http', port: 50001 },
      { protocol: 'https', port: 50002 },
    ]);
  });

  it('sends an allowlisted request with the internal token', async () => {
    const request = vi.fn(async () => ({ workspaceInfos: [] }));
    const client = new ReadOnlyLanguageServerRpcClient({ request });

    await expect(
      client.callReadOnly('GetWorkspaceInfos', {}, {
        httpsPort: 51001,
        csrfToken: 'private-token',
      })
    ).resolves.toEqual({ workspaceInfos: [] });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({
      protocol: 'https',
      port: 51001,
      csrfToken: 'private-token',
      payload: '{}',
      timeoutMs: 30000,
    });
  });

  it('refuses mutation methods before any request is attempted', async () => {
    const request = vi.fn();
    const client = new ReadOnlyLanguageServerRpcClient({ request });

    await expect(
      client.callReadOnly('SendUserCascadeMessage', {}, {
        httpsPort: 52001,
        csrfToken: 'private-token',
      })
    ).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back from HTTPS to HTTP without exposing the token in errors', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('wrong protocol'), { code: 'EPROTO' }))
      .mockResolvedValueOnce({ trajectorySummaries: {} });
    const client = new ReadOnlyLanguageServerRpcClient({ request });

    await expect(
      client.callReadOnly('GetAllCascadeTrajectories', {}, {
        extensionServerPort: 53001,
        csrfToken: 'do-not-leak',
      })
    ).resolves.toEqual({ trajectorySummaries: {} });
    expect(request.mock.calls.map(([call]) => call.protocol)).toEqual([
      'https',
      'http',
    ]);
  });

  it('stops immediately on authentication failure', async () => {
    const request = vi.fn(async () => {
      throw new LanguageServerRpcError(
        'Language Server returned HTTP 401',
        'AUTHENTICATION_FAILED',
        401
      );
    });
    const client = new ReadOnlyLanguageServerRpcClient({ request });

    await expect(
      client.callReadOnly('GetUserStatus', {}, {
        ports: [54001, 54002],
        csrfToken: 'private-token',
      })
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      statusCode: 401,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports a sanitized failure after all transports fail', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    });
    const client = new ReadOnlyLanguageServerRpcClient({ request });

    let failure;
    try {
      await client.callReadOnly('GetWorkspaceInfos', {}, {
        ports: [55001],
        csrfToken: 'never-print-this',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'ECONNREFUSED' });
    expect(failure.message).not.toContain('never-print-this');
  });
});

describe('Language Server mutation RPC client', () => {
  it('exposes only the explicitly approved mutation methods', () => {
    expect(MUTATION_RPC_METHODS).toEqual([
      'SendUserCascadeMessage',
      'StartCascade',
      'CancelCascadeInvocation',
    ]);
    expect(buildMutationRpcPath('SendUserCascadeMessage')).toContain(
      '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage'
    );
    expect(() => buildMutationRpcPath('DeleteCascadeTrajectory')).toThrow(
      /not in the mutation allowlist/
    );
  });

  it('preflights a new-conversation instance without a mutation', async () => {
    const request = vi.fn(async () => ({ workspaceInfos: [] }));
    const readClient = new ReadOnlyLanguageServerRpcClient({ request });
    const client = new LanguageServerMutationRpcClient({ request, readClient });
    const instance = {
      httpsPort: 55901,
      csrfToken: 'private-token',
    };

    await expect(client.preflightInstance(instance)).resolves.toEqual({
      protocol: 'https',
      port: 55901,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].path).toContain('GetWorkspaceInfos');
  });

  it('preflights with a read and dispatches the mutation once on that transport', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ trajectorySummaries: { 'cascade-1': {} } })
      .mockResolvedValueOnce({});
    const readClient = new ReadOnlyLanguageServerRpcClient({ request });
    const client = new LanguageServerMutationRpcClient({ request, readClient });
    const instance = {
      httpsPort: 56001,
      httpPort: 56002,
      csrfToken: 'private-token',
    };

    const transport = await client.preflightConversation('cascade-1', instance);
    await client.callMutation(
      'SendUserCascadeMessage',
      { cascadeId: 'cascade-1', items: [{ type: 'text', text: 'Hello' }] },
      instance,
      transport
    );

    expect(transport).toEqual({ protocol: 'https', port: 56001 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toMatchObject({
      protocol: 'https',
      port: 56001,
      csrfToken: 'private-token',
    });
    expect(request.mock.calls[1][0].path).toContain('SendUserCascadeMessage');
  });

  it('never retries a mutation over another candidate transport', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
    });
    const client = new LanguageServerMutationRpcClient({ request });
    const instance = {
      httpsPort: 57001,
      httpPort: 57002,
      csrfToken: 'private-token',
    };

    await expect(
      client.callMutation(
        'SendUserCascadeMessage',
        { cascadeId: 'cascade-1', items: [{ type: 'text', text: 'Hello' }] },
        instance,
        { protocol: 'https', port: 57001 }
      )
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
