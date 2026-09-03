import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@/db/runtime-backend');
  vi.doUnmock('@/lib/ai/durable-runs/sqlite-adapter');
  vi.resetModules();
});

describe('durable AI run persistence runtime', () => {
  it('lazily selects and memoizes the SQLite adapter', async () => {
    const repository = { marker: 'sqlite' };
    const adapterModule = vi.fn(() => ({
      SqliteDurableAiRunRepository: class {
        constructor() {
          return repository;
        }
      },
    }));
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'sqlite',
    }));
    vi.doMock('@/lib/ai/durable-runs/sqlite-adapter', adapterModule);
    const { getDurableAiRunRepository } = await import(
      '@/lib/ai/durable-runs/runtime'
    );

    expect(adapterModule).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      getDurableAiRunRepository(),
      getDurableAiRunRepository(),
    ]);

    expect(first).toBe(repository);
    expect(second).toBe(repository);
    expect(adapterModule).toHaveBeenCalledOnce();
  });

  it('fails closed on PostgreSQL without evaluating poisoned SQLite', async () => {
    const adapterModule = vi.fn(() => {
      throw new Error('SQLite adapter must not be evaluated');
    });
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'postgres',
    }));
    vi.doMock('@/lib/ai/durable-runs/sqlite-adapter', adapterModule);
    const { getDurableAiRunRepository } = await import(
      '@/lib/ai/durable-runs/runtime'
    );

    await expect(getDurableAiRunRepository()).rejects.toThrow(
      'PostgreSQL durable AI run repository has not been registered',
    );
    expect(adapterModule).not.toHaveBeenCalled();
  });

  it('returns the registered PostgreSQL repository without evaluating SQLite', async () => {
    const repository = { marker: 'postgres' };
    const adapterModule = vi.fn(() => {
      throw new Error('SQLite adapter must not be evaluated');
    });
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'postgres',
    }));
    vi.doMock('@/lib/ai/durable-runs/sqlite-adapter', adapterModule);
    const {
      getDurableAiRunRepository,
      registerPostgresDurableAiRunRepository,
    } = await import('@/lib/ai/durable-runs/runtime');

    registerPostgresDurableAiRunRepository(repository as never);

    await expect(getDurableAiRunRepository()).resolves.toBe(repository);
    expect(adapterModule).not.toHaveBeenCalled();
  });

  it('keeps API routes fail-closed on PostgreSQL without touching SQLite', async () => {
    const adapterModule = vi.fn(() => {
      throw new Error('SQLite adapter must not be evaluated');
    });
    vi.doMock('@/db/runtime-backend', () => ({
      resolveDatabaseBackend: () => 'postgres',
    }));
    vi.doMock('@/lib/ai/durable-runs/sqlite-adapter', adapterModule);
    const { GET } = await import('@/app/api/ai/runs/route');

    const response = await GET(new Request('http://localhost/api/ai/runs'));

    expect(response.status).toBe(500);
    expect(adapterModule).not.toHaveBeenCalled();
  });
});
