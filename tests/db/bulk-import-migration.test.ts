import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function createTasksTable(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      connector_instance_id TEXT,
      source_list_id TEXT,
      created_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      parent_id TEXT
    )
  `);
}

function runMigration(sqlite: Database.Database): void {
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'drizzle', '0027_add_bulk_import_flag.sql'),
    'utf8'
  );

  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('bulk import migration', () => {
  it('backfills each source list without correlated full-table scans', () => {
    const sqlite = new Database(':memory:');
    createTasksTable(sqlite);

    const insert = sqlite.prepare(`
      INSERT INTO tasks (
        id, connector_instance_id, source_list_id, created_at, last_synced_at, parent_id
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `);
    const insertTasks = sqlite.transaction(() => {
      for (let i = 0; i < 35_000; i++) {
        const list = `list-${i % 25}`;
        const syncDay = String(10 + (i % 3)).padStart(2, '0');
        insert.run(
          `task-${i}`,
          'connector-1',
          list,
          '2025-01-01T00:00:00.000Z',
          `2026-07-${syncDay}T00:00:00.000Z`
        );
      }
    });
    insertTasks();

    const startedAt = performance.now();
    runMigration(sqlite);
    const elapsedMs = performance.now() - startedAt;

    const result = sqlite.prepare(
      'SELECT COUNT(*) AS count FROM tasks WHERE is_bulk_import = 1'
    ).get() as { count: number };

    expect(result.count).toBe(35_000);
    expect(elapsedMs).toBeLessThan(5_000);
    sqlite.close();
  });

  it('preserves list, connector fallback, first-sync, and child-date behavior', () => {
    const sqlite = new Database(':memory:');
    createTasksTable(sqlite);
    const insert = sqlite.prepare(`
      INSERT INTO tasks (
        id, connector_instance_id, source_list_id, created_at, last_synced_at, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    insert.run('list-old', 'connector-1', 'list-1', '2025-01-01', '2026-07-10', null);
    insert.run('list-new', 'connector-1', 'list-1', '2026-07-11', '2026-07-10', null);
    insert.run('connector-first', 'connector-2', 'list-2', '2026-07-01', '2026-07-01', null);
    insert.run('no-list-old', 'connector-2', null, '2025-01-01', '2026-07-10', null);
    insert.run('no-list-new', 'connector-2', null, '2026-07-05', '2026-07-10', null);
    insert.run('first-sync', 'connector-3', 'list-3', '2026-07-10', '2026-07-10', null);
    insert.run('parent', 'connector-4', 'list-4', '2025-01-01', '2026-07-10', null);
    insert.run('child', 'connector-4', 'list-4', '2026-07-10', '2026-07-10', 'parent');

    runMigration(sqlite);

    const rows = sqlite.prepare(
      'SELECT id, created_at, is_bulk_import FROM tasks ORDER BY id'
    ).all() as Array<{ id: string; created_at: string; is_bulk_import: number }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('list-old')?.is_bulk_import).toBe(1);
    expect(byId.get('list-new')?.is_bulk_import).toBe(0);
    expect(byId.get('no-list-old')?.is_bulk_import).toBe(1);
    expect(byId.get('no-list-new')?.is_bulk_import).toBe(0);
    expect(byId.get('first-sync')?.is_bulk_import).toBe(1);
    expect(byId.get('child')?.created_at).toBe('2025-01-01');
    sqlite.close();
  });
});
