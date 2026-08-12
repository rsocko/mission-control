import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Work To Do bridge migration', () => {
  it('creates durable checkpoint and idempotent change tables', () => {
    const sqlite = new Database(':memory:');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0059_work_todo_bridge_runtime.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const tables = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'work_todo_%'
      ORDER BY name
    `).all();
    expect(tables).toEqual([
      { name: 'work_todo_bridge_state' },
      { name: 'work_todo_list_delta_state' },
      { name: 'work_todo_outbound_changes' },
    ]);
    sqlite.close();
  });
});

