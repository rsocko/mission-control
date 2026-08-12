import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('task source identity migration', () => {
  it('removes exact source duplicates and prevents them from recurring', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id text PRIMARY KEY,
        source_id text NOT NULL,
        connector_instance_id text NOT NULL,
        parent_id text,
        last_synced_at text,
        updated_at text NOT NULL
      );
      CREATE TABLE task_tags(task_id text);
      CREATE TABLE task_projects(task_id text);
      CREATE TABLE task_schedules(task_id text);
      CREATE TABLE my_day_items(task_id text);
      CREATE TABLE my_day_exclusions(task_id text);
      CREATE TABLE focus_items(task_id text);
      CREATE TABLE weekly_one_thing(task_id text);
      CREATE TABLE priority_sync_log(task_id text);
      CREATE TABLE task_triage_log(task_id text);
      CREATE TABLE task_linked_sources(task_id text);
      CREATE TABLE task_attachments(task_id text);
      CREATE TABLE project_phase_items(task_id text);
      CREATE TABLE task_history_events(task_id text);
      CREATE TRIGGER task_history_immutable_delete
      BEFORE DELETE ON task_history_events
      BEGIN
        SELECT RAISE(ABORT, 'Task history events are immutable');
      END;
      CREATE TABLE task_dependencies(task_id text, depends_on_task_id text);
      CREATE TABLE notifications(related_task_id text);

      CREATE INDEX idx_tasks_source_connector ON tasks(source_id, connector_instance_id);

      INSERT INTO tasks VALUES
        ('old', 'list:task', 'connector', NULL, '2026-08-01', '2026-08-01'),
        ('new', 'list:task', 'connector', NULL, '2026-08-02', '2026-08-02'),
        ('child', 'list:task:check', 'connector', 'old', '2026-08-01', '2026-08-01');
      INSERT INTO my_day_items VALUES ('old');
      INSERT INTO task_history_events VALUES ('old');
      INSERT INTO task_dependencies VALUES ('old', 'new');
      INSERT INTO notifications VALUES ('old');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0038_enforce_task_source_identity.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 'new' }]);
    expect(sqlite.prepare('SELECT * FROM my_day_items').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM task_dependencies').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM task_history_events').all()).toEqual([{ task_id: 'old' }]);
    expect(sqlite.prepare('SELECT related_task_id FROM notifications').all()).toEqual([
      { related_task_id: null },
    ]);
    expect(() => sqlite.prepare(
      'INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)',
    ).run('duplicate', 'list:task', 'connector', null, '2026-08-03', '2026-08-03')).toThrow();

    sqlite.close();
  });
});
