import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const PROCESS_START_TOLERANCE_MS = 2_000;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeCommandLine(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
}

function commandHash(commandLine) {
  return crypto
    .createHash('sha256')
    .update(normalizeCommandLine(commandLine))
    .digest('hex');
}

export function processIdentity(entry) {
  return {
    pid: entry.pid,
    parentPid: entry.parentPid,
    startedAt: entry.startedAt,
    commandHash: commandHash(entry.commandLine),
  };
}

export function registryDirectory(env = process.env) {
  if (env.MC_DEV_SERVER_REGISTRY_DIR) {
    return path.resolve(env.MC_DEV_SERVER_REGISTRY_DIR);
  }
  const base =
    process.platform === 'win32'
      ? env.LOCALAPPDATA || os.tmpdir()
      : env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'mission-control', 'dev-servers');
}

export function validatePersistence(options) {
  if (!options.persistent) {
    return {
      mode: 'session',
      expiresAt: new Date(options.now + DEFAULT_SESSION_TTL_MS).toISOString(),
    };
  }
  if (!options.owner?.trim()) {
    throw new Error('Durable servers require --owner.');
  }
  if (!options.purpose?.trim()) {
    throw new Error('Durable servers require --purpose.');
  }
  if (
    !Number.isFinite(options.ttlMinutes) ||
    options.ttlMinutes < 1 ||
    options.ttlMinutes > 24 * 60
  ) {
    throw new Error('Durable servers require --ttl-minutes between 1 and 1440.');
  }
  return {
    mode: 'durable',
    owner: options.owner.trim(),
    purpose: options.purpose.trim(),
    expiresAt: new Date(options.now + options.ttlMinutes * 60_000).toISOString(),
  };
}

export function sameProcessIdentity(expected, actual) {
  if (!expected || !actual || expected.pid !== actual.pid) return false;
  const expectedStart = Date.parse(expected.startedAt);
  const actualStart = Date.parse(actual.startedAt);
  if (
    !Number.isFinite(expectedStart) ||
    !Number.isFinite(actualStart) ||
    Math.abs(expectedStart - actualStart) > PROCESS_START_TOLERANCE_MS
  ) {
    return false;
  }
  const expectedCommand = normalizeCommandLine(expected.commandLine);
  const actualCommand = normalizeCommandLine(actual.commandLine);
  if (
    expected.commandHash &&
    expected.commandHash !== commandHash(actual.commandLine)
  ) {
    return false;
  }
  return (
    !expectedCommand ||
    !actualCommand ||
    expectedCommand === actualCommand
  );
}

export function processTree(snapshot, rootPid) {
  const byParent = new Map();
  const byPid = new Map();
  for (const entry of snapshot.processes) {
    byPid.set(entry.pid, entry);
    const children = byParent.get(entry.parentPid) ?? [];
    children.push(entry);
    byParent.set(entry.parentPid, children);
  }
  const result = [];
  const visited = new Set();
  function visit(pid) {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const child of byParent.get(pid) ?? []) visit(child.pid);
    const processEntry = byPid.get(pid);
    if (processEntry) result.push(processEntry);
  }
  visit(rootPid);
  return result;
}

export function cleanupTargets(record, snapshot) {
  const root = snapshot.processes.find(
    (entry) => entry.pid === record.process.pid,
  );
  if (!sameProcessIdentity(record.process, root)) return [];
  return processTree(snapshot, root.pid);
}

export function selectSessionOwner(snapshot, currentPid, fallbackPid) {
  const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
  const ancestors = [];
  const visited = new Set();
  let cursor = byPid.get(currentPid);
  while (cursor && !visited.has(cursor.pid)) {
    visited.add(cursor.pid);
    const parent = byPid.get(cursor.parentPid);
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent;
  }
  return (
    ancestors.find((entry) =>
      /(?:^|[\\/"])(?:github-)?copilot(?:\.exe)?(?:["\s]|$)/i.test(
        entry.commandLine || '',
      ),
    ) ??
    byPid.get(fallbackPid) ??
    null
  );
}

export function orphanReason(record, snapshot, now, workspaceExists) {
  const root = snapshot.processes.find(
    (entry) => entry.pid === record.process.pid,
  );
  if (!sameProcessIdentity(record.process, root)) {
    return 'registered process exited or PID was reused';
  }
  if (Date.parse(record.persistence.expiresAt) <= now) {
    return record.persistence.mode === 'durable'
      ? 'durable TTL expired'
      : 'session TTL expired';
  }
  if (record.persistence.mode === 'durable') return null;
  if (!workspaceExists) return 'owning worktree no longer exists';
  const owner = snapshot.processes.find(
    (entry) => entry.pid === record.session.ownerProcess.pid,
  );
  if (!sameProcessIdentity(record.session.ownerProcess, owner)) {
    return 'owning session process exited';
  }
  return null;
}

export function summarizeRecord(record, snapshot) {
  const tree = cleanupTargets(record, snapshot);
  const memoryBytes = tree.reduce(
    (total, entry) => total + (entry.memoryBytes || 0),
    0,
  );
  const portOwnerPid = snapshot.ports.get(record.port) ?? null;
  return {
    processTreePids: tree.map((entry) => entry.pid),
    memoryBytes,
    portOwnerPid,
    portOwnedByTree:
      portOwnerPid == null || tree.some((entry) => entry.pid === portOwnerPid),
  };
}

async function queryWindowsProcesses() {
  const script = [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '[pscustomobject]@{',
    'pid=[int]$_.ProcessId;',
    'parentPid=[int]$_.ParentProcessId;',
    "startedAt=$_.CreationDate.ToUniversalTime().ToString('o');",
    'commandLine=[string]$_.CommandLine;',
    'memoryBytes=[long]$_.WorkingSetSize',
    '}',
    '} | ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout } = await execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  return asArray(JSON.parse(stdout || '[]'));
}

async function queryWindowsPorts() {
  const script = [
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
    'ForEach-Object {',
    '[pscustomobject]@{',
    'port=[int]$_.LocalPort;',
    'pid=[int]$_.OwningProcess',
    '}',
    '} | ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout } = await execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  return asArray(JSON.parse(stdout || '[]'));
}

async function queryPosixProcesses() {
  const { stdout } = await execFile(
    'ps',
    ['-eo', 'pid=,ppid=,etimes=,rss=,args='],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const now = Date.now();
  return stdout
    .split(/\r?\n/)
    .map((line) =>
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line),
    )
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startedAt: new Date(now - Number(match[3]) * 1000).toISOString(),
      memoryBytes: Number(match[4]) * 1024,
      commandLine: match[5],
    }));
}

async function queryPosixPorts() {
  try {
    const { stdout } = await execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const ports = [];
    let pid = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
        continue;
      }
      const match = /^n.*:(\d+)$/.exec(line);
      if (pid && match) ports.push({ port: Number(match[1]), pid });
    }
    return ports;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 1) return [];
    throw error;
  }
}

export async function processSnapshot() {
  if (process.platform === 'win32') {
    const [processes, ports] = await Promise.all([
      queryWindowsProcesses(),
      queryWindowsPorts(),
    ]);
    return {
      processes,
      ports: new Map(ports.map((entry) => [entry.port, entry.pid])),
    };
  }
  const [processes, ports] = await Promise.all([
    queryPosixProcesses(),
    queryPosixPorts(),
  ]);
  return {
    processes,
    ports: new Map(ports.map((entry) => [entry.port, entry.pid])),
  };
}

export async function waitForProcess(pid, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await processSnapshot();
    const entry = snapshot.processes.find((item) => item.pid === pid);
    if (entry) return { entry, snapshot };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} did not appear in the process inventory.`);
}

export async function workspaceExists(workspace) {
  try {
    await access(workspace, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeRecord(directory, record) {
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${record.id}.json`);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await rename(temporary, destination);
}

export async function removeRecord(directory, id) {
  await rm(path.join(directory, `${id}.json`), { force: true });
}

export async function readRecords(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.filter((name) => name.endsWith('.json'))) {
    try {
      records.push(
        JSON.parse(await readFile(path.join(directory, entry), 'utf8')),
      );
    } catch (error) {
      process.stderr.write(
        `[dev-server] Cannot read registry entry ${entry}: ${error.message}\n`,
      );
    }
  }
  return records;
}

function formatMemory(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export async function stopRegisteredProcess(
  record,
  snapshot,
  killProcess = process.kill,
  options = {},
) {
  const targets = cleanupTargets(record, snapshot);
  const stoppedPids = new Set(targets.map((target) => target.pid));
  for (const target of targets) {
    try {
      killProcess(target.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  const shouldEscalate =
    (options.platform ?? process.platform) !== 'win32' &&
    (options.escalate ?? killProcess === process.kill);
  if (shouldEscalate) {
    await (options.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))))(1_000);
    const refreshed = await (
      options.refreshSnapshot ?? processSnapshot
    )();
    const survivors = cleanupTargets(record, refreshed);
    for (const target of survivors) {
      try {
        killProcess(target.pid, 'SIGKILL');
        stoppedPids.add(target.pid);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
  return [...stoppedPids];
}

export async function checkHealth(port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (healthy) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function scanRegistry(options = {}) {
  const now = options.now ?? Date.now();
  const directory = options.directory ?? registryDirectory();
  const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const snapshot = options.snapshot ?? (await processSnapshot());
  const recordIds = options.recordIds ? new Set(options.recordIds) : null;
  const records = (await readRecords(directory)).filter(
    (record) => !recordIds || recordIds.has(record.id),
  );
  const results = [];

  for (const record of records) {
    const exists = await (options.workspaceExists ?? workspaceExists)(
      record.session.worktree,
    );
    const reason = orphanReason(record, snapshot, now, exists);
    const summary = summarizeRecord(record, snapshot);
    const healthy =
      summary.portOwnedByTree &&
      (await (options.checkHealth ?? checkHealth)(record.port));
    const updated = {
      ...record,
      processTreePids: summary.processTreePids,
      lastHealthCheckAt: new Date(now).toISOString(),
      health: healthy,
      memoryBytes: summary.memoryBytes,
      portOwnerPid: summary.portOwnerPid,
    };

    if (!reason) {
      delete updated.orphanDetectedAt;
      delete updated.orphanReason;
      await writeRecord(directory, updated);
      results.push({ record: updated, state: 'active' });
      continue;
    }

    const detectedAt = record.orphanDetectedAt
      ? Date.parse(record.orphanDetectedAt)
      : now;
    updated.orphanDetectedAt =
      record.orphanDetectedAt ?? new Date(now).toISOString();
    updated.orphanReason = reason;
    const ageMs = now - detectedAt;

    if (ageMs < graceMs || options.cleanup === false) {
      await writeRecord(directory, updated);
      process.stderr.write(
        `[dev-server] Orphan warning: ${record.id} on port ${record.port} ` +
          `(${reason}, ${formatMemory(summary.memoryBytes)}). ` +
          `Cleanup in ${Math.max(0, Math.ceil((graceMs - ageMs) / 1000))}s.\n`,
      );
      results.push({ record: updated, state: 'warning', reason });
      continue;
    }

    const killedPids = await stopRegisteredProcess(
      record,
      snapshot,
      options.killProcess,
    );
    await removeRecord(directory, record.id);
    process.stderr.write(
      `[dev-server] Cleaned orphan ${record.id}; exact PIDs: ` +
        `${killedPids.join(', ') || 'none (already exited)'}.\n`,
    );
    results.push({ record: updated, state: 'cleaned', reason, killedPids });
  }
  return results;
}
