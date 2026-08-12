import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {
  cleanupTargets,
  processIdentity,
  processSnapshot,
  readRecords,
  registryDirectory,
  removeRecord,
  scanRegistry,
  selectSessionOwner,
  stopRegisteredProcess,
  summarizeRecord,
  validatePersistence,
  waitForProcess,
  writeRecord,
} from './lib/dev-server-lifecycle.mjs';

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/dev-server-manager.mjs run --port <port> [--persistent --owner <name> --purpose <text> --ttl-minutes <n>] -- <command> [args...]',
      '  node scripts/dev-server-manager.mjs list',
      '  node scripts/dev-server-manager.mjs scan',
      '  node scripts/dev-server-manager.mjs stop <id>',
      '',
    ].join('\n'),
  );
  process.exitCode = 2;
}

function parseRunArguments(args) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) {
    throw new Error('run requires -- followed by a command.');
  }
  const options = {
    persistent: false,
    now: Date.now(),
    command: args.slice(separator + 1),
  };
  for (let index = 0; index < separator; index += 1) {
    const argument = args[index];
    if (argument === '--persistent') {
      options.persistent = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--port') options.port = Number(value);
    else if (argument === '--owner') options.owner = value;
    else if (argument === '--purpose') options.purpose = value;
    else if (argument === '--ttl-minutes') options.ttlMinutes = Number(value);
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }
  options.persistence = validatePersistence(options);
  return options;
}

async function run(args) {
  const options = parseRunArguments(args);
  const directory = registryDirectory();
  const id = `${path.basename(process.cwd())}-${options.port}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const initialSnapshot = await processSnapshot();
  const owner =
    selectSessionOwner(initialSnapshot, process.pid, process.ppid) ??
    initialSnapshot.processes.find((entry) => entry.pid === process.ppid);
  if (!owner) {
    throw new Error('Cannot identify the owning session process.');
  }

  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
    detached: false,
  });
  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (!child.pid) throw new Error('Development server did not return a PID.');

  let record = null;
  let stopPromise = null;
  const stop = (signal) => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        if (record) {
          const current = await processSnapshot();
          const killed = await stopRegisteredProcess(record, current);
          process.stdout.write(
            `[dev-server] ${signal}: stopped exact PIDs ${killed.join(', ') || 'none'}.\n`,
          );
        } else {
          child.kill('SIGTERM');
          process.stdout.write(
            `[dev-server] ${signal}: stopped PID ${child.pid} during registration.\n`,
          );
        }
      } catch (error) {
        process.stderr.write(
          `[dev-server] ${signal} process-tree cleanup failed: ${error.message}. ` +
            `Falling back to child PID ${child.pid}.\n`,
        );
        child.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (child.exitCode == null) child.kill('SIGKILL');
      }
    })();
    return stopPromise;
  };
  const handleSignal = (signal) => {
    stop(signal).catch((error) => {
      process.stderr.write(
        `[dev-server] ${signal} fallback failed; registry entry retained: ` +
          `${error.message}\n`,
      );
    });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  let childProcess;
  let snapshot;
  try {
    ({ entry: childProcess, snapshot } = await waitForProcess(child.pid));
  } catch (error) {
    await stop('registration failure');
    throw error;
  }
  if (stopPromise) {
    await stopPromise;
    return;
  }
  record = {
    version: 1,
    id,
    port: options.port,
    process: processIdentity(childProcess),
    processTreePids: cleanupTargets(
      { process: processIdentity(childProcess) },
      snapshot,
    ).map((entry) => entry.pid),
    session: {
      id: process.env.COPILOT_AGENT_SESSION_ID || null,
      ownerProcess: processIdentity(owner),
      worktree: process.cwd(),
    },
    persistence: options.persistence,
    startedAt: new Date(options.now).toISOString(),
    lastHealthCheckAt: null,
    health: false,
    memoryBytes: childProcess.memoryBytes || 0,
    portOwnerPid: null,
  };
  try {
    await writeRecord(directory, record);
  } catch (error) {
    await stop('registration failure');
    throw error;
  }
  if (stopPromise) {
    await stopPromise;
    await removeRecord(directory, id);
    return;
  }
  process.stdout.write(
    `[dev-server] Registered ${id} (PID ${child.pid}, port ${options.port}, ` +
      `${options.persistence.mode}, expires ${options.persistence.expiresAt}).\n`,
  );

  let scanPromise = null;
  const interval = setInterval(() => {
    if (scanPromise) return;
    scanPromise = scanRegistry({ directory, recordIds: [id] })
      .catch((error) => {
        process.stderr.write(
          `[dev-server] Orphan scan failed: ${error.message}\n`,
        );
      })
      .finally(() => {
        scanPromise = null;
      });
  }, 30_000);
  interval.unref();

  const exitCode = await childExit;
  clearInterval(interval);
  await scanPromise;
  await removeRecord(directory, id);
  process.exitCode = exitCode;
}

async function list() {
  const directory = registryDirectory();
  await scanRegistry({ directory, cleanup: false });
  const snapshot = await processSnapshot();
  const records = await readRecords(directory);
  if (records.length === 0) {
    process.stdout.write('No registered development servers.\n');
    return;
  }
  const rows = records.map((record) => {
    const summary = summarizeRecord(record, snapshot);
    return {
      id: record.id,
      port: record.port,
      mode: record.persistence.mode,
      owner: record.persistence.owner || record.session.id || 'local terminal',
      purpose: record.persistence.purpose || 'session development',
      expiresAt: record.persistence.expiresAt,
      uptimeMinutes: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(record.startedAt)) / 60_000),
      ),
      memoryMiB: (summary.memoryBytes / 1024 / 1024).toFixed(1),
      health: record.health ? 'ready' : 'starting/unavailable',
      orphan: record.orphanReason || '',
      worktree: record.session.worktree,
    };
  });
  console.table(rows);
}

async function stop(id) {
  if (!id) throw new Error('stop requires a registry id.');
  const directory = registryDirectory();
  const record = (await readRecords(directory)).find((entry) => entry.id === id);
  if (!record) throw new Error(`No registered server matches ${id}.`);
  const snapshot = await processSnapshot();
  const killed = await stopRegisteredProcess(record, snapshot);
  await removeRecord(directory, id);
  process.stdout.write(
    `[dev-server] Stopped ${id}; exact PIDs: ${killed.join(', ') || 'none'}.\n`,
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'run') await run(args);
  else if (command === 'list') await list();
  else if (command === 'scan') await scanRegistry();
  else if (command === 'stop') await stop(args[0]);
  else usage(command ? `Unknown command: ${command}` : undefined);
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
