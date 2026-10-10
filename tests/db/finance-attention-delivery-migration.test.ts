import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const sqliteMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/0149_finance_attention_delivery_receipts.sql'),
  'utf8',
);
const postgresMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/postgres/0027_finance_attention_delivery_receipts.sql'),
  'utf8',
);

describe('Finance attention delivery receipt migration', () => {
  it('creates a durable exact-version receipt ledger in SQLite', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(sqliteMigration);
    sqlite.prepare(`
      INSERT INTO finance_attention_delivery_receipts (
        delivery_key, connector_id, version, action, payload_digest, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'finance-automation:signal-v1-synthetic',
      'connector-synthetic',
      2,
      'update',
      'digest-synthetic',
      '2026-10-09T12:00:00.000Z',
    );
    expect(sqlite.prepare(`
      SELECT version, action FROM finance_attention_delivery_receipts
    `).get()).toEqual({ version: 2, action: 'update' });
    expect(() => sqlite.prepare(`
      INSERT INTO finance_attention_delivery_receipts (
        delivery_key, connector_id, version, action, payload_digest, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'finance-automation:signal-v1-synthetic',
      'connector-synthetic',
      2,
      'update',
      'digest-synthetic',
      '2026-10-09T12:00:00.000Z',
    )).toThrow();
    sqlite.close();
  });

  it('uses the same protected receipt columns and indexes in PostgreSQL', () => {
    for (const column of [
      'delivery_key',
      'connector_id',
      'version',
      'action',
      'payload_digest',
      'applied_at',
    ]) {
      expect(postgresMigration).toContain(`"${column}"`);
    }
    expect(postgresMigration).toContain('"idx_finance_attention_delivery_connector"');
  });
});
