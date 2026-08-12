import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('task local disposition migration', () => {
  it('backfills active, constrains values, and creates the filter index', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      INSERT INTO tasks (id, title) VALUES ('task-1', 'Existing task');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0053_add_task_local_disposition.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(
      'SELECT local_disposition FROM tasks WHERE id = ?',
    ).get('task-1')).toEqual({ local_disposition: 'active' });
    sqlite.prepare(
      'UPDATE tasks SET local_disposition = ? WHERE id = ?',
    ).run('handled', 'task-1');
    expect(() => sqlite.prepare(
      'UPDATE tasks SET local_disposition = ? WHERE id = ?',
    ).run('completed', 'task-1')).toThrow();
    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_tasks_local_disposition');
    sqlite.close();
  });
});
