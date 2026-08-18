import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageSyncWorkerRuntime } from './package-sync-worker-runtime.mjs';
import { removeTemporaryRuntime } from './remove-temporary-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'mc-worker-runtime-'));
const databasePath = path.join(runtimeRoot, 'data', 'mission-control.db');
const instancePath = path.join(runtimeRoot, 'data', 'worker-instance');
const packagedRuntime = process.env.MC_WORKER_RUNTIME_SOURCE
  ? path.resolve(process.env.MC_WORKER_RUNTIME_SOURCE)
  : null;
let worker;

async function waitFor(description, assertion, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

try {
  await Promise.all([
    cp(path.join(root, 'dist'), path.join(runtimeRoot, 'dist'), { recursive: true }),
    cp(path.join(root, 'drizzle'), path.join(runtimeRoot, 'drizzle'), { recursive: true }),
    packagedRuntime
      ? cp(packagedRuntime, runtimeRoot, { recursive: true, dereference: true })
      : packageSyncWorkerRuntime(runtimeRoot),
  ]);

  const prettySmokePath = path.join(runtimeRoot, 'pino-pretty-smoke.cjs');
  await writeFile(
    prettySmokePath,
    "const pino = require('pino'); const transport = pino.transport({ target: 'pino-pretty' }); transport.end();",
  );
  const prettyTransport = spawnSync(process.execPath, [prettySmokePath], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (prettyTransport.status !== 0) {
    throw new Error(prettyTransport.stderr || 'pino-pretty transport did not initialize');
  }

  const connectorSmokePath = path.join(runtimeRoot, 'connector-dependencies-smoke.cjs');
  await writeFile(
    connectorSmokePath,
    `
      const RE2 = require('re2');
      const createMetascraper = require('metascraper');
      const rules = [
        require('metascraper-author')(),
        require('metascraper-description')(),
        require('metascraper-iframe')(),
        require('metascraper-image')(),
        require('metascraper-logo')(),
        require('metascraper-publisher')(),
        require('metascraper-title')(),
        require('metascraper-url')(),
        require('metascraper-video')(),
      ];
      if (!new RE2('worker').test('worker runtime')) process.exit(1);
      createMetascraper(rules)({
        html: '<html><head><title>Worker runtime</title></head></html>',
        url: 'https://example.com/',
      }).then(
        (metadata) => process.exit(metadata.title === 'Worker runtime' ? 0 : 1),
        (error) => { console.error(error); process.exit(1); },
      );
    `,
  );
  const connectorDependencies = spawnSync(process.execPath, [connectorSmokePath], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (connectorDependencies.status !== 0) {
    throw new Error(
      connectorDependencies.stderr || 'Connector runtime dependencies did not initialize',
    );
  }

  const identityOperator = spawnSync(
    process.execPath,
    ['--conditions=react-server', 'dist/github-identity-operator.cjs', '--help'],
    {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MC_DB_PATH: databasePath,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (
    identityOperator.status !== 0
    || !identityOperator.stdout.includes('status')
    || !identityOperator.stdout.includes('write-cycle-reconcile')
    || identityOperator.stdout.includes('stable-enable')
    || identityOperator.stdout.includes('stable-rollback')
  ) {
    throw new Error(
      identityOperator.stderr || 'GitHub identity operator was not invocable in staged runtime',
    );
  }

  const databaseInitialization = spawnSync(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      '-e',
      // Read via both the named and default export bindings: under Node 22,
      // tsx's CommonJS-transpiled output for this module isn't fully
      // recognized by Node's CJS/ESM named-export interop (cjs-module-lexer),
      // so the named export can land nested under `default` instead of at
      // the top level. Node 24 exposes it directly. Support both.
      "import('./src/db/index.ts').then((m) => {"
        + " const initializeDatabase = m.initializeDatabase ?? m.default?.initializeDatabase;"
        + " if (typeof initializeDatabase !== 'function') {"
        + "   throw new Error('initializeDatabase export not found on ./src/db/index.ts');"
        + " }"
        + " return initializeDatabase();"
        + "})",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MC_DB_PATH: databasePath,
        MC_PROCESS_ROLE: 'web',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (databaseInitialization.status !== 0) {
    throw new Error(
      databaseInitialization.stderr || 'Web-role database initialization failed',
    );
  }

  const output = [];
  const launch = [
    '-e',
    "process.on('message', (message) => { if (message === 'shutdown') process.emit('SIGTERM', 'SIGTERM'); }); require('./dist/sync-worker.cjs');",
  ];
  worker = spawn(process.execPath, launch, {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MC_DB_PATH: databasePath,
      MC_WORKER_INSTANCE_FILE: instancePath,
      MC_TELEMETRY_INTERVAL_MS: '100',
      MC_DEPLOYMENT_REVISION: 'smoke-worker',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  worker.stdout.on('data', (chunk) => output.push(chunk));
  worker.stderr.on('data', (chunk) => output.push(chunk));

  const instanceId = await waitFor('worker instance identity', async () => {
    await stat(instancePath);
    const value = (await readFile(instancePath, 'utf8')).trim();
    if (!value) throw new Error('Worker instance identity is empty');
    return value;
  });

  await waitFor('matching SQLite telemetry heartbeat', () => {
    const query = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { readonly: true });
      const row = db.prepare(
        "SELECT instance_id, heartbeat_at FROM runtime_telemetry WHERE role = 'worker'"
      ).get();
      const indexes = new Set(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)"
        ).all(
          'idx_finance_attribution_attention_scan',
          'idx_finance_mutation_attention_scan',
        ).map(({ name }) => name)
      );
      db.close();
      if (
        !row
        || row.instance_id !== process.argv[2]
        || !row.heartbeat_at
        || indexes.size !== 2
      ) process.exit(1);
    `;
    const result = spawnSync(process.execPath, ['-e', query, databasePath, instanceId], {
      cwd: runtimeRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'Telemetry row is not initialized');
    }
  });

  await waitFor('completed worker startup', () => {
    const logs = Buffer.concat(output).toString();
    if (!logs.includes('"runtimeRelease":"smoke-worker"')) {
      throw new Error('Worker startup did not report its runtime release');
    }
    if (!logs.includes('Sync worker: triage auto-sync scheduler initialized')) {
      throw new Error('Worker startup has not completed');
    }
  });

  worker.send('shutdown');
  const exit = await waitForExit(worker, 30_000);
  if (exit.code !== 0) {
    throw new Error(
      `Worker exited with code ${exit.code} and signal ${exit.signal}\n${Buffer.concat(output).toString()}`,
    );
  }
  try {
    await stat(instancePath);
    throw new Error('Worker instance file remained after graceful shutdown');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Expected: graceful shutdown removes the liveness identity.
    } else {
      throw error;
    }
  }

  console.log('Staged sync-worker runtime started, persisted telemetry, and stopped cleanly');
} finally {
  try {
    if (worker && !hasExited(worker)) {
      worker.kill('SIGKILL');
      await waitForExit(worker, 5_000);
    }
  } finally {
    await removeTemporaryRuntime(runtimeRoot);
  }
}
