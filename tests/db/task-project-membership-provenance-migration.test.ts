import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    join(process.cwd(), 'drizzle', '0154_cuddly_talisman.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function commandRequest(command: Record<string, unknown>): string {
  return JSON.stringify({
    commandId: randomUUID(),
    expectedRevision: 0,
    command,
  });
}

describe('task project membership provenance migration', () => {
  it('classifies sync links and restores the latest audited user intent', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (id text PRIMARY KEY);
      CREATE TABLE hub_projects (id text PRIMARY KEY, metadata text NOT NULL);
      CREATE TABLE task_projects (
        task_id text NOT NULL,
        project_id text NOT NULL,
        UNIQUE(task_id, project_id)
      );
      CREATE TABLE project_auto_include_exclusions (
        project_id text NOT NULL,
        task_id text NOT NULL,
        excluded_at text NOT NULL,
        UNIQUE(project_id, task_id)
      );
      CREATE TABLE project_hierarchy_commands (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        result_revision integer NOT NULL,
        command_type text NOT NULL,
        request_json text NOT NULL,
        actor_type text NOT NULL,
        created_at text NOT NULL
      );

      INSERT INTO tasks (id) VALUES
        ('remote-only'),
        ('restore-me'),
        ('remove-me'),
        ('restored-by-undo');
      INSERT INTO hub_projects (id, metadata)
      VALUES ('gh-project:connector:17', '{"syncManaged":true}');
      INSERT INTO task_projects (task_id, project_id) VALUES
        ('remote-only', 'gh-project:connector:17'),
        ('remove-me', 'gh-project:connector:17');
    `);

    const insertCommand = sqlite.prepare(`
      INSERT INTO project_hierarchy_commands (
        id, project_id, result_revision, command_type,
        request_json, actor_type, created_at
      ) VALUES (?, 'gh-project:connector:17', ?, ?, ?, 'user', ?)
    `);
    insertCommand.run(
      'assign-restore',
      1,
      'assign_tasks',
      commandRequest({ type: 'assign_tasks', taskIds: ['restore-me'] }),
      '2026-03-01T10:00:00.000Z',
    );
    insertCommand.run(
      'assign-remove',
      2,
      'assign_tasks',
      commandRequest({ type: 'assign_tasks', taskIds: ['remove-me'] }),
      '2026-03-01T10:01:00.000Z',
    );
    insertCommand.run(
      'remove-latest',
      3,
      'remove_tasks',
      commandRequest({ type: 'remove_tasks', taskIds: ['remove-me'] }),
      '2026-03-01T10:02:00.000Z',
    );
    insertCommand.run(
      'restore-undo',
      4,
      'restore_project_tasks',
      commandRequest({
        type: 'restore_project_tasks',
        states: [{
          taskId: 'restored-by-undo',
          member: true,
          excludedAt: null,
          placement: null,
        }],
      }),
      '2026-03-01T10:03:00.000Z',
    );

    applyMigration(sqlite);

    const memberships = sqlite.prepare(`
      SELECT task_id AS taskId, provenance
      FROM task_projects
      ORDER BY task_id
    `).all();
    expect(memberships).toEqual([
      { taskId: 'remote-only', provenance: 'github-sync' },
      { taskId: 'restore-me', provenance: 'local' },
      { taskId: 'restored-by-undo', provenance: 'local' },
    ]);
    expect(sqlite.prepare(`
      SELECT task_id AS taskId
      FROM project_auto_include_exclusions
      ORDER BY task_id
    `).all()).toEqual([{ taskId: 'remove-me' }]);

    sqlite.close();
  });
});
