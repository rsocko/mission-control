import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('GitHub shadow identity migration', () => {
  it('upgrades a legacy-only database additively and idempotently', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        title TEXT NOT NULL,
        sync_status TEXT
      );
      CREATE TABLE source_lists (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL
      );
      CREATE TABLE task_projects (task_id TEXT NOT NULL, project_id TEXT NOT NULL);
      CREATE TABLE task_schedules (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
      CREATE TABLE task_tags (task_id TEXT NOT NULL, tag_id TEXT NOT NULL);
      CREATE TABLE task_dependencies (task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL);
      CREATE TABLE project_phase_items (id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE my_day_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, date TEXT NOT NULL);
      CREATE TABLE focus_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scope TEXT NOT NULL);
      CREATE TABLE task_history_events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL);
      CREATE TABLE task_attachments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE task_linked_sources (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        source_id TEXT NOT NULL
      );

      INSERT INTO connector_configs VALUES
        ('github-existing', 'github-issues', NULL),
        ('github-deleted', 'github-issues', '2026-08-01T00:00:00Z'),
        ('todo-existing', 'microsoft-todo', NULL);
      INSERT INTO tasks VALUES
        ('task-1', 'owner/repo:1', 'github-existing', 'Issue', 'pending_push'),
        ('task-2', 'owner/repo:2', 'github-existing', 'Dependency', 'synced');
      INSERT INTO source_lists VALUES ('list-1', 'owner/repo', 'github-existing');
      INSERT INTO task_projects VALUES ('task-1', 'project-1');
      INSERT INTO task_schedules VALUES ('schedule-1', 'task-1');
      INSERT INTO task_tags VALUES ('task-1', 'tag-1');
      INSERT INTO task_dependencies VALUES ('task-1', 'task-2');
      INSERT INTO project_phase_items VALUES ('phase-item-1', 'phase-1', 'task-1');
      INSERT INTO my_day_items VALUES ('my-day-1', 'task-1', '2026-08-08');
      INSERT INTO focus_items VALUES ('focus-1', 'task-1', 'today');
      INSERT INTO task_history_events VALUES (1, 'task-1', 'created');
      INSERT INTO task_attachments VALUES ('attachment-1', 'task-1', 'proof.txt');
      INSERT INTO task_linked_sources VALUES ('linked-1', 'task-1', 'todo-existing', 'todo:1');
    `);

    const migrationFolder = createMigrationFolder();
    _runMigrationsIndividually(sqlite, migrationFolder);
    _runMigrationsIndividually(sqlite, migrationFolder);

    expect(sqlite.prepare(`
      SELECT connector_instance_id, phase
      FROM github_identity_migrations
      ORDER BY connector_instance_id
    `).all()).toEqual([
      { connector_instance_id: 'github-existing', phase: 'disabled' },
    ]);
    expect(sqlite.prepare('SELECT id, source_id, title, sync_status FROM tasks ORDER BY id').all()).toEqual([
      { id: 'task-1', source_id: 'owner/repo:1', title: 'Issue', sync_status: 'pending_push' },
      { id: 'task-2', source_id: 'owner/repo:2', title: 'Dependency', sync_status: 'synced' },
    ]);
    expect(sqlite.prepare('SELECT * FROM source_lists').all()).toEqual([
      { id: 'list-1', source_id: 'owner/repo', connector_instance_id: 'github-existing' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_projects').all()).toEqual([
      { task_id: 'task-1', project_id: 'project-1' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_schedules').all()).toEqual([
      { id: 'schedule-1', task_id: 'task-1' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_tags').all()).toEqual([
      { task_id: 'task-1', tag_id: 'tag-1' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_dependencies').all()).toEqual([
      { task_id: 'task-1', depends_on_task_id: 'task-2' },
    ]);
    expect(sqlite.prepare('SELECT * FROM project_phase_items').all()).toEqual([
      { id: 'phase-item-1', phase_id: 'phase-1', task_id: 'task-1' },
    ]);
    expect(sqlite.prepare('SELECT * FROM my_day_items').all()).toEqual([
      { id: 'my-day-1', task_id: 'task-1', date: '2026-08-08' },
    ]);
    expect(sqlite.prepare('SELECT * FROM focus_items').all()).toEqual([
      { id: 'focus-1', task_id: 'task-1', scope: 'today' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_history_events').all()).toEqual([
      { id: 1, task_id: 'task-1', event_type: 'created' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_attachments').all()).toEqual([
      { id: 'attachment-1', task_id: 'task-1', name: 'proof.txt' },
    ]);
    expect(sqlite.prepare('SELECT * FROM task_linked_sources').all()).toEqual([
      {
        id: 'linked-1',
        task_id: 'task-1',
        connector_instance_id: 'todo-existing',
        source_id: 'todo:1',
      },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS value FROM __drizzle_migrations').get()).toEqual({ value: 1 });
    sqlite.close();
  });

  it('creates the required uniqueness and indexed lookup plans', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        deleted_at TEXT
      );
      INSERT INTO connector_configs VALUES ('github-1', 'github-issues', NULL);
    `);
    applyMigration(sqlite);
    sqlite.exec(`
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id,
        identity_version, next_locator_revision, first_seen_at, last_seen_at
      ) VALUES (
        'entity-1', 'github', 'github.com', 'issue', 'I_1',
        1, 2, '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z'
      );
      INSERT INTO external_entity_bindings (
        id, external_entity_id, connector_instance_id, binding_type, local_id,
        state, verified_at, created_at, updated_at
      ) VALUES (
        'binding-1', 'entity-1', 'github-1', 'task', 'task-1',
        'shadow', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z'
      );
    `);

    const entityPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM external_entities
      WHERE provider = 'github'
        AND host_key = 'github.com'
        AND entity_type = 'issue'
        AND stable_id = 'I_1'
    `).all() as Array<{ detail: string }>;
    const bindingPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT local_id FROM external_entity_bindings
      WHERE connector_instance_id = 'github-1'
        AND external_entity_id = 'entity-1'
    `).all() as Array<{ detail: string }>;

    expect(entityPlan.some((row) => row.detail.includes('idx_external_entities_identity'))).toBe(true);
    expect(bindingPlan.some((row) => row.detail.includes('idx_external_bindings_entity'))).toBe(true);
    expect(() => sqlite.exec(`
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id,
        identity_version, next_locator_revision, first_seen_at, last_seen_at
      ) VALUES (
        'entity-duplicate', 'github', 'github.com', 'issue', 'I_1',
        1, 1, '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z'
      )
    `)).toThrow();
    expect(() => sqlite.exec(`
      INSERT INTO external_entity_bindings (
        id, external_entity_id, connector_instance_id, binding_type, local_id,
        state, created_at, updated_at
      ) VALUES (
        'binding-duplicate', 'entity-1', 'github-1', 'task', 'task-2',
        'shadow', '2026-08-08T00:00:00Z', '2026-08-08T00:00:00Z'
      )
    `)).toThrow();
    sqlite.close();
  });
});

function createMigrationFolder(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mc-github-identity-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'meta'));
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0065_github_shadow_identities.sql'),
    'utf8',
  );
  writeFileSync(join(directory, '0065_github_shadow_identities.sql'), migration);
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({
    entries: [{
      idx: 64,
      tag: '0065_github_shadow_identities',
      when: 1,
    }],
  }));
  return directory;
}

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0065_github_shadow_identities.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (!statement.trim()) continue;
    try {
      sqlite.exec(statement);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }
  }
}
