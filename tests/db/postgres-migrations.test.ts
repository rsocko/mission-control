import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  PostgresDatabaseBootstrapAdapter,
  runPostgresMigrations,
} from '@/db/postgres/migrations';

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: vi.fn(),
}));

describe('PostgreSQL migrations', () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const pool = { connect } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it('implements bootstrap by holding an advisory lock while migrations run', async () => {
    const adapter = new PostgresDatabaseBootstrapAdapter(pool, {
      migrationsFolder: 'drizzle/postgres',
    });
    await adapter.initialize();

    expect(query).toHaveBeenNthCalledWith(
      3,
      'SELECT pg_advisory_lock($1, $2)',
      [1_296_250_820, 1_619],
    );
    expect(migrate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        migrationsFolder: 'drizzle/postgres',
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations',
      }),
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'SELECT pg_advisory_unlock($1, $2)',
      [1_296_250_820, 1_619],
    );
    expect(query).toHaveBeenNthCalledWith(5, 'RESET statement_timeout');
    expect(query).toHaveBeenNthCalledWith(
      6,
      'RESET idle_in_transaction_session_timeout',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('unlocks and releases the client when a migration fails', async () => {
    const failure = new Error('migration failed');
    vi.mocked(migrate).mockRejectedValueOnce(failure);

    await expect(
      runPostgresMigrations(pool, { migrationsFolder: 'drizzle/postgres' }),
    ).rejects.toBe(failure);

    expect(query).toHaveBeenNthCalledWith(
      4,
      'SELECT pg_advisory_unlock($1, $2)',
      [1_296_250_820, 1_619],
    );
    expect(query).toHaveBeenLastCalledWith(
      'RESET idle_in_transaction_session_timeout',
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
