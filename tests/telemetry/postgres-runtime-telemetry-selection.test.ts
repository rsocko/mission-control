import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves that runtime telemetry (`RuntimeTelemetryMonitor` persistence,
 * `startRuntimeTelemetry`/`stopRuntimeTelemetry`, and the
 * `getRuntimeTelemetry*` readers) actually switches to the PostgreSQL
 * adapter under `MC_DATABASE_BACKEND=postgres` — and never touches the
 * SQLite compatibility layer while doing so. `@/db`'s `sqlite`/`db` exports
 * are mocked to throw on any access, so any code path that still reached
 * into SQLite would fail this test immediately instead of silently working
 * "by accident".
 */

const sqliteTouch = vi.fn();

vi.mock('@/db', () => ({
  get sqlite() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  get db() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  getDatabaseTelemetry: () => {
    sqliteTouch();
    throw new Error('SQLite diagnostics must not run while PostgreSQL is selected');
  },
  withoutDatabaseObservation: <T>(callback: () => T) => callback(),
}));

const postgresMocks = vi.hoisted(() => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  registerPostgresRuntimeInstance: vi.fn(async () => undefined),
  persistPostgresRuntimeTelemetry: vi.fn(async () => undefined),
  recordPostgresRuntimeTelemetryStop: vi.fn(async () => undefined),
  maintainPostgresRuntimeTelemetryHistory: vi.fn(async () => undefined),
  getPostgresRuntimeTelemetry: vi.fn(async () => ([
    {
      role: 'worker' as const,
      instanceId: 'pg-instance-1',
      pid: 123,
      startedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:10.000Z',
      metrics: {},
    },
  ])),
  getPostgresRuntimeTelemetryHistory: vi.fn(async () => []),
  getPostgresRuntimeTelemetryAlertHistory: vi.fn(async () => []),
  getPostgresRuntimeTelemetryInstances: vi.fn(async () => []),
}));

vi.mock('@/db/runtime', () => ({
  getPostgresPersistenceBackend: () => ({ context: { pool: postgresMocks.pool } }),
}));

vi.mock('@/db/postgres/telemetry-runtime', () => ({
  registerPostgresRuntimeInstance: postgresMocks.registerPostgresRuntimeInstance,
  persistPostgresRuntimeTelemetry: postgresMocks.persistPostgresRuntimeTelemetry,
  recordPostgresRuntimeTelemetryStop: postgresMocks.recordPostgresRuntimeTelemetryStop,
  maintainPostgresRuntimeTelemetryHistory: postgresMocks.maintainPostgresRuntimeTelemetryHistory,
  getPostgresRuntimeTelemetry: postgresMocks.getPostgresRuntimeTelemetry,
  getPostgresRuntimeTelemetryHistory: postgresMocks.getPostgresRuntimeTelemetryHistory,
  getPostgresRuntimeTelemetryAlertHistory: postgresMocks.getPostgresRuntimeTelemetryAlertHistory,
  getPostgresRuntimeTelemetryInstances: postgresMocks.getPostgresRuntimeTelemetryInstances,
}));

const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MC_DATABASE_BACKEND = 'postgres';
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
});

describe('PostgreSQL backend selection — runtime telemetry monitor lifecycle', () => {
  it('start() registers the instance, persists the initial sample, and awaits both before returning', async () => {
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');

    await monitor.start();

    expect(postgresMocks.registerPostgresRuntimeInstance).toHaveBeenCalledOnce();
    expect(postgresMocks.registerPostgresRuntimeInstance).toHaveBeenCalledWith(
      postgresMocks.pool,
      expect.objectContaining({ instanceId: monitor.instanceId, role: 'worker' }),
    );
    expect(postgresMocks.maintainPostgresRuntimeTelemetryHistory).toHaveBeenCalledWith(postgresMocks.pool);
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledWith(
      postgresMocks.pool,
      expect.objectContaining({ instanceId: monitor.instanceId, role: 'worker' }),
    );
    expect(sqliteTouch).not.toHaveBeenCalled();

    await monitor.stop();
  });

  it('stop() persists a final sample and records the terminal reason via the PostgreSQL adapter', async () => {
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('web');
    await monitor.start();
    postgresMocks.persistPostgresRuntimeTelemetry.mockClear();

    await monitor.stop('SIGTERM');

    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();
    expect(postgresMocks.recordPostgresRuntimeTelemetryStop).toHaveBeenCalledOnce();
    expect(postgresMocks.recordPostgresRuntimeTelemetryStop).toHaveBeenCalledWith(
      postgresMocks.pool,
      expect.objectContaining({ instanceId: monitor.instanceId, reason: 'SIGTERM' }),
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('startRuntimeTelemetry/stopRuntimeTelemetry await the full async lifecycle', async () => {
    const { startRuntimeTelemetry, stopRuntimeTelemetry } = await import('@/lib/telemetry/runtime');

    const monitor = await startRuntimeTelemetry('worker');
    expect(postgresMocks.registerPostgresRuntimeInstance).toHaveBeenCalledOnce();
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();

    await stopRuntimeTelemetry('test_shutdown');
    expect(postgresMocks.recordPostgresRuntimeTelemetryStop).toHaveBeenCalledWith(
      postgresMocks.pool,
      expect.objectContaining({ instanceId: monitor.instanceId, reason: 'test_shutdown' }),
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('shares one in-flight monitor startup across concurrent callers', async () => {
    const { startRuntimeTelemetry, stopRuntimeTelemetry } = await import('@/lib/telemetry/runtime');

    const [first, second] = await Promise.all([
      startRuntimeTelemetry('worker'),
      startRuntimeTelemetry('worker'),
    ]);

    expect(second).toBe(first);
    expect(postgresMocks.registerPostgresRuntimeInstance).toHaveBeenCalledOnce();
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();

    await stopRuntimeTelemetry('test_shutdown');
  });

  it('serializes sample persistence so slow writes cannot finish out of order', async () => {
    let releaseFirst: (() => void) | undefined;
    postgresMocks.persistPostgresRuntimeTelemetry.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const { RuntimeTelemetryMonitor } = await import('@/lib/telemetry/runtime');
    const monitor = new RuntimeTelemetryMonitor('worker');

    const first = monitor.sampleAndPersist();
    await vi.waitFor(() => {
      expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();
    });
    const second = monitor.sampleAndPersist();
    await Promise.resolve();
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledOnce();

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(postgresMocks.persistPostgresRuntimeTelemetry).toHaveBeenCalledTimes(2);
  });
});

describe('PostgreSQL backend selection — runtime telemetry readers', () => {
  it('getRuntimeTelemetry delegates to the PostgreSQL adapter', async () => {
    const { getRuntimeTelemetry } = await import('@/lib/telemetry/runtime');
    const result = await getRuntimeTelemetry();
    expect(postgresMocks.getPostgresRuntimeTelemetry).toHaveBeenCalledWith(postgresMocks.pool);
    expect(result).toHaveLength(1);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('getRuntimeTelemetryHistory (hours overload) delegates to the PostgreSQL adapter', async () => {
    const { getRuntimeTelemetryHistory } = await import('@/lib/telemetry/runtime');
    await getRuntimeTelemetryHistory(24, 'web');
    expect(postgresMocks.getPostgresRuntimeTelemetryHistory).toHaveBeenCalledWith(
      postgresMocks.pool,
      expect.objectContaining({ role: 'web', limit: 10_000 }),
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('getRuntimeTelemetryHistory (options overload) delegates to the PostgreSQL adapter', async () => {
    const { getRuntimeTelemetryHistory } = await import('@/lib/telemetry/runtime');
    await getRuntimeTelemetryHistory({ role: 'worker', since: '2026-01-01T00:00:00.000Z', limit: 50 });
    expect(postgresMocks.getPostgresRuntimeTelemetryHistory).toHaveBeenCalledWith(
      postgresMocks.pool,
      { role: 'worker', since: '2026-01-01T00:00:00.000Z', limit: 50 },
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('getRuntimeTelemetryAlertHistory delegates to the PostgreSQL adapter', async () => {
    const { getRuntimeTelemetryAlertHistory } = await import('@/lib/telemetry/runtime');
    await getRuntimeTelemetryAlertHistory(2);
    expect(postgresMocks.getPostgresRuntimeTelemetryAlertHistory).toHaveBeenCalledWith(postgresMocks.pool, 2);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('getRuntimeTelemetryInstances delegates to the PostgreSQL adapter', async () => {
    const { getRuntimeTelemetryInstances } = await import('@/lib/telemetry/runtime');
    await getRuntimeTelemetryInstances(48);
    expect(postgresMocks.getPostgresRuntimeTelemetryInstances).toHaveBeenCalledWith(postgresMocks.pool, 48);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
