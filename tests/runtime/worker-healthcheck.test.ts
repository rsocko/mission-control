import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolConfig } from 'pg';
import {
  resolveWorkerHealthcheckConfiguration,
  runWorkerHealthcheck,
} from '@/lib/runtime/worker-healthcheck';
import type { RuntimeTelemetryRecord } from '@/lib/telemetry/runtime';

const NOW = Date.parse('2026-09-02T15:00:00.000Z');
const FRESH = '2026-09-02T14:59:59.000Z';

function postgresEnvironment(overrides: Record<string, string> = {}) {
  return {
    MC_DATABASE_BACKEND: 'postgres',
    MC_POSTGRES_URL: 'postgres://worker:super-secret@postgres/mission_control',
    MC_POSTGRES_SSL_MODE: 'disable',
    MC_WORKER_HEALTH_QUERY_TIMEOUT_MS: '50',
    ...overrides,
  };
}

function record(overrides: Partial<RuntimeTelemetryRecord> = {}): RuntimeTelemetryRecord {
  return {
    role: 'worker',
    instanceId: 'worker-1',
    pid: 10,
    startedAt: '2026-09-02T14:00:00.000Z',
    heartbeatAt: FRESH,
    metrics: {} as RuntimeTelemetryRecord['metrics'],
    ...overrides,
  };
}

function pool(end = vi.fn().mockResolvedValue(undefined)): Pool {
  return { end, on: vi.fn() } as unknown as Pool;
}

describe('worker healthcheck', () => {
  it('preserves SQLite heartbeat checks and closes the database', async () => {
    const close = vi.fn();
    const get = vi.fn(() => ({ heartbeatAt: FRESH }));
    const openSQLite = vi.fn(async () => ({
      prepare: vi.fn(() => ({ get })),
      close,
    }));

    await runWorkerHealthcheck(
      {
        MC_DATABASE_BACKEND: 'sqlite',
        MC_DB_PATH: 'worker.db',
        MC_WORKER_INSTANCE_FILE: 'instance',
      },
      {
        now: () => NOW,
        readInstanceFile: vi.fn(async () => 'worker-1\n'),
        openSQLite,
      },
    );

    expect(openSQLite).toHaveBeenCalledWith('worker.db');
    expect(get).toHaveBeenCalledWith('worker-1');
    expect(close).toHaveBeenCalledOnce();
  });

  it('never touches SQLite or MC_DB_PATH under PostgreSQL', async () => {
    const openSQLite = vi.fn(() => {
      throw new Error('poisoned SQLite path was opened');
    });
    const end = vi.fn().mockResolvedValue(undefined);

    await runWorkerHealthcheck(
      postgresEnvironment({ MC_DB_PATH: 'missing-and-poisoned.db' }),
      {
        now: () => NOW,
        readInstanceFile: vi.fn(async () => 'worker-1'),
        openSQLite,
        createPostgresPool: vi.fn(() => pool(end)),
        readPostgresTelemetry: vi.fn(async () => [record()]),
      },
    );

    expect(openSQLite).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', []],
    ['stale', [record({ heartbeatAt: '2026-09-02T14:00:00.000Z' })]],
    ['invalid', [record({ heartbeatAt: 'not-a-date' })]],
  ])('fails closed for %s PostgreSQL telemetry', async (_name, records) => {
    await expect(runWorkerHealthcheck(
      postgresEnvironment(),
      {
        now: () => NOW,
        readInstanceFile: vi.fn(async () => 'worker-1'),
        createPostgresPool: vi.fn(() => pool()),
        readPostgresTelemetry: vi.fn(async () => records),
      },
    )).rejects.toThrow(/missing|stale or invalid/);
  });

  it('fails closed for missing and stale SQLite telemetry while still closing', async () => {
    const close = vi.fn();
    await expect(runWorkerHealthcheck(
      { MC_DATABASE_BACKEND: 'sqlite' },
      {
        now: () => NOW,
        readInstanceFile: vi.fn(async () => 'worker-1'),
        openSQLite: vi.fn(async () => ({
          prepare: () => ({
            get: () => ({ heartbeatAt: '2026-09-02T14:00:00.000Z' }),
          }),
          close,
        })),
      },
    )).rejects.toThrow('stale or invalid');
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds PostgreSQL connection and query timeouts with healthcheck policy', async () => {
    let config: PoolConfig | undefined;
    const end = vi.fn().mockResolvedValue(undefined);
    const never = new Promise<RuntimeTelemetryRecord[]>(() => {});

    await expect(runWorkerHealthcheck(
      postgresEnvironment({
        MC_POSTGRES_CONNECTION_TIMEOUT_MS: '5000',
        MC_POSTGRES_STATEMENT_TIMEOUT_MS: '6000',
        MC_WORKER_HEALTH_QUERY_TIMEOUT_MS: '5',
      }),
      {
        readInstanceFile: vi.fn(async () => 'worker-1'),
        createPostgresPool: vi.fn((value) => {
          config = value;
          return pool(end);
        }),
        readPostgresTelemetry: vi.fn(() => never),
      },
    )).rejects.toThrow('query timed out');

    expect(config).toMatchObject({
      min: 0,
      max: 1,
      connectionTimeoutMillis: 5,
      statement_timeout: 5,
      query_timeout: 5,
      allowExitOnIdle: true,
    });
    expect(end).toHaveBeenCalledOnce();
  });

  it('redacts PostgreSQL connection and query failures', async () => {
    const env = postgresEnvironment();
    const secret = 'super-secret';
    let connectionError: unknown;
    try {
      await runWorkerHealthcheck(env, {
        readInstanceFile: vi.fn(async () => 'worker-1'),
        createPostgresPool: vi.fn(() => {
          throw new Error(`could not connect with ${secret}`);
        }),
      });
    } catch (error) {
      connectionError = error;
    }
    expect(String(connectionError)).toBe(
      'WorkerHealthcheckError: PostgreSQL worker telemetry connection failed',
    );
    expect(String(connectionError)).not.toContain(secret);

    await expect(runWorkerHealthcheck(env, {
      readInstanceFile: vi.fn(async () => 'worker-1'),
      createPostgresPool: vi.fn(() => pool()),
      readPostgresTelemetry: vi.fn(async () => {
        throw new Error(`query exposed ${secret}`);
      }),
    })).rejects.toThrow('PostgreSQL worker telemetry query failed');
  });

  it('handles asynchronous PostgreSQL pool failures without exposing details', async () => {
    const fakePool = pool();
    vi.mocked(fakePool.on).mockImplementation((event, listener) => {
      if (event === 'error') {
        queueMicrotask(() => listener(new Error('async failure with super-secret')));
      }
      return fakePool;
    });

    await expect(runWorkerHealthcheck(postgresEnvironment(), {
      readInstanceFile: vi.fn(async () => 'worker-1'),
      createPostgresPool: vi.fn(() => fakePool),
      readPostgresTelemetry: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return [record()];
      }),
    })).rejects.toThrow('PostgreSQL worker telemetry connection failed');
  });

  it('uses shared backend and PostgreSQL config precedence', async () => {
    const configured = resolveWorkerHealthcheckConfiguration({
      MC_DATABASE_BACKEND: '',
      MC_SYNC_DURATION_BUDGET_MS: '1000',
      MC_SYNC_JOB_LEASE_MS: '4000',
    });
    expect(configured).toMatchObject({ backend: 'sqlite', staleMs: 61_000 });

    let poolConfig: PoolConfig | undefined;
    await runWorkerHealthcheck(
      postgresEnvironment({
        MC_POSTGRES_URL:
          'postgres://worker:secret@postgres/mission_control?sslmode=require',
        MC_POSTGRES_SSL_MODE: 'disable',
      }),
      {
        now: () => NOW,
        readInstanceFile: vi.fn(async () => 'worker-1'),
        createPostgresPool: vi.fn((value) => {
          poolConfig = value;
          return pool();
        }),
        readPostgresTelemetry: vi.fn(async () => [record()]),
      },
    );
    expect(poolConfig?.ssl).toBe(false);
    expect(() => resolveWorkerHealthcheckConfiguration({
      MC_DATABASE_BACKEND: 'mysql',
    })).toThrow('MC_DATABASE_BACKEND must be sqlite or postgres');
  });
});
