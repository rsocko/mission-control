import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg, { type Pool } from 'pg';
import { resolveDatabaseBackend, type DatabaseBackend } from '@/db/runtime-backend';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { getPostgresRuntimeTelemetry } from '@/db/postgres/telemetry-runtime';

const DEFAULT_DURATION_BUDGET_MS = 300_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

interface HealthcheckEnvironment {
  [key: string]: string | undefined;
}

interface SQLiteDatabase {
  prepare(sql: string): {
    get(instanceId: string): { heartbeatAt?: string } | undefined;
  };
  close(): void;
}

export interface WorkerHealthcheckDependencies {
  now?: () => number;
  readInstanceFile?: (path: string) => Promise<string>;
  openSQLite?: (path: string) => Promise<SQLiteDatabase>;
  createPostgresPool?: (config: pg.PoolConfig) => Pool;
  readPostgresTelemetry?: typeof getPostgresRuntimeTelemetry;
}

export interface WorkerHealthcheckConfiguration {
  backend: DatabaseBackend;
  instanceFile: string;
  staleMs: number;
  queryTimeoutMs: number;
}

export class WorkerHealthcheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerHealthcheckError';
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkerHealthcheckError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveWorkerHealthcheckConfiguration(
  env: HealthcheckEnvironment = process.env,
): WorkerHealthcheckConfiguration {
  let backend: DatabaseBackend;
  try {
    backend = resolveDatabaseBackend(env.MC_DATABASE_BACKEND);
  } catch {
    throw new WorkerHealthcheckError('MC_DATABASE_BACKEND must be sqlite or postgres');
  }
  const durationBudgetMs = positiveInteger(
    env.MC_SYNC_DURATION_BUDGET_MS,
    DEFAULT_DURATION_BUDGET_MS,
    'MC_SYNC_DURATION_BUDGET_MS',
  );
  const leaseMs = positiveInteger(
    env.MC_SYNC_JOB_LEASE_MS,
    DEFAULT_LEASE_MS,
    'MC_SYNC_JOB_LEASE_MS',
  );
  return {
    backend,
    instanceFile: env.MC_WORKER_INSTANCE_FILE
      ?? join(tmpdir(), 'mission-control-worker-instance'),
    staleMs: positiveInteger(
      env.MC_WORKER_HEALTH_STALE_MS,
      Math.max(durationBudgetMs + 60_000, leaseMs * 2),
      'MC_WORKER_HEALTH_STALE_MS',
    ),
    queryTimeoutMs: positiveInteger(
      env.MC_WORKER_HEALTH_QUERY_TIMEOUT_MS,
      DEFAULT_QUERY_TIMEOUT_MS,
      'MC_WORKER_HEALTH_QUERY_TIMEOUT_MS',
    ),
  };
}

async function defaultOpenSQLite(path: string): Promise<SQLiteDatabase> {
  const { default: Database } = await import('better-sqlite3');
  return new Database(path, { readonly: true, fileMustExist: true });
}

function validateHeartbeat(
  heartbeatAt: string | undefined,
  staleMs: number,
  now: number,
): void {
  if (!heartbeatAt) {
    throw new WorkerHealthcheckError(
      'telemetry heartbeat for the current worker instance is missing',
    );
  }
  const ageMs = now - new Date(heartbeatAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > staleMs) {
    throw new WorkerHealthcheckError('worker telemetry heartbeat is stale or invalid');
  }
}

async function readSQLiteHeartbeat(
  databasePath: string,
  instanceId: string,
  dependencies: WorkerHealthcheckDependencies,
): Promise<string | undefined> {
  let database: SQLiteDatabase;
  try {
    database = await (dependencies.openSQLite ?? defaultOpenSQLite)(databasePath);
  } catch {
    throw new WorkerHealthcheckError('SQLite worker telemetry database could not be opened');
  }
  try {
    return database.prepare(`
      SELECT heartbeat_at AS heartbeatAt
      FROM runtime_telemetry
      WHERE role = 'worker' AND instance_id = ?
    `).get(instanceId)?.heartbeatAt;
  } catch {
    throw new WorkerHealthcheckError('SQLite worker telemetry query failed');
  } finally {
    database.close();
  }
}

async function readPostgresHeartbeat(
  env: HealthcheckEnvironment,
  instanceId: string,
  queryTimeoutMs: number,
  dependencies: WorkerHealthcheckDependencies,
): Promise<string | undefined> {
  let resolved;
  try {
    resolved = resolvePostgresConfig(env);
  } catch (error) {
    throw new WorkerHealthcheckError(
      error instanceof Error ? error.message : 'PostgreSQL configuration is invalid',
    );
  }
  const poolConfig: pg.PoolConfig = {
    ...resolved.pool,
    min: 0,
    max: 1,
    connectionTimeoutMillis: Math.min(
      resolved.pool.connectionTimeoutMillis ?? queryTimeoutMs,
      queryTimeoutMs,
    ),
    statement_timeout: Math.min(
      typeof resolved.pool.statement_timeout === 'number'
        ? resolved.pool.statement_timeout
        : queryTimeoutMs,
      queryTimeoutMs,
    ),
    query_timeout: queryTimeoutMs,
    allowExitOnIdle: true,
  };
  const createPool = dependencies.createPostgresPool ?? ((config) => new pg.Pool(config));
  let pool: Pool;
  try {
    pool = createPool(poolConfig);
  } catch {
    throw new WorkerHealthcheckError('PostgreSQL worker telemetry connection failed');
  }
  let poolFailed = false;
  pool.on('error', () => {
    poolFailed = true;
  });
  try {
    const query = (dependencies.readPostgresTelemetry ?? getPostgresRuntimeTelemetry)(pool);
    const records = await new Promise<Awaited<typeof query>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new WorkerHealthcheckError('PostgreSQL worker telemetry query timed out')),
        queryTimeoutMs,
      );
      void query.then(resolve, reject).finally(() => clearTimeout(timer));
    });
    return records.find(
      (record) => record.role === 'worker' && record.instanceId === instanceId,
    )?.heartbeatAt;
  } catch (error) {
    if (
      error instanceof WorkerHealthcheckError
      && error.message === 'PostgreSQL worker telemetry query timed out'
    ) {
      throw error;
    }
    throw new WorkerHealthcheckError('PostgreSQL worker telemetry query failed');
  } finally {
    try {
      await pool.end();
    } catch {
      throw new WorkerHealthcheckError('PostgreSQL worker telemetry cleanup failed');
    }
    if (poolFailed) {
      throw new WorkerHealthcheckError('PostgreSQL worker telemetry connection failed');
    }
  }
}

export async function runWorkerHealthcheck(
  env: HealthcheckEnvironment = process.env,
  dependencies: WorkerHealthcheckDependencies = {},
): Promise<void> {
  const config = resolveWorkerHealthcheckConfiguration(env);
  let instanceId: string;
  try {
    const readMarker = dependencies.readInstanceFile
      ?? ((path: string) => readFile(path, 'utf8'));
    instanceId = (await readMarker(config.instanceFile)).trim();
  } catch {
    throw new WorkerHealthcheckError('current worker instance marker could not be read');
  }
  if (!instanceId) {
    throw new WorkerHealthcheckError('current worker instance marker is empty');
  }

  const heartbeatAt = config.backend === 'postgres'
    ? await readPostgresHeartbeat(
        env,
        instanceId,
        config.queryTimeoutMs,
        dependencies,
      )
    : await readSQLiteHeartbeat(
        env.MC_DB_PATH ?? '/app/data/mission-control.db',
        instanceId,
        dependencies,
      );
  validateHeartbeat(
    heartbeatAt,
    config.staleMs,
    (dependencies.now ?? Date.now)(),
  );
}
