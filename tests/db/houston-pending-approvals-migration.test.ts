import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Houston pending approvals migration', () => {
  it('creates bounded server-owned approval storage', () => {
    const sqlite = new Database(':memory:');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0120_houston_pending_approvals.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'houston_finance_pending_approvals'
    `).get()).toEqual({ name: 'houston_finance_pending_approvals' });
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_houston_finance_pending_expiry'
    `).get()).toEqual({ name: 'idx_houston_finance_pending_expiry' });
    sqlite.close();
  });
});
