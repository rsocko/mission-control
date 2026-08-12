import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('triage action claims migration', () => {
  it('allows only one claim for each irreversible item action', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE triage_items (id text PRIMARY KEY NOT NULL);
      INSERT INTO triage_items VALUES ('item-1');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0046_add_triage_action_claims.sql'),
      'utf8',
    );

    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const insert = sqlite.prepare(`
      INSERT INTO triage_action_claims
        (id, triage_item_id, action_type, state, claimed_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    insert.run('claim-1', 'item-1', 'create_task_todo', '2026-08-03T12:00:00.000Z');

    expect(() => insert.run(
      'claim-2',
      'item-1',
      'create_task_todo',
      '2026-08-03T12:00:00.001Z',
    )).toThrow();
    expect(insert.run(
      'claim-3',
      'item-1',
      'save_karakeep',
      '2026-08-03T12:00:00.002Z',
    ).changes).toBe(1);

    sqlite.prepare('DELETE FROM triage_items WHERE id = ?').run('item-1');
    expect(sqlite.prepare('SELECT * FROM triage_action_claims').all()).toEqual([]);

    sqlite.close();
  });
});
