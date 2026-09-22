import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

describe('triage sync state revision migration', () => {
  it('adds a monotonic revision with a zero default to existing sync state', () => {
    const sqlite = new Database(':memory:');

    try {
      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

      const revision = sqlite.prepare(`
        SELECT name, type, "notnull" AS "notNull", dflt_value AS "defaultValue"
        FROM pragma_table_info('triage_sync_state')
        WHERE name = 'revision'
      `).get();
      expect(revision).toEqual({
        name: 'revision',
        type: 'INTEGER',
        notNull: 1,
        defaultValue: '0',
      });

      sqlite.prepare(`
        INSERT INTO triage_sync_state (id, total_imported, total_skipped)
        VALUES ('migration-default', 3, 2)
      `).run();
      expect(sqlite.prepare(`
        SELECT revision FROM triage_sync_state WHERE id = 'migration-default'
      `).get()).toEqual({ revision: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('preserves existing cursor and counter state while adding revision', () => {
    const sqlite = new Database(':memory:');

    try {
      sqlite.exec(`
        CREATE TABLE triage_sync_state (
          id TEXT PRIMARY KEY,
          last_cursor TEXT,
          last_synced_at TEXT,
          total_imported INTEGER NOT NULL DEFAULT 0,
          total_skipped INTEGER NOT NULL DEFAULT 0,
          last_run_imported INTEGER NOT NULL DEFAULT 0,
          last_run_skipped INTEGER NOT NULL DEFAULT 0,
          last_run_errors TEXT NOT NULL DEFAULT '[]',
          last_run_duration_ms INTEGER
        );
        INSERT INTO triage_sync_state (
          id, last_cursor, total_imported, total_skipped,
          last_run_imported, last_run_skipped
        ) VALUES ('existing-source', 'opaque-cursor', 9, 4, 2, 1);
      `);

      _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

      expect(sqlite.prepare(`
        SELECT last_cursor AS lastCursor, total_imported AS totalImported,
          total_skipped AS totalSkipped, revision
        FROM triage_sync_state
        WHERE id = 'existing-source'
      `).get()).toEqual({
        lastCursor: 'opaque-cursor',
        totalImported: 9,
        totalSkipped: 4,
        revision: 0,
      });
    } finally {
      sqlite.close();
    }
  });
});
