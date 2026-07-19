// @ts-check

import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DEFAULT_DAEMON_DIR = join(
  os.homedir(),
  '.gemini',
  'antigravity',
  'daemon'
);

function asPositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniquePorts(values) {
  return [...new Set(values.map(asPositiveInteger).filter(Boolean))].sort(
    (a, b) => a - b
  );
}

function readFlagValue(commandLine, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(commandLine || '').match(
    new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s]+)`)
  );
  if (!match) return '';
  const value = match[1];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseLanguageServerCommand(commandLine) {
  const command = String(commandLine || '').trim();
  const pidMatch = command.match(/^\s*(\d+)\s+/);
  const pid = pidMatch ? asPositiveInteger(pidMatch[1]) : 0;
  const line = pidMatch ? command.slice(pidMatch[0].length) : command;

  return {
    pid: pid || null,
    commandLine: line,
    csrfToken: readFlagValue(line, '--csrf_token'),
    extensionServerPort: asPositiveInteger(
      readFlagValue(line, '--extension_server_port')
    ),
    extensionServerCsrfToken: readFlagValue(
      line,
      '--extension_server_csrf_token'
    ),
    workspaceId: readFlagValue(line, '--workspace_id'),
    appDataDir: readFlagValue(line, '--app_data_dir'),
    source: 'process',
  };
}

export function parseDaemonLanguageServer(data, sourceFile = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const pid = asPositiveInteger(data.pid);
  const httpsPort = asPositiveInteger(data.httpsPort);
  const httpPort = asPositiveInteger(data.httpPort);
  const lspPort = asPositiveInteger(data.lspPort);
  const csrfToken = String(data.csrfToken || '').trim();

  if (!pid || !csrfToken || (!httpsPort && !httpPort)) return null;

  return {
    pid,
    httpsPort,
    httpPort,
    lspPort,
    extensionServerPort: httpsPort || httpPort,
    ports: uniquePorts([httpsPort, httpPort, lspPort]),
    csrfToken,
    workspaceId: String(data.workspaceId || ''),
    source: 'daemon',
    daemonFile: sourceFile,
  };
}

export function isPidAlive(pid) {
  if (!asPositiveInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function discoverDaemonLanguageServers({
  daemonDir = DEFAULT_DAEMON_DIR,
  readDirectory = fs.readdir,
  readFile = fs.readFile,
  isAlive = isPidAlive,
} = {}) {
  let files;
  try {
    files = await readDirectory(daemonDir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }

  const instances = [];
  for (const fileName of files) {
    if (!fileName.startsWith('ls_') || !fileName.endsWith('.json')) continue;
    try {
      const filePath = join(daemonDir, fileName);
      const parsed = parseDaemonLanguageServer(
        JSON.parse(await readFile(filePath, 'utf8')),
        fileName
      );
      if (parsed && (await isAlive(parsed.pid))) instances.push(parsed);
    } catch (_) {
      // A stale or partially-written daemon file must not block discovery.
    }
  }

  return instances;
}

async function listProcessesLinux(runFile) {
  const { stdout } = await runFile('ps', ['-eo', 'pid=,args=']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /language_server/i.test(line))
    .map((line) => parseLanguageServerCommand(line))
    .filter((entry) => entry.pid);
}

async function listProcessesWindows(runFile) {
  const script = [
    '$items = Get-CimInstance Win32_Process |',
    "  Where-Object { $_.CommandLine -match 'language_server' } |",
    '  Select-Object ProcessId, CommandLine;',
    '$items | ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout } = await runFile('powershell', [
    '-NoProfile',
    '-Command',
    script,
  ]);
  if (!stdout.trim()) return [];
  const payload = JSON.parse(stdout);
  const items = Array.isArray(payload) ? payload : [payload];
  return items
    .map((item) =>
      parseLanguageServerCommand(
        `${item.ProcessId || ''} ${item.CommandLine || ''}`
      )
    )
    .filter((entry) => entry.pid);
}

export async function discoverLanguageServerProcesses({
  platform = process.platform,
  runFile = execFileAsync,
} = {}) {
  if (platform === 'win32') return listProcessesWindows(runFile);
  return listProcessesLinux(runFile);
}

function parseListeningPort(line) {
  const match = String(line).match(/:(\d+)\s+/);
  return match ? asPositiveInteger(match[1]) : 0;
}

export async function getListeningPortsForPid(
  pid,
  { platform = process.platform, runFile = execFileAsync } = {}
) {
  const safePid = asPositiveInteger(pid);
  if (!safePid) return [];

  if (platform === 'win32') {
    const script = [
      `$ports = @(Get-NetTCPConnection -OwningProcess ${safePid} -State Listen -ErrorAction SilentlyContinue |`,
      '  Select-Object -ExpandProperty LocalPort |',
      '  Sort-Object -Unique);',
      'if (-not $ports -or $ports.Count -eq 0) { "[]" } else { $ports | ConvertTo-Json -Compress }',
    ].join(' ');
    try {
      const { stdout } = await runFile('powershell', [
        '-NoProfile',
        '-Command',
        script,
      ]);
      if (!stdout.trim()) return [];
      const payload = JSON.parse(stdout);
      return uniquePorts(Array.isArray(payload) ? payload : [payload]);
    } catch (error) {
      const message = String(error?.stderr || error?.message || '');
      if (
        message.includes('CmdletizationQuery_NotFound') ||
        message.includes('No matching MSFT_NetTCPConnection objects found')
      ) {
        return [];
      }
      throw error;
    }
  }

  try {
    const { stdout } = await runFile('ss', ['-ltnp']);
    return uniquePorts(
      stdout
        .split('\n')
        .filter((line) => line.includes(`pid=${safePid}`))
        .map(parseListeningPort)
    );
  } catch (_) {
    const { stdout } = await runFile('lsof', [
      '-Pan',
      '-p',
      String(safePid),
      '-iTCP',
      '-sTCP:LISTEN',
    ]);
    return uniquePorts(stdout.split('\n').map(parseListeningPort));
  }
}

export function getCsrfTokenCandidatePaths() {
  return [
    join(os.homedir(), '.antigravity', 'data', 'machineid'),
    join(os.homedir(), '.config', 'Antigravity', 'User', 'machineid'),
    join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'User', 'machineid'),
  ];
}

export async function extractFallbackCsrfToken({ readFile = fs.readFile } = {}) {
  for (const filePath of getCsrfTokenCandidatePaths()) {
    try {
      const token = String(await readFile(filePath, 'utf8')).trim();
      if (token) return token;
    } catch (_) {
      // Ignore missing files and keep scanning.
    }
  }
  return '';
}

export function mergeLanguageServerInstances(...groups) {
  const byPid = new Map();

  for (const instance of groups.flat()) {
    const pid = asPositiveInteger(instance?.pid);
    if (!pid) continue;
    const previous = byPid.get(pid) || {};
    const preferIncoming = instance.source === 'daemon';
    const merged = preferIncoming
      ? { ...previous, ...instance }
      : { ...instance, ...previous };
    merged.ports = uniquePorts([
      ...(previous.ports || []),
      ...(instance.ports || []),
      previous.extensionServerPort,
      instance.extensionServerPort,
      previous.httpsPort,
      instance.httpsPort,
      previous.httpPort,
      instance.httpPort,
    ]);
    merged.workspaceId = instance.workspaceId || previous.workspaceId || '';
    merged.csrfToken = instance.csrfToken || previous.csrfToken || '';
    byPid.set(pid, merged);
  }

  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

export async function discoverLanguageServerInstances({
  daemonOptions = {},
  processOptions = {},
  getPorts = getListeningPortsForPid,
  getFallbackToken = extractFallbackCsrfToken,
} = {}) {
  const [daemonResult, processResult] = await Promise.allSettled([
    discoverDaemonLanguageServers(daemonOptions),
    discoverLanguageServerProcesses(processOptions),
  ]);
  const daemonInstances =
    daemonResult.status === 'fulfilled' ? daemonResult.value : [];
  const processes =
    processResult.status === 'fulfilled' ? processResult.value : [];
  const fallbackToken = await getFallbackToken().catch(() => '');

  const processInstances = [];
  for (const entry of processes) {
    const ports = uniquePorts([
      entry.extensionServerPort,
      ...(await getPorts(entry.pid)),
    ]);
    if (!ports.length) continue;
    processInstances.push({
      ...entry,
      ports,
      csrfToken: entry.csrfToken || fallbackToken,
      source: 'process',
    });
  }

  return mergeLanguageServerInstances(processInstances, daemonInstances).filter(
    (instance) => instance.csrfToken && instance.ports.length
  );
}

export function sanitizeLanguageServerInstance(instance) {
  const ports = uniquePorts(instance?.ports || []);
  return {
    pid: asPositiveInteger(instance?.pid) || null,
    source: instance?.source || 'unknown',
    workspaceId: String(instance?.workspaceId || ''),
    portCount: ports.length,
    hasHttpsPort: Boolean(asPositiveInteger(instance?.httpsPort)),
    hasHttpPort: Boolean(asPositiveInteger(instance?.httpPort)),
  };
}
