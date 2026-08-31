import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import {
  createSqliteCorePersistenceRepositories,
} from '@/db/persistence/sqlite-core-repositories';
import {
  coreConnectorFixture,
  coreNotificationFixture,
  coreProjectFixture,
  coreTaskFixture,
  describeCorePersistenceRepositoriesContract,
} from '../contracts/core-persistence-repositories.contract';

function createHarness() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      local_disposition TEXT NOT NULL,
      priority TEXT NOT NULL,
      planning_horizon TEXT,
      due_date TEXT,
      push_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      parent_id TEXT,
      depth INTEGER NOT NULL,
      is_checklist_item INTEGER NOT NULL,
      source_list_id TEXT,
      source_list_name TEXT,
      assignee TEXT,
      micro_status TEXT,
      status_reason TEXT,
      metadata TEXT NOT NULL,
      sync_status TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      kanban_column TEXT,
      kanban_order REAL,
      snoozed_until TEXT,
      effort INTEGER
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT,
      color TEXT,
      confirmed INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE task_tags (
      task_id TEXT NOT NULL,
      tag_id TEXT NOT NULL
    );
    CREATE TABLE task_projects (
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL
    );
    CREATE TABLE task_schedules (task_id TEXT NOT NULL);
    CREATE TABLE task_field_states (task_id TEXT NOT NULL);
    CREATE TABLE my_day_items (task_id TEXT NOT NULL);
    CREATE TABLE my_day_exclusions (task_id TEXT NOT NULL);
    CREATE TABLE focus_items (task_id TEXT NOT NULL);
    CREATE TABLE weekly_one_thing (task_id TEXT NOT NULL);
    CREATE TABLE priority_sync_log (task_id TEXT NOT NULL);
    CREATE TABLE task_triage_log (task_id TEXT NOT NULL);
    CREATE TABLE quick_sort_operations (task_id TEXT NOT NULL);
    CREATE TABLE task_linked_sources (task_id TEXT NOT NULL);
    CREATE TABLE task_attachments (task_id TEXT NOT NULL);
    CREATE TABLE sync_deletion_candidates (task_id TEXT NOT NULL);
    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL
    );
    CREATE TABLE hub_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL,
      icon TEXT,
      icon_color TEXT,
      source_bindings TEXT NOT NULL,
      auto_include_rules TEXT NOT NULL,
      kanban_columns TEXT NOT NULL,
      default_view TEXT NOT NULL,
      default_filters TEXT,
      status TEXT NOT NULL,
      status_override TEXT,
      hidden INTEGER NOT NULL,
      category TEXT,
      target_date TEXT,
      started_at TEXT,
      completed_at TEXT,
      sort_order REAL NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_tags (
      project_id TEXT NOT NULL,
      tag_id TEXT NOT NULL
    );
    CREATE TABLE project_auto_include_exclusions (
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL
    );
    CREATE TABLE project_phases (
      id TEXT PRIMARY KEY,
      project_id TEXT
    );
    CREATE TABLE project_phase_items (
      phase_id TEXT NOT NULL,
      task_id TEXT NOT NULL
    );
    CREATE TABLE project_milestones (project_id TEXT NOT NULL);
    CREATE TABLE connector_configs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      sync_mode TEXT NOT NULL,
      poll_interval_minutes INTEGER,
      capabilities TEXT NOT NULL,
      credentials TEXT NOT NULL,
      settings TEXT NOT NULL,
      synced_lists TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      level TEXT NOT NULL,
      level_rank INTEGER NOT NULL,
      category TEXT NOT NULL,
      template_key TEXT,
      state TEXT NOT NULL,
      read_state TEXT NOT NULL,
      disposition TEXT NOT NULL,
      source_state TEXT NOT NULL,
      sync_state TEXT NOT NULL,
      read_at TEXT,
      handled_at TEXT,
      dismissed_at TEXT,
      resolved_at TEXT,
      archived_at TEXT,
      muted_at TEXT,
      snoozed_until TEXT,
      source_resolved_at TEXT,
      last_source_activity_at TEXT,
      last_source_activity_key TEXT,
      handled_source_activity_at TEXT,
      handled_source_activity_key TEXT,
      last_source_synced_at TEXT,
      is_actionable INTEGER NOT NULL,
      primary_action_id TEXT,
      ai_suggested_action_id TEXT,
      received_at TEXT NOT NULL,
      sort_at TEXT NOT NULL,
      expires_at TEXT,
      group_key TEXT,
      dedupe_key TEXT,
      related_task_id TEXT,
      related_project_id TEXT,
      related_entity_type TEXT,
      related_entity_id TEXT,
      navigation_target TEXT,
      metadata TEXT NOT NULL,
      presentation TEXT NOT NULL
    );
    CREATE TABLE notification_actions (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      label TEXT NOT NULL,
      icon TEXT,
      variant TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      payload TEXT NOT NULL,
      opens_external INTEGER NOT NULL,
      requires_confirmation INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      execution_state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    sqlite,
    repositories: createSqliteCorePersistenceRepositories(sqlite),
    close: () => sqlite.close(),
  };
}

describeCorePersistenceRepositoriesContract('SQLite', createHarness);

describe('SQLite core repository compatibility behavior', () => {
  it('reads legacy connector configuration with double-encoded JSON', async () => {
    const harness = createHarness();
    try {
      await harness.repositories.connectors.upsert(coreConnectorFixture);
      harness.sqlite.prepare(`
        UPDATE connector_configs
        SET capabilities = ?, credentials = ?, settings = ?, synced_lists = ?
        WHERE id = ?
      `).run(
        JSON.stringify(JSON.stringify(coreConnectorFixture.capabilities)),
        JSON.stringify(JSON.stringify(coreConnectorFixture.credentials)),
        JSON.stringify(JSON.stringify(coreConnectorFixture.settings)),
        JSON.stringify(JSON.stringify(coreConnectorFixture.syncedLists)),
        coreConnectorFixture.id,
      );

      await expect(harness.repositories.connectors.get(coreConnectorFixture.id))
        .resolves.toEqual(coreConnectorFixture);
    } finally {
      harness.close();
    }
  });

  it('operates against the production SQLite bootstrap schema', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
      const repositories = createSqliteCorePersistenceRepositories(sqlite);

      await repositories.projects.upsert(coreProjectFixture);
      await repositories.connectors.upsert(coreConnectorFixture);
      await repositories.tasks.upsert(coreTaskFixture);
      await repositories.notifications.upsert(coreNotificationFixture);
      await repositories.settings.set('core-contract-smoke', { ready: true });

      await expect(repositories.tasks.get(coreTaskFixture.id))
        .resolves.toMatchObject(coreTaskFixture);
      await expect(repositories.settings.get('core-contract-smoke'))
        .resolves.toEqual({ ready: true });
    } finally {
      sqlite.close();
    }
  });

  it('cleans task dependents and detaches descendants atomically', async () => {
    const harness = createHarness();
    try {
      const parent = { ...coreTaskFixture };
      await harness.repositories.tasks.upsert(parent);
      await harness.repositories.tasks.upsert({
        ...parent,
        id: 'task-child',
        sourceId: 'source-child',
        parentId: parent.id,
        depth: 1,
        hubProjectIds: [],
        tags: [],
      });
      const dependentTables = [
        'task_schedules',
        'task_field_states',
        'my_day_items',
        'my_day_exclusions',
        'focus_items',
        'weekly_one_thing',
        'priority_sync_log',
        'task_triage_log',
        'quick_sort_operations',
        'task_linked_sources',
        'task_attachments',
        'sync_deletion_candidates',
      ];
      for (const table of dependentTables) {
        harness.sqlite.prepare(`INSERT INTO ${table} (task_id) VALUES (?)`)
          .run(parent.id);
      }
      harness.sqlite.prepare(`
        INSERT INTO project_auto_include_exclusions (project_id, task_id)
        VALUES ('project-portable', ?)
      `).run(parent.id);
      harness.sqlite.prepare(`
        INSERT INTO project_phase_items (phase_id, task_id)
        VALUES ('phase-portable', ?)
      `).run(parent.id);
      harness.sqlite.prepare(`
        INSERT INTO task_dependencies (task_id, depends_on_task_id)
        VALUES (?, 'task-child')
      `).run(parent.id);

      await expect(harness.repositories.tasks.delete(parent.id)).resolves.toBe(true);
      for (const table of dependentTables) {
        expect(harness.sqlite.prepare(`SELECT 1 FROM ${table}`).get()).toBeUndefined();
      }
      expect(harness.sqlite.prepare(
        'SELECT 1 FROM project_auto_include_exclusions',
      ).get()).toBeUndefined();
      expect(harness.sqlite.prepare('SELECT 1 FROM project_phase_items').get())
        .toBeUndefined();
      expect(harness.sqlite.prepare('SELECT 1 FROM task_dependencies').get())
        .toBeUndefined();
      expect(harness.sqlite.prepare(
        'SELECT parent_id AS parentId, depth FROM tasks WHERE id = ?',
      ).get('task-child')).toEqual({ parentId: null, depth: 0 });
    } finally {
      harness.close();
    }
  });

  it('cleans project-owned records atomically', async () => {
    const harness = createHarness();
    try {
      await harness.repositories.projects.upsert(coreProjectFixture);
      harness.sqlite.prepare(`
        INSERT INTO project_phases (id, project_id) VALUES ('phase-portable', ?)
      `).run(coreProjectFixture.id);
      harness.sqlite.prepare(`
        INSERT INTO project_phase_items (phase_id, task_id)
        VALUES ('phase-portable', 'task-portable')
      `).run();
      harness.sqlite.prepare(`
        INSERT INTO project_auto_include_exclusions (project_id, task_id)
        VALUES (?, 'task-portable')
      `).run(coreProjectFixture.id);
      harness.sqlite.prepare(
        'INSERT INTO project_milestones (project_id) VALUES (?)',
      ).run(coreProjectFixture.id);

      await expect(harness.repositories.projects.delete(coreProjectFixture.id))
        .resolves.toBe(true);
      for (const table of [
        'project_phases',
        'project_phase_items',
        'project_auto_include_exclusions',
        'project_milestones',
      ]) {
        expect(harness.sqlite.prepare(`SELECT 1 FROM ${table}`).get()).toBeUndefined();
      }
    } finally {
      harness.close();
    }
  });

  it('does not rewrite running or completed notification actions', async () => {
    const harness = createHarness();
    try {
      await harness.repositories.notifications.upsert(coreNotificationFixture);
      harness.sqlite.prepare(`
        UPDATE notification_actions
        SET execution_state = 'completed'
        WHERE id = 'action-portable'
      `).run();

      await harness.repositories.notifications.upsert({
        ...coreNotificationFixture,
        actions: [{
          ...coreNotificationFixture.actions![0],
          label: 'Mutated',
          payload: { changed: true },
        }],
      });
      await expect(harness.repositories.notifications.upsert({
        ...coreNotificationFixture,
        actions: [{
          ...coreNotificationFixture.actions![0],
          notificationId: 'different-notification',
        }],
      })).rejects.toThrow('belongs to another notification');

      expect(harness.sqlite.prepare(`
        SELECT
          notification_id AS notificationId,
          label,
          payload,
          execution_state AS executionState
        FROM notification_actions
        WHERE id = 'action-portable'
      `).get()).toEqual({
        notificationId: coreNotificationFixture.id,
        label: 'Open',
        payload: '{"url":"/portable"}',
        executionState: 'completed',
      });
    } finally {
      harness.close();
    }
  });
});

describe('core persistence runtime selection', () => {
  it('registers one composition before first use and rejects replacement', async () => {
    vi.resetModules();
    const {
      getCorePersistenceRepositories,
      registerCorePersistenceRepositories,
    } = await import('@/lib/persistence/runtime');
    const selected = createHarness();
    const replacement = createHarness();
    try {
      registerCorePersistenceRepositories(selected.repositories);
      expect(getCorePersistenceRepositories()).toBe(selected.repositories);
      expect(() => registerCorePersistenceRepositories(selected.repositories))
        .not.toThrow();
      expect(() => registerCorePersistenceRepositories(replacement.repositories))
        .toThrow('Core persistence repositories are already selected');
    } finally {
      selected.close();
      replacement.close();
    }
  });

  it('registers the complete worker composition and rejects split replacement', async () => {
    vi.resetModules();
    const {
      getWorkerPersistenceRepositories,
      registerWorkerPersistenceRepositories,
    } = await import('@/lib/persistence/worker-runtime');
    const selected = createHarness();
    const replacement = createHarness();
    const selectedWorker = {
      connectors: selected.repositories.connectors,
      syncRuns: {
        listLatestSuccessfulPulls: async () => [],
        append: async () => undefined,
      },
      execution: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['execution'],
      github: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['github'],
      connectorState: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['connectorState'],
    };
    const replacementWorker = {
      connectors: replacement.repositories.connectors,
      syncRuns: selectedWorker.syncRuns,
      execution: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['execution'],
      github: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['github'],
      connectorState: {} as import('@/db/persistence/worker-repositories').WorkerPersistenceRepositories['connectorState'],
    };
    try {
      registerWorkerPersistenceRepositories(selectedWorker);
      await expect(getWorkerPersistenceRepositories()).resolves.toBe(selectedWorker);
      expect(() => registerWorkerPersistenceRepositories(selectedWorker))
        .not.toThrow();
      expect(() => registerWorkerPersistenceRepositories(replacementWorker))
        .toThrow('Worker persistence repositories are already selected');
    } finally {
      selected.close();
      replacement.close();
    }
  });
});
