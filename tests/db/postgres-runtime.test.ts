import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runPostgresMigrations } from '@/db/postgres/migrations';
import {
  PostgresPersistenceBackend,
  type PostgresRuntimeOptions,
} from '@/db/postgres/runtime';

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: vi.fn(),
}));

vi.mock('@/db/postgres/migrations', () => ({
  runPostgresMigrations: vi.fn(),
}));

const config: NonNullable<PostgresRuntimeOptions['config']> = {
  sslMode: 'disable',
  pool: {
    connectionString: 'postgres://mission-control:secret@db/mc',
    ssl: false,
  },
};

function fakePool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PostgreSQL persistence runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runPostgresMigrations).mockResolvedValue(undefined);
  });

  it('initializes once for concurrent callers and shuts down once', async () => {
    const pool = fakePool();
    const transaction = vi.fn();
    vi.mocked(drizzle).mockReturnValue({ transaction } as never);
    const createPool = vi.fn(() => pool as never);
    const backend = new PostgresPersistenceBackend({ config, createPool });

    await Promise.all([backend.initialize(), backend.initialize()]);

    expect(createPool).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(runPostgresMigrations).toHaveBeenCalledOnce();
    expect(backend.context.pool).toBe(pool);

    await backend.shutdown();
    await backend.shutdown();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(() => backend.context).toThrow(
      'PostgreSQL persistence has not been initialized',
    );
  });

  it('cleans up failed initialization and permits a retry', async () => {
    const first = fakePool();
    const failure = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    first.query.mockRejectedValueOnce(failure);
    const second = fakePool();
    vi.mocked(drizzle).mockReturnValue({ transaction: vi.fn() } as never);
    const createPool = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const backend = new PostgresPersistenceBackend({
      config,
      createPool: createPool as never,
    });

    await expect(backend.initialize()).rejects.toBe(failure);
    expect(first.end).toHaveBeenCalledOnce();

    await backend.initialize();
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(backend.context.pool).toBe(second);
  });

  it('allows shutdown to complete when in-flight initialization fails', async () => {
    const pool = fakePool();
    pool.query.mockRejectedValueOnce(new Error('database unavailable'));
    const backend = new PostgresPersistenceBackend({
      config,
      createPool: () => pool as never,
    });

    const initialization = backend.initialize();
    await expect(backend.shutdown()).resolves.toBeUndefined();
    await expect(initialization).rejects.toThrow('database unavailable');
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('defers initialization until an in-flight shutdown closes the old pool', async () => {
    let finishShutdown: (() => void) | undefined;
    const first = fakePool();
    first.end.mockImplementation(() => new Promise<void>((resolve) => {
      finishShutdown = resolve;
    }));
    const second = fakePool();
    vi.mocked(drizzle).mockReturnValue({ transaction: vi.fn() } as never);
    const createPool = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const backend = new PostgresPersistenceBackend({
      config,
      initializeSchema: false,
      createPool: createPool as never,
    });
    await backend.initialize();

    const shutdown = backend.shutdown();
    const reinitialize = backend.initialize();
    await Promise.resolve();
    expect(createPool).toHaveBeenCalledOnce();

    finishShutdown?.();
    await shutdown;
    await reinitialize;
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(backend.context.pool).toBe(second);
  });

  it('maps shared transaction access modes to PostgreSQL transactions', async () => {
    const pool = fakePool();
    const transaction = vi.fn(
      async (work: (context: { marker: string }) => Promise<string>, options) =>
        work({ marker: options.accessMode }),
    );
    vi.mocked(drizzle).mockReturnValue({ transaction } as never);
    const backend = new PostgresPersistenceBackend({
      config,
      initializeSchema: false,
      createPool: () => pool as never,
    });
    await backend.initialize();

    await expect(backend.transactions.run(
      async (context) => (context as unknown as { marker: string }).marker,
      { access: 'read' },
    )).resolves.toBe('read only');
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { accessMode: 'read only' },
    );
  });
});
