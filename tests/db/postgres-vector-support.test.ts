import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPostgresVectorMigrations } from '@/db/postgres/migrations';
import {
  initializePostgresVectorSupport,
  PostgresVectorUnavailableError,
  resolvePostgresVectorMode,
} from '@/db/postgres/vector-support';

vi.mock('@/db/postgres/migrations', () => ({
  runPostgresVectorMigrations: vi.fn(),
}));

function poolWithVersion(version: string | null) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: version === null ? [] : [{ extversion: version }],
    }),
  } as never;
}

describe('PostgreSQL vector support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runPostgresVectorMigrations).mockResolvedValue(undefined);
  });

  it('defaults to optional and rejects unknown modes', () => {
    expect(resolvePostgresVectorMode(undefined)).toBe('optional');
    expect(resolvePostgresVectorMode(' REQUIRED ')).toBe('required');
    expect(() => resolvePostgresVectorMode('enabled')).toThrow(
      'MC_POSTGRES_VECTOR_MODE must be optional or required',
    );
  });

  it('degrades explicitly without running vector migrations when optional', async () => {
    await expect(initializePostgresVectorSupport(poolWithVersion(null), {
      mode: 'optional',
    })).resolves.toEqual({
      available: false,
      mode: 'optional',
      extensionVersion: null,
      reason: 'extension-unavailable',
    });
    expect(runPostgresVectorMigrations).not.toHaveBeenCalled();
  });

  it('fails with an actionable error when pgvector is required', async () => {
    await expect(initializePostgresVectorSupport(poolWithVersion(null), {
      mode: 'required',
    })).rejects.toBeInstanceOf(PostgresVectorUnavailableError);
  });

  it('runs the isolated migration stream for a supported extension', async () => {
    const pool = poolWithVersion('0.8.6');
    await expect(initializePostgresVectorSupport(pool, {
      mode: 'required',
      migrationsFolder: 'drizzle/postgres-vector',
    })).resolves.toEqual({
      available: true,
      mode: 'required',
      extensionVersion: '0.8.6',
      maxDimensions: 4000,
    });
    expect(runPostgresVectorMigrations).toHaveBeenCalledWith(pool, {
      migrationsFolder: 'drizzle/postgres-vector',
    });
  });

  it('degrades without exposing migration details when optional schema setup fails', async () => {
    vi.mocked(runPostgresVectorMigrations).mockRejectedValue(
      Object.assign(new Error('sensitive database detail'), { code: '42501' }),
    );

    await expect(initializePostgresVectorSupport(poolWithVersion('0.8.6'), {
      mode: 'optional',
    })).resolves.toEqual({
      available: false,
      mode: 'optional',
      extensionVersion: null,
      reason: 'schema-unavailable',
    });
  });

  it('fails closed when required schema setup fails', async () => {
    vi.mocked(runPostgresVectorMigrations).mockRejectedValue(new Error('permission denied'));

    await expect(initializePostgresVectorSupport(poolWithVersion('0.8.6'), {
      mode: 'required',
    })).rejects.toThrow('Verify schema ownership and migration privileges');
  });

  it('refuses pgvector versions without iterative HNSW scans', async () => {
    await expect(initializePostgresVectorSupport(poolWithVersion('0.7.4'), {
      mode: 'required',
    })).rejects.toThrow('older than 0.8.0');
  });

  it('keeps extension installation outside the application migration stream', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/postgres-vector/0000_semantic_vector_ann.sql'),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE "semantic_vector_ann"');
    expect(migration).toContain('vector_dims("embedding") = "dimensions"');
    expect(migration).not.toMatch(/CREATE\s+EXTENSION/iu);
  });
});
