import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('task dependency sync migration', () => {
  it('adds source synchronization metadata while preserving local defaults', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (id text PRIMARY KEY);
      CREATE TABLE task_dependencies (
        id text PRIMARY KEY NOT NULL,
        task_id text NOT NULL,
        depends_on_task_id text NOT NULL,
        type text DEFAULT 'blocks' NOT NULL,
        created_at text NOT NULL
      );
      INSERT INTO task_dependencies
        (id, task_id, depends_on_task_id, type, created_at)
      VALUES
        ('dependency-1', 'blocked', 'blocker', 'blocks', '2026-07-30T00:00:00.000Z');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0030_add_task_dependency_sync.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const dependency = sqlite.prepare(`
      SELECT connector_instance_id, sync_status, sync_action, sync_error, last_synced_at
      FROM task_dependencies
      WHERE id = 'dependency-1'
    `).get() as Record<string, unknown>;

    expect(dependency).toEqual({
      connector_instance_id: null,
      sync_status: 'local',
      sync_action: null,
      sync_error: null,
      last_synced_at: null,
    });
    sqlite.close();
  });

  it('does not mark or continue past a missing prerequisite table', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const folder = join(tmpdir(), `mc-migrations-${Date.now()}`);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
      entries: [
        { idx: 33, tag: '0029_missing_prerequisite', when: 1 },
        { idx: 34, tag: '0030_must_not_run', when: 2 },
      ],
    }));
    writeFileSync(
      join(folder, '0029_missing_prerequisite.sql'),
      'ALTER TABLE missing_dependencies ADD sync_status text;',
    );
    writeFileSync(
      join(folder, '0030_must_not_run.sql'),
      'CREATE TABLE should_not_exist (id text);',
    );
    const sqlite = new Database(':memory:');

    try {
      _runMigrationsIndividually(sqlite, folder);
      const applied = sqlite.prepare(
        'SELECT COUNT(*) AS count FROM __drizzle_migrations',
      ).get() as { count: number };
      const table = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
      ).get();
      expect(applied.count).toBe(0);
      expect(table).toBeUndefined();
    } finally {
      sqlite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('does not mark or continue past a modern missing-column failure', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const folder = join(tmpdir(), `mc-column-migrations-${Date.now()}`);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
      entries: [
        { idx: 33, tag: '0029_missing_column', when: 1 },
        { idx: 34, tag: '0030_must_not_run', when: 2 },
      ],
    }));
    writeFileSync(
      join(folder, '0029_missing_column.sql'),
      'CREATE INDEX missing_column_index ON existing_table(missing_column);',
    );
    writeFileSync(
      join(folder, '0030_must_not_run.sql'),
      'CREATE TABLE should_not_exist (id text);',
    );
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE existing_table (id text);');

    try {
      _runMigrationsIndividually(sqlite, folder);
      const applied = sqlite.prepare(
        'SELECT COUNT(*) AS count FROM __drizzle_migrations',
      ).get() as { count: number };
      const table = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
      ).get();
      expect(applied.count).toBe(0);
      expect(table).toBeUndefined();
    } finally {
      sqlite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('stops after an unexpected statement failure without marking it applied', async () => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const { _runMigrationsIndividually } = await import('@/db');
    const folder = join(tmpdir(), `mc-failed-migrations-${Date.now()}`);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
      entries: [
        { idx: 33, tag: '0033_unexpected_failure', when: 1 },
        { idx: 34, tag: '0034_must_not_run', when: 2 },
      ],
    }));
    writeFileSync(
      join(folder, '0033_unexpected_failure.sql'),
      [
        'CREATE TABLE rolled_back_table (id text);',
        '--> statement-breakpoint',
        'CREATE INDEX invalid_index ON existing_table(missing_column);',
      ].join('\n'),
    );
    writeFileSync(
      join(folder, '0034_must_not_run.sql'),
      'CREATE TABLE should_not_exist (id text);',
    );
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE existing_table (id text);');

    try {
      expect(() => _runMigrationsIndividually(sqlite, folder)).not.toThrow();
      expect(sqlite.prepare(
        'SELECT COUNT(*) AS count FROM __drizzle_migrations',
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
      ).get()).toBeUndefined();
      expect(sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back_table'",
      ).get()).toBeUndefined();
    } finally {
      sqlite.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
