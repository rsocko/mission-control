import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('finance dataset migration', () => {
  it('adds independent empty projections without inferring freshness', () => {
    const sqlite = new Database(':memory:');
    for (const migrationName of [
      '0076_panoramic_layla_miller.sql',
      '0077_superb_overlord.sql',
    ]) {
      const migration = readFileSync(
        resolve(process.cwd(), `drizzle/${migrationName}`),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }

    const tables = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'finance_%'
      ORDER BY name
    `).all();
    expect(tables).toEqual(expect.arrayContaining([
      { name: 'finance_accounts' },
      { name: 'finance_budget_snapshots' },
      { name: 'finance_categories' },
      { name: 'finance_category_groups' },
      { name: 'finance_dataset_sync_state' },
      { name: 'finance_recurring_obligations' },
      { name: 'finance_tags' },
    ]));
    expect(sqlite.prepare(`SELECT count(*) AS count FROM finance_dataset_sync_state`).get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare(`PRAGMA table_info(finance_accounts)`).all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'current_balance' }),
      ]));
    sqlite.close();
  });
});
