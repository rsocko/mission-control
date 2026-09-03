import Database from 'better-sqlite3';
import { afterAll } from 'vitest';
import { SqliteTransactionRunner } from '@/db/persistence/sqlite-transaction-runner';
import {
  describeSynchronousRunnerRejectsAsyncWork,
  describeSynchronousTransactionRunnerContract,
  type SynchronousTransactionRunnerContractHarness,
} from '../contracts/transaction-runner.contract';

/**
 * Wires the shared `SynchronousTransactionRunner<TContext>` contract against
 * `SqliteTransactionRunner`, proving the *same* portable seam
 * (`PersistenceBackend.transactions`) that PostgreSQL implements also holds
 * for SQLite - see `postgres-transaction-runner.integration.test.ts` for the
 * PostgreSQL side of this shared contract, and its `asyncTransactions`-only
 * genuine-async contract, which SQLite deliberately does not claim to
 * support (see `../contracts/transaction-runner.contract.ts`).
 */
const sqlite = new Database(':memory:');
sqlite.exec(
  'CREATE TABLE IF NOT EXISTS contract_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
);
const runner = new SqliteTransactionRunner(sqlite);

async function createHarness(): Promise<
  SynchronousTransactionRunnerContractHarness<Database.Database>
> {
  return {
    runner,
    write(database, key, value) {
      database.prepare(
        'INSERT INTO contract_entries (key, value) VALUES (?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },
    async read(key) {
      const row = sqlite.prepare('SELECT value FROM contract_entries WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    },
    async reset() {
      sqlite.prepare('DELETE FROM contract_entries').run();
    },
  };
}

describeSynchronousTransactionRunnerContract('SqliteTransactionRunner', createHarness);
describeSynchronousRunnerRejectsAsyncWork('SqliteTransactionRunner', createHarness);

afterAll(() => {
  sqlite.close();
});
