import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('task field states migration', () => {
  it('backfills Scout snapshots without overrides and enforces task ownership', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE tasks (
        id text PRIMARY KEY,
        connector_type text NOT NULL,
        title text NOT NULL,
        description text,
        priority text NOT NULL,
        due_date text,
        last_synced_at text NOT NULL,
        updated_at text NOT NULL
      );
      INSERT INTO tasks VALUES
        (
          'scout-1',
          'scout',
          'Source title',
          NULL,
          'high',
          '2026-08-10',
          '2026-08-04T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z'
        ),
        (
          'local-1',
          'local',
          'Local title',
          'Local description',
          'none',
          NULL,
          '2026-08-04T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z'
        );
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0051_add_task_field_states.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const states = sqlite.prepare(`
      SELECT
        task_id AS taskId,
        field_name AS fieldName,
        source_value AS sourceValue,
        locally_overridden AS locallyOverridden,
        source_observed_at AS sourceObservedAt,
        local_edited_at AS localEditedAt
      FROM task_field_states
      ORDER BY field_name
    `).all();
    expect(states).toEqual([
      {
        taskId: 'scout-1',
        fieldName: 'description',
        sourceValue: 'null',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-04T00:00:00.000Z',
        localEditedAt: null,
      },
      {
        taskId: 'scout-1',
        fieldName: 'dueDate',
        sourceValue: '"2026-08-10"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-04T00:00:00.000Z',
        localEditedAt: null,
      },
      {
        taskId: 'scout-1',
        fieldName: 'priority',
        sourceValue: '"high"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-04T00:00:00.000Z',
        localEditedAt: null,
      },
      {
        taskId: 'scout-1',
        fieldName: 'title',
        sourceValue: '"Source title"',
        locallyOverridden: 0,
        sourceObservedAt: '2026-08-04T00:00:00.000Z',
        localEditedAt: null,
      },
    ]);

    expect(() => sqlite.prepare(`
      INSERT INTO task_field_states (
        task_id, field_name, source_value, locally_overridden, updated_at
      ) VALUES ('scout-1', 'title', '"duplicate"', 0, '2026-08-05')
    `).run()).toThrow();

    sqlite.prepare("DELETE FROM tasks WHERE id = 'scout-1'").run();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM task_field_states').get()).toEqual({ count: 0 });
    sqlite.close();
  });
});
