import { sql } from 'drizzle-orm';
import { afterAll, describe, it } from 'vitest';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describeAsyncTransactionRunnerContract,
  type AsyncTransactionRunnerContractHarness,
} from '../contracts/transaction-runner.contract';

/**
 * Live-PostgreSQL wiring proving `PostgresPersistenceBackend.asyncTransactions`
 * (`TransactionRunner`) genuinely supports awaited work inside an open
 * transaction: `db.transaction()` keeps the connection's transaction open
 * across the wire for the duration of the awaited callback, so work may issue
 * multiple round-trip queries and still commit or roll back atomically.
 *
 * `backend.transactions` (`SynchronousTransactionRunner`) is intentionally
 * *not* exercised here with real writes: every Postgres query is a network
 * round trip, so there is no way to perform genuine persistence from a
 * callback typed to return a non-Promise result - unlike SQLite, where
 * `better-sqlite3` calls really are synchronous (see
 * `sqlite-transaction-runner-contract.test.ts`). Fabricating a "synchronous
 * write" test here would just be a different flavor of the misleading seam
 * this module must avoid, so PostgreSQL's own capability - genuine async
 * transactions - is what gets proven, honestly, instead.
 *
 * Skipped unless `MC_TEST_POSTGRES_URL` is set, matching the other
 * `tests/db/postgres-*.integration.test.ts` conventions.
 */

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;
let runtime: typeof import('@/db/runtime') | null = null;
let initialized = false;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-transaction-runner-test';
  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  initialized = true;
}

const KEY_PREFIX = 'contract:transaction-runner:';

async function createAsyncHarness(): Promise<
  AsyncTransactionRunnerContractHarness<import('@/db/postgres/runtime').PostgresTransaction>
> {
  await initialize();
  if (!runtime) throw new Error('PostgreSQL transaction-runner runtime is not initialized');
  const backend = runtime.getPostgresPersistenceBackend();

  return {
    runner: backend.asyncTransactions,
    async write(context, key, value) {
      const fullKey = `${KEY_PREFIX}${key}`;
      const updatedAt = new Date().toISOString();
      await context.execute(sql`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (${fullKey}, ${JSON.stringify(value)}::jsonb, ${updatedAt})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
    },
    async read(key) {
      const result = await backend.context.pool.query<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = $1',
        [`${KEY_PREFIX}${key}`],
      );
      return result.rows[0]?.value;
    },
    async reset() {
      await backend.context.pool.query(
        'DELETE FROM app_settings WHERE key LIKE $1',
        [`${KEY_PREFIX}%`],
      );
    },
  };
}

if (connectionString) {
  describeAsyncTransactionRunnerContract(
    'PostgresPersistenceBackend.asyncTransactions',
    createAsyncHarness,
  );

  afterAll(async () => {
    if (initialized && runtime) {
      await runtime.getPostgresPersistenceBackend().context.pool.query(
        'DELETE FROM app_settings WHERE key LIKE $1',
        [`${KEY_PREFIX}%`],
      );
      await runtime.shutdownRuntimeDatabase();
    }
    restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
    restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
    restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
    restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  });
} else {
  describe('PostgresPersistenceBackend.asyncTransactions', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
