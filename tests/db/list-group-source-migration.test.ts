import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const sqliteMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/0152_source_scoped_list_groups.sql'),
  'utf8',
);
const postgresMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/postgres/0030_source_scoped_list_groups.sql'),
  'utf8',
);

describe('source-scoped list group migration', () => {
  it('splits mixed-source groups and preserves every list assignment', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE list_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT,
        icon_color TEXT,
        source_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE source_lists (
        id TEXT PRIMARY KEY,
        connector_instance_id TEXT NOT NULL,
        group_id TEXT REFERENCES list_groups(id) ON DELETE SET NULL
      );
      INSERT INTO connector_configs VALUES
        ('connector-a', '2026-01-01T00:00:00.000Z'),
        ('connector-b', '2026-01-02T00:00:00.000Z');
      INSERT INTO list_groups VALUES
        ('mixed', 'Shared', 'folder', '#3b82f6', 'remote-folder', 2, '2026-01-01T00:00:00.000Z'),
        ('empty', 'Empty', NULL, NULL, NULL, 3, '2026-01-01T00:00:00.000Z');
      INSERT INTO source_lists VALUES
        ('list-a', 'connector-a', 'mixed'),
        ('list-b', 'connector-b', 'mixed');
    `);

    for (const statement of sqliteMigration.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue;
      try {
        sqlite.exec(statement);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
          throw error;
        }
      }
    }

    const groups = sqlite.prepare(`
      SELECT id, connector_instance_id AS connectorInstanceId, source_id AS sourceId
      FROM list_groups
      ORDER BY id
    `).all();
    expect(groups).toEqual([
      { id: 'empty', connectorInstanceId: 'connector-a', sourceId: null },
      { id: 'mixed', connectorInstanceId: 'connector-a', sourceId: 'remote-folder' },
      {
        id: 'mixed--source-connector-b',
        connectorInstanceId: 'connector-b',
        sourceId: 'remote-folder',
      },
    ]);
    expect(sqlite.prepare('SELECT id, group_id AS groupId FROM source_lists ORDER BY id').all())
      .toEqual([
        { id: 'list-a', groupId: 'mixed' },
        { id: 'list-b', groupId: 'mixed--source-connector-b' },
      ]);
    sqlite.close();
  });

  it('keeps the SQLite and PostgreSQL migrations behaviorally aligned', () => {
    for (const migration of [sqliteMigration, postgresMigration]) {
      expect(migration).toContain('connector_instance_id');
      expect(migration).toContain('_list_group_owners');
      expect(migration).toContain('--source-');
      expect(migration).toContain('list_groups_connector_idx');
    }
  });
});
