import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves the semantic-index facade actually switches backends, and — just as
 * importantly — that the PostgreSQL path never reaches into the SQLite
 * compatibility layer. `@/db`'s `sqlite` export throws on any access, so a code
 * path that still touched SQLite would fail here instead of silently working.
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
}));

const postgresMocks = vi.hoisted(() => ({
  semanticIndexRepository: {
    getReadiness: vi.fn(async () => ({
      available: true,
      activeIdentityId: 'pg-identity',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      documentCount: 1,
      vectorCount: 1,
      readyIdentityIds: [],
      byEntityType: [],
    })),
  },
}));

vi.mock('@/db/runtime', () => ({
  getPostgresSemanticIndexRepository: () => postgresMocks.semanticIndexRepository,
}));

const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
});

describe('semantic index backend selection', () => {
  it('resolves to the PostgreSQL adapter without touching SQLite', async () => {
    process.env.MC_DATABASE_BACKEND = 'postgres';
    const { getSemanticIndexRepository } = await import('@/lib/semantic-index/repository-facade');

    const repository = await getSemanticIndexRepository();
    expect(repository).toBe(postgresMocks.semanticIndexRepository);

    const readiness = await repository.getReadiness();
    expect(readiness.activeIdentityId).toBe('pg-identity');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('requires the semantic source port to be selected by startup composition', async () => {
    process.env.MC_DATABASE_BACKEND = 'postgres';
    const {
      getSemanticSourcePort,
      registerSemanticSourcePort,
    } = await import('@/lib/semantic-index/source/facade');

    await expect(getSemanticSourcePort()).rejects.toThrow(
      'Semantic source port has not been registered',
    );
    const sourcePort = { get: vi.fn(async () => null) };
    registerSemanticSourcePort(sourcePort as never);
    await expect(getSemanticSourcePort()).resolves.toBe(sourcePort);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('only reaches for the SQLite handle on the SQLite path', async () => {
    process.env.MC_DATABASE_BACKEND = 'sqlite';
    const { getSemanticIndexRepository } = await import('@/lib/semantic-index/repository-facade');

    // This suite mocks `@/db`'s `sqlite` handle to throw, so the rejection here
    // is the proof that the SQLite branch — and only it — reads that handle.
    await expect(getSemanticIndexRepository()).rejects.toThrow('SQLite must not be touched');
    expect(sqliteTouch).toHaveBeenCalled();
  });

  it('rejects an unknown backend selection instead of guessing', async () => {
    process.env.MC_DATABASE_BACKEND = 'mysql';
    const { getSemanticIndexRepository } = await import('@/lib/semantic-index/repository-facade');
    await expect(getSemanticIndexRepository()).rejects.toThrow(
      'MC_DATABASE_BACKEND must be sqlite or postgres',
    );
  });
});
