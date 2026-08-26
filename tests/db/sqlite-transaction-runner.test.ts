import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnsupportedTransactionWorkError } from '@/db/persistence/contracts';
import { SqliteTransactionRunner } from '@/db/persistence/sqlite-transaction-runner';

describe('SqliteTransactionRunner', () => {
  let sqlite: Database.Database;
  let transactions: SqliteTransactionRunner;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    transactions = new SqliteTransactionRunner(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('commits completed atomic work', async () => {
    await transactions.run((database) => {
      database.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run('one', 'saved');
    });

    expect(sqlite.prepare('SELECT value FROM entries WHERE id = ?').get('one'))
      .toEqual({ value: 'saved' });
  });

  it('rolls back and preserves the original error', async () => {
    const failure = new Error('write failed');

    await expect(transactions.run((database) => {
      database.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run('one', 'discarded');
      throw failure;
    })).rejects.toBe(failure);

    expect(sqlite.prepare('SELECT 1 FROM entries WHERE id = ?').get('one')).toBeUndefined();
  });

  it('rejects transaction work that yields before commit', async () => {
    const invalidWork: (database: Database.Database) => void = async (database) => {
      database.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run('one', 'discarded');
      await Promise.resolve();
    };

    await expect(transactions.run(invalidWork))
      .rejects.toBeInstanceOf(UnsupportedTransactionWorkError);

    expect(sqlite.prepare('SELECT 1 FROM entries WHERE id = ?').get('one')).toBeUndefined();
  });
});
