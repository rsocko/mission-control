import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    const cutover = journal.entries.find(
      entry => entry.tag === '0105_github_nodeid_permanent_cutover',
    );
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

  it('uses portable migration hashes while accepting legacy checkout-specific hashes', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const directory = mkdtempSync(join(tmpdir(), 'mc-portable-migration-hash-'));
    const metaDirectory = join(directory, 'meta');
    const tag = '0000_line_ending_probe';
    const portableSql = 'CREATE TABLE line_ending_probe (id INTEGER);\n';
    const portableHash = createHash('sha256')
      .update(portableSql)
      .digest('hex');
    const legacyWindowsHash = createHash('sha256')
      .update(portableSql.replace(/\n/g, '\r\n'))
      .digest('hex');
    mkdirSync(metaDirectory);
    writeFileSync(join(directory, `${tag}.sql`), portableSql);
    writeFileSync(join(metaDirectory, '_journal.json'), JSON.stringify({
      entries: [{ idx: 0, tag, when: 1 }],
    }));

    const fresh = new Database(':memory:');
    const legacy = new Database(':memory:');
    try {
      _runMigrationsIndividually(fresh, directory);
      expect(fresh.prepare(
        'SELECT hash FROM __drizzle_migrations',
      ).pluck().get()).toBe(portableHash);

      legacy.exec(`
        CREATE TABLE __drizzle_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hash TEXT NOT NULL,
          created_at INTEGER
        );
        CREATE TABLE line_ending_probe (id INTEGER);
      `);
      legacy.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 1)',
      ).run(legacyWindowsHash);
      _runMigrationsIndividually(legacy, directory);
      expect(legacy.prepare(
        'SELECT COUNT(*) FROM __drizzle_migrations',
      ).pluck().get()).toBe(1);
    } finally {
      fresh.close();
      legacy.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
