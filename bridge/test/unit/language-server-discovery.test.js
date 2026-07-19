import { describe, expect, it } from 'vitest';
import {
  discoverDaemonLanguageServers,
  discoverLanguageServerInstances,
  getListeningPortsForPid,
  mergeLanguageServerInstances,
  parseDaemonLanguageServer,
  parseLanguageServerCommand,
  sanitizeLanguageServerInstance,
} from '../../src/language-server/discovery.js';

describe('language-server discovery', () => {
  it('parses quoted and equals-style process flags', () => {
    const parsed = parseLanguageServerCommand(
      '420 language_server.exe --csrf_token=secret --extension_server_port 43123 --workspace_id file_C_repo --app_data_dir "C:\\Users\\Test User\\AppData"'
    );

    expect(parsed.pid).toBe(420);
    expect(parsed.csrfToken).toBe('secret');
    expect(parsed.extensionServerPort).toBe(43123);
    expect(parsed.workspaceId).toBe('file_C_repo');
    expect(parsed.appDataDir).toBe('C:\\Users\\Test User\\AppData');
  });

  it('normalizes valid daemon metadata and rejects incomplete entries', () => {
    expect(
      parseDaemonLanguageServer(
        {
          pid: 51,
          httpsPort: 45001,
          httpPort: 45002,
          lspPort: 45003,
          csrfToken: 'daemon-secret',
          workspaceId: 'workspace-a',
        },
        'ls_51.json'
      )
    ).toMatchObject({
      pid: 51,
      source: 'daemon',
      ports: [45001, 45002, 45003],
      daemonFile: 'ls_51.json',
    });
    expect(parseDaemonLanguageServer({ pid: 51, httpsPort: 45001 })).toBeNull();
  });

  it('skips malformed and dead daemon files', async () => {
    const instances = await discoverDaemonLanguageServers({
      daemonDir: 'virtual-daemon',
      readDirectory: async () => ['ls_1.json', 'ls_2.json', 'other.json'],
      readFile: async (path) => {
        if (String(path).endsWith('ls_1.json')) {
          return JSON.stringify({
            pid: 1,
            httpsPort: 47001,
            csrfToken: 'one',
          });
        }
        return '{not-json';
      },
      isAlive: async (pid) => pid === 1,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].pid).toBe(1);
  });

  it('prefers daemon identity data while preserving discovered ports', () => {
    const merged = mergeLanguageServerInstances(
      [
        {
          pid: 9,
          source: 'process',
          csrfToken: 'process-token',
          workspaceId: 'process-workspace',
          ports: [48001, 48002],
        },
      ],
      [
        {
          pid: 9,
          source: 'daemon',
          csrfToken: 'daemon-token',
          workspaceId: 'daemon-workspace',
          httpsPort: 48003,
          ports: [48003],
        },
      ]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      pid: 9,
      source: 'daemon',
      csrfToken: 'daemon-token',
      workspaceId: 'daemon-workspace',
      ports: [48001, 48002, 48003],
    });
  });

  it('returns an empty Windows port list for the normal no-match error', async () => {
    const error = Object.assign(new Error('no listeners'), {
      stderr: 'No matching MSFT_NetTCPConnection objects found',
    });
    const ports = await getListeningPortsForPid(123, {
      platform: 'win32',
      runFile: async () => {
        throw error;
      },
    });
    expect(ports).toEqual([]);
  });

  it('merges daemon and process discovery without exposing secrets', async () => {
    const instances = await discoverLanguageServerInstances({
      daemonOptions: {
        daemonDir: 'virtual-daemon',
        readDirectory: async () => ['ls_77.json'],
        readFile: async () =>
          JSON.stringify({
            pid: 77,
            httpsPort: 49003,
            csrfToken: 'daemon-token',
            workspaceId: 'daemon-workspace',
          }),
        isAlive: async () => true,
      },
      processOptions: {
        platform: 'win32',
        runFile: async () => ({
          stdout: JSON.stringify({
            ProcessId: 77,
            CommandLine:
              'language_server.exe --csrf_token process-token --extension_server_port 49001',
          }),
        }),
      },
      getPorts: async () => [49001, 49002],
      getFallbackToken: async () => 'fallback-token',
    });

    expect(instances).toHaveLength(1);
    expect(instances[0].csrfToken).toBe('daemon-token');
    expect(instances[0].ports).toEqual([49001, 49002, 49003]);

    const safe = sanitizeLanguageServerInstance(instances[0]);
    expect(safe).toEqual({
      pid: 77,
      source: 'daemon',
      workspaceId: 'daemon-workspace',
      portCount: 3,
      hasHttpsPort: true,
      hasHttpPort: false,
    });
    expect(safe).not.toHaveProperty('ports');
    expect(safe).not.toHaveProperty('csrfToken');
    expect(safe).not.toHaveProperty('commandLine');
    expect(safe).not.toHaveProperty('daemonFile');
  });
});
