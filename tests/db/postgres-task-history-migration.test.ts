import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = resolve(process.cwd(), 'drizzle/postgres');
const migrationName = '0015_task_history_capture';

describe('PostgreSQL task-history capture migration', () => {
  it('is registered after the RyMessage reconciliation migration', () => {
    const journal = JSON.parse(readFileSync(
      resolve(migrationDirectory, 'meta/_journal.json'),
      'utf8',
    )) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
      idx: 15,
      tag: migrationName,
    }));
  });

  it('captures every tracked field and project/phase membership at the database boundary', () => {
    const sql = readFileSync(
      resolve(migrationDirectory, `${migrationName}.sql`),
      'utf8',
    );

    for (const fn of [
      'task_history_task_insert',
      'task_history_task_update',
      'task_history_project_membership',
      'task_history_phase_membership',
    ]) {
      expect(sql, fn).toContain(`CREATE OR REPLACE FUNCTION ${fn}(`);
    }

    for (const trigger of [
      'task_history_task_insert',
      'task_history_task_update',
      'task_history_project_insert',
      'task_history_project_update',
      'task_history_project_delete',
      'task_history_phase_insert',
      'task_history_phase_update',
      'task_history_phase_delete',
    ]) {
      expect(sql, trigger).toContain(`CREATE TRIGGER ${trigger}`);
    }

    for (const eventType of [
      'baseline',
      'status_changed',
      'reopened',
      'micro_status_changed',
      'kanban_column_changed',
      'effort_changed',
      'local_disposition_changed',
      'project_added',
      'project_removed',
      'phase_added',
      'phase_removed',
    ]) {
      expect(sql, eventType).toContain(`'${eventType}'`);
    }
    expect(sql).toContain(
      `current_setting('mission_control.suppress_task_history', true) = 'on'`,
    );
  });

  it('repairs missing baselines, stale fields, and both directions of membership drift', () => {
    const sql = readFileSync(
      resolve(migrationDirectory, `${migrationName}.sql`),
      'utf8',
    );

    expect(sql).toContain(`history.event_type = 'baseline'`);
    expect(sql).toContain(`latest.value IS DISTINCT FROM task.status`);
    expect(sql).toContain(`latest.value IS DISTINCT FROM task.local_disposition`);
    expect(sql).toContain(`Current project membership was absent from PostgreSQL history`);
    expect(sql).toContain(`Historical project membership was absent from current state`);
    expect(sql).toContain(`Current phase membership was absent from PostgreSQL history`);
    expect(sql).toContain(`Historical phase membership was absent from current state`);
  });

  it('suppresses synthetic trigger events while importing authoritative SQLite history', () => {
    const importer = readFileSync(
      resolve(process.cwd(), 'scripts/lib/sqlite-to-postgres-import.ts'),
      'utf8',
    );

    expect(importer).toContain(
      `set_config('mission_control.suppress_task_history', 'on', true)`,
    );
  });
});
