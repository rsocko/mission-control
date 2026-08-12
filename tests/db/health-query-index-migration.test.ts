import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('health query index migration', () => {
  it('indexes the latest sync lookup used by the health endpoint', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sync_log (
        id TEXT PRIMARY KEY NOT NULL,
        connector_id TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0084_classy_stone_men.sql'),
      'utf8',
    );
    sqlite.exec(migration);

    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM sync_log
      WHERE connector_id = ?
      ORDER BY synced_at DESC
      LIMIT 1
    `).all('github-1');

    expect(plan.some((row) =>
      String((row as { detail: string }).detail).includes('idx_sync_log_connector_synced_at')
    )).toBe(true);
    sqlite.close();
  });
});
