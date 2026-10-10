import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('finance clean bootstrap migrations', () => {
  it('creates the SQLite audit and confirmation fences', () => {
    const sql = readFileSync(
      join(process.cwd(), 'drizzle', '0150_finance_clean_bootstrap.sql'),
      'utf8',
    ).replaceAll('--> statement-breakpoint', '');
    const database = new Database(':memory:');
    try {
      database.exec(sql);
      const columns = database.prepare(
        `PRAGMA table_info(finance_clean_bootstrap_audit)`,
      ).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'connector_id',
        'mode',
        'idempotency_key',
        'dry_run_id',
        'scope_digest',
        'confirmation_token',
        'inventory',
        'result',
      ]));
      const indexes = database.prepare(
        `PRAGMA index_list(finance_clean_bootstrap_audit)`,
      ).all() as Array<{ name: string; unique: number }>;
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_finance_clean_bootstrap_idempotency',
          unique: 1,
        }),
        expect.objectContaining({
          name: 'idx_finance_clean_bootstrap_dry_run',
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it('keeps the PostgreSQL migration equivalent and JSON-native', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        'drizzle',
        'postgres',
        '0028_finance_clean_bootstrap.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE "finance_clean_bootstrap_audit"');
    expect(sql).toContain('"inventory" jsonb NOT NULL');
    expect(sql).toContain('"result" jsonb NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "idx_finance_clean_bootstrap_idempotency"',
    );
    expect(sql).toContain(
      'CREATE INDEX "idx_finance_clean_bootstrap_dry_run"',
    );
  });
});
