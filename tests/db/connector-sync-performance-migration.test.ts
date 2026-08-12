import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('connector sync performance migration', () => {
  it('indexes every task relationship touched by archive deletion', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE focus_items (task_id TEXT NOT NULL);
      CREATE TABLE notifications (related_task_id TEXT);
      CREATE TABLE priority_sync_log (task_id TEXT NOT NULL);
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        type TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_task_dependencies_pair_type
        ON task_dependencies (task_id, depends_on_task_id, type);
      CREATE TABLE weekly_one_thing (task_id TEXT NOT NULL);
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0087_connector_sync_performance.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const cases = [
      ['focus_items', 'task_id', 'idx_focus_items_task_id'],
      ['notifications', 'related_task_id', 'idx_notifications_related_task_id'],
      ['priority_sync_log', 'task_id', 'idx_priority_sync_log_task_id'],
      ['weekly_one_thing', 'task_id', 'idx_weekly_one_thing_task_id'],
    ] as const;
    for (const [table, column, index] of cases) {
      const plan = sqlite.prepare(
        `EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE ${column} = ?`,
      ).all('task-1') as Array<{ detail: string }>;
      expect(plan.map(({ detail }) => detail).join(' ')).toContain(index);
    }

    const dependencyPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      DELETE FROM task_dependencies
      WHERE task_id = ? OR depends_on_task_id = ?
    `).all('task-1', 'task-1') as Array<{ detail: string }>;
    const dependencyDetails = dependencyPlan.map(({ detail }) => detail).join(' ');
    expect(dependencyDetails).toContain('idx_task_dependencies_pair_type');
    expect(dependencyDetails).toContain('idx_task_dependencies_depends_on');
    sqlite.close();
  });
});
