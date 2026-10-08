import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('task soft-delete migration', () => {
  it('adds the nullable deletion timestamp and retention index', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0131_gigantic_toxin.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare('PRAGMA table_info(tasks)').all()).toContainEqual(
      expect.objectContaining({ name: 'deleted_at', notnull: 0 }),
    );
    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_tasks_deleted_at');
    sqlite.close();
  });
});
