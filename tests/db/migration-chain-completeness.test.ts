import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

function readJournal(): { entries: Array<{ idx: number; tag: string }> } {
  return JSON.parse(
    readFileSync(resolve(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; tag: string }> };
}

describe('migration chain completeness', () => {
  it('applies every journaled migration to a fresh database', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const journal = readJournal();
    const sqlite = new Database(':memory:');

    try {
      // A single unexpected statement failure halts every later migration, so a
      // fresh database must be able to replay the whole journal in one pass.
      _runMigrationsIndividually(sqlite, MIGRATIONS_FOLDER);

      expect(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM __drizzle_migrations',
      ).get()).toEqual({ count: journal.entries.length });
    } finally {
      sqlite.close();
    }
  });

  it('leaves the permanent NodeID cutover schema in place after the full chain', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const journal = readJournal();
    const cutover = journal.entries.at(-1);
    const sqlite = new Database(':memory:');

    try {
      _runMigrationsIndividually(sqlite, MIGRATIONS_FOLDER);

      expect(cutover?.tag).toBe('0105_github_nodeid_permanent_cutover');
      const writeCycleColumns = sqlite.prepare(
        "SELECT name FROM pragma_table_info('github_identity_write_cycles')",
      ).all().map((column) => (column as { name: string }).name);
      expect(writeCycleColumns).toContain('applied_count');
      expect(writeCycleColumns).not.toContain('effective_mode');
      expect(writeCycleColumns).not.toContain('comparison_run_id');

      for (const table of [
        'github_identity_comparison_runs',
        'github_identity_comparison_records',
        'github_identity_sub_issue_population_members',
      ]) {
        expect(sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }
    } finally {
      sqlite.close();
    }
  });
});
