import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import type { GraphReportingPersistence } from '@/db/persistence/graph-reporting';
import { createSqliteGraphReportingRepository } from '@/db/persistence/sqlite-graph-reporting-repository';
import type { TaskFilterSpec } from '@/lib/tasks/core/contracts';
import { saveUniverseCluster } from '@/lib/graph/universe-cluster-save';

export interface GraphReportingHarness {
  repository: GraphReportingPersistence;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  close(): void | Promise<void>;
}

const NOW = '2026-09-05T12:00:00.000Z';
const filterSpec: TaskFilterSpec = {
  connectorTypes: [],
  statuses: [],
  priorities: [],
  planningHorizons: [],
  planningHorizonIsNull: false,
  localDispositions: [],
  excludeClosedStatuses: false,
  openOnly: false,
  parentOnly: true,
  sourceListIds: [],
  sourceListGroupId: null,
  createdAtMax: null,
  createdAtMin: null,
  filterQuery: null,
  tagSlug: null,
  tagSlugs: [],
  projectId: null,
  quickFilter: null,
  myDayDate: '2026-09-05',
  today: '2026-09-05',
  weekFromNow: '2026-09-12',
  recentCutoff: '2026-08-29',
};
const filterInputs = {
  myDayTaskIds: [],
  assignedGitHubUsernames: [],
  inboxListEntries: [],
};

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source_id: id,
    connector_type: 'local',
    connector_instance_id: 'connector-live',
    title: `Task ${id}`,
    created_at: NOW,
    updated_at: NOW,
    last_synced_at: NOW,
    ...overrides,
  };
}

function project(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Project ${id}`,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function describeGraphReportingRepositoryContract(
  name: string,
  createHarness: () => GraphReportingHarness | Promise<GraphReportingHarness>,
): void {
  describe(`${name} graph reporting repository contract`, () => {
    let harness: GraphReportingHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.insert('connector_configs', {
        id: 'connector-live',
        type: 'local',
        name: 'Live',
        capabilities: '{}',
        created_at: NOW,
        updated_at: NOW,
      });
      await harness.insert('connector_configs', {
        id: 'connector-deleted',
        type: 'local',
        name: 'Deleted',
        capabilities: '{}',
        deleted_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      });
    });

    afterEach(async () => {
      await harness.close();
    });

    it('returns empty scopes and filters invisible tasks in deterministic order', async () => {
      expect((await harness.repository.projects.read('missing')).project).toBeNull();
      expect((await harness.repository.burn.read({
        projectId: 'missing',
        endExclusive: '2026-09-06T00:00:00.000Z',
      })).scope).toBeNull();

      await harness.insert('tasks', task('z-task'));
      await harness.insert('tasks', task('a-task'));
      await harness.insert('tasks', task('deleted-task', {
        connector_instance_id: 'connector-deleted',
      }));
      await harness.insert('tasks', task('notification-task', {
        connector_type: 'outlook-email',
      }));
      await harness.insert('tasks', task('child-task', { parent_id: 'a-task' }));

      const universe = await harness.repository.universe.read({
        spec: filterSpec,
        filterInputs,
        maxNodes: 20,
        includeTags: false,
        includeProjects: false,
      });
      expect(universe.tasks.map(({ id }) => id)).toEqual(['a-task', 'z-task']);
      expect(universe.filteredTaskCount).toBe(2);
      expect(await harness.repository.universe.listEligibleTaskIds({
        spec: filterSpec,
        filterInputs,
        taskIds: ['z-task', 'deleted-task', 'a-task'],
      })).toEqual(['a-task', 'z-task']);
    });

    it('returns project graph, overview membership, and tags as plain data', async () => {
      await harness.insert('hub_projects', project('project-1'));
      await harness.insert('tasks', task('task-1'));
      await harness.insert('task_projects', { task_id: 'task-1', project_id: 'project-1' });
      await harness.insert('project_phases', {
        id: 'phase-1',
        project_id: 'project-1',
        name: 'Build',
        created_at: NOW,
        updated_at: NOW,
      });
      await harness.insert('project_phase_items', {
        id: 'item-1',
        phase_id: 'phase-1',
        task_id: 'task-1',
        created_at: NOW,
      });
      await harness.insert('tags', {
        id: 'tag-1',
        name: 'Focus',
        slug: 'focus',
        type: 'hub',
        created_at: NOW,
      });
      await harness.insert('project_tags', { project_id: 'project-1', tag_id: 'tag-1' });
      await harness.insert('task_tags', { task_id: 'task-1', tag_id: 'tag-1' });

      const graph = await harness.repository.projects.read('project-1');
      expect(graph.project?.id).toBe('project-1');
      expect(graph.phases.map(({ id }) => id)).toEqual(['phase-1']);
      expect(graph.tasks.map(({ id }) => id)).toEqual(['task-1']);
      expect(graph.phaseItems).toEqual([{ phaseId: 'phase-1', taskId: 'task-1' }]);

      const overview = await harness.repository.overview.read();
      expect(overview.memberships).toEqual([{ projectId: 'project-1', taskId: 'task-1' }]);
      expect(overview.tags[0]).toMatchObject({
        projectId: 'project-1',
        id: 'tag-1',
        confirmed: true,
      });

      const aggregate = await harness.repository.neighbors.readAggregate({
        ref: { kind: 'tag', id: 'tag-1' },
        limit: 10,
      });
      expect(aggregate.center).toMatchObject({ kind: 'tag', row: { id: 'tag-1' } });
      expect(aggregate.tasks.map(({ id }) => id)).toEqual(['task-1']);
      const neighbors = await harness.repository.neighbors.readTask({
        taskId: 'task-1',
        dependencyLimit: 10,
        includeExplicit: true,
        includeDerived: true,
      });
      expect(neighbors.projects.map(({ id }) => id)).toEqual(['project-1']);
      expect(neighbors.phases.map(({ id }) => id)).toEqual(['phase-1']);
      expect(neighbors.tags.map(({ id }) => id)).toEqual(['tag-1']);
    });

    it('validates dependency membership, duplicates, and global blocking cycles atomically', async () => {
      await harness.insert('hub_projects', project('project-1'));
      for (const id of ['task-a', 'task-b', 'task-c']) {
        await harness.insert('tasks', task(id));
      }
      await harness.insert('task_projects', { task_id: 'task-a', project_id: 'project-1' });
      await harness.insert('task_projects', { task_id: 'task-b', project_id: 'project-1' });

      const created = await harness.repository.projects.createDependency({
        projectId: 'project-1',
        sourceTaskId: 'task-a',
        targetTaskId: 'task-b',
        type: 'blocks',
        id: 'dependency-1',
        createdAt: NOW,
      });
      expect(created.kind).toBe('created');
      expect((await harness.repository.projects.createDependency({
        projectId: 'project-1',
        sourceTaskId: 'task-a',
        targetTaskId: 'task-b',
        type: 'blocks',
        id: 'dependency-2',
        createdAt: NOW,
      })).kind).toBe('duplicate');
      expect((await harness.repository.projects.createDependency({
        projectId: 'project-1',
        sourceTaskId: 'task-b',
        targetTaskId: 'task-a',
        type: 'blocks',
        id: 'dependency-3',
        createdAt: NOW,
      })).kind).toBe('cycle');
      expect((await harness.repository.projects.createDependency({
        projectId: 'project-1',
        sourceTaskId: 'task-a',
        targetTaskId: 'task-c',
        type: 'related',
        id: 'dependency-4',
        createdAt: NOW,
      })).kind).toBe('missing-project-membership');
    });

    it('reconstructs burn membership from baseline JSON and records cluster tag audits', async () => {
      await harness.insert('hub_projects', project('project-1', {
        started_at: '2026-09-01',
        target_date: '2026-09-30',
      }));
      await harness.insert('tasks', task('task-1'));
      await harness.insert('task_history_events', {
        task_id: 'task-1',
        event_type: 'baseline',
        new_value: JSON.stringify({
          status: 'todo',
          projectIds: ['project-1'],
          phaseIds: [],
        }),
        occurred_at: NOW,
        recorded_at: NOW,
        provenance: 'migration_baseline',
      });

      const burn = await harness.repository.burn.read({
        projectId: 'project-1',
        endExclusive: '2026-09-06T00:00:00.000Z',
      });
      expect(burn.scope).toMatchObject({ scope: 'project', scopeId: 'project-1' });
      expect(burn.candidateEvents.map(({ taskId }) => taskId)).toEqual(['task-1']);

      await harness.insert('hub_projects', project('project-owned', {
        metadata: JSON.stringify({ universeClusterCreationToken: 'owner-token' }),
      }));
      await harness.insert('tasks', task('task-owned'));
      await harness.insert('task_projects', {
        task_id: 'task-owned',
        project_id: 'project-owned',
      });
      expect(await harness.repository.clusterSave.deleteProjectIfCreationToken({
        projectId: 'project-owned',
        creationToken: 'other-token',
      })).toEqual({ deleted: false, affectedTaskIds: [] });
      expect(await harness.repository.clusterSave.findProject('project-owned')).toBe(true);
      expect(await harness.repository.clusterSave.deleteProjectIfCreationToken({
        projectId: 'project-owned',
        creationToken: 'owner-token',
      })).toEqual({ deleted: true, affectedTaskIds: ['task-owned'] });
      expect(await harness.repository.clusterSave.findProject('project-owned')).toBe(false);

      const first = await harness.repository.clusterSave.createTag({
        id: 'tag-cluster',
        name: 'Cluster',
        slug: 'cluster',
        color: '#3b82f6',
        createdAt: NOW,
      });
      const replay = await harness.repository.clusterSave.createTag({
        id: 'tag-other',
        name: 'Cluster',
        slug: 'cluster',
        color: '#3b82f6',
        createdAt: NOW,
      });
      expect(first).toEqual({ id: 'tag-cluster', created: true });
      expect(replay).toEqual({ id: 'tag-cluster', created: false });
      await harness.repository.clusterSave.recordTagAudit({
        tagId: first.id,
        taskIds: ['task-1'],
        clusterId: 'cluster-1',
        projectionFingerprint: 'fingerprint',
        now: NOW,
      });
      const refreshed = await harness.repository.burn.read({
        projectId: 'project-1',
        endExclusive: '2026-09-06T00:00:00.000Z',
      });
      expect(refreshed.candidateEvents.some(
        ({ eventType }) => eventType === 'universe_cluster_saved',
      )).toBe(true);
    });

    it('preserves partial tag assignment and project rollback outcomes', async () => {
      const addTagToTask = vi.fn(async (taskId: string) => {
        if (taskId === 'task-b') throw new Error('rejected');
      });
      const partial = await saveUniverseCluster({
        destination: 'tag',
        name: 'Cluster',
        taskIds: ['task-b', 'task-a'],
        clusterId: 'cluster-1',
        projectionFingerprint: 'fingerprint',
      }, {
        authorizeTaskIds: async (ids) => [...ids],
        createProject: async () => 'project-1',
        assignProjectTasks: async () => undefined,
        rollbackProject: async () => undefined,
        createTag: async () => 'tag-1',
        addTagToTask,
        recordTagAudit: async () => undefined,
      });
      expect(partial).toMatchObject({
        status: 'partial',
        savedTaskIds: ['task-a'],
        failures: [{ taskId: 'task-b', code: 'TAG_ASSIGNMENT_FAILED' }],
      });

      const rolledBack = await saveUniverseCluster({
        destination: 'project',
        name: 'Cluster',
        taskIds: ['task-a'],
        clusterId: 'cluster-1',
        projectionFingerprint: 'fingerprint',
      }, {
        authorizeTaskIds: async (ids) => [...ids],
        createProject: async () => 'project-1',
        assignProjectTasks: async () => { throw new Error('assignment failed'); },
        rollbackProject: async () => { throw new Error('rollback failed'); },
        createTag: async () => 'tag-1',
        addTagToTask: async () => undefined,
        recordTagAudit: async () => undefined,
      });
      expect(rolledBack).toMatchObject({
        status: 'partial',
        failures: [{ code: 'PROJECT_ROLLBACK_FAILED' }],
      });
    });
  });
}

export function describeSqliteGraphReportingRepositoryContract(): void {
  describeGraphReportingRepositoryContract('SQLite', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}', deleted_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, connector_type TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'todo', local_disposition TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'none', planning_horizon TEXT, due_date TEXT,
        push_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        completed_at TEXT, deleted_at TEXT, recurrence_generated_from_task_id TEXT, parent_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0, is_checklist_item INTEGER NOT NULL DEFAULT 0,
        source_list_id TEXT, source_list_name TEXT, assignee TEXT, micro_status TEXT,
        status_reason TEXT, metadata TEXT NOT NULL DEFAULT '{}', sync_status TEXT NOT NULL DEFAULT 'synced',
        last_synced_at TEXT NOT NULL, push_retry_count INTEGER NOT NULL DEFAULT 0,
        kanban_column TEXT, kanban_order REAL, snoozed_until TEXT, reminder_at TEXT,
        reminder_relative TEXT, reminder_due_time TEXT, effort INTEGER,
        is_bulk_import INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tags (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
        type TEXT NOT NULL, source TEXT, color TEXT,
        confirmed INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, unified_into TEXT
      );
      CREATE TABLE task_tags (task_id TEXT NOT NULL, tag_id TEXT NOT NULL);
      CREATE TABLE hub_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        color TEXT NOT NULL DEFAULT '#3b82f6', icon TEXT, icon_color TEXT,
        source_bindings TEXT NOT NULL DEFAULT '[]', auto_include_rules TEXT NOT NULL DEFAULT '[]',
        kanban_columns TEXT NOT NULL DEFAULT '[]', default_view TEXT NOT NULL DEFAULT 'list',
        default_filters TEXT, status TEXT NOT NULL DEFAULT 'active', status_override TEXT,
        hidden INTEGER NOT NULL DEFAULT 0, category TEXT, target_date TEXT, started_at TEXT,
        completed_at TEXT, sort_order REAL NOT NULL DEFAULT 0,
        hierarchy_revision INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_tags (project_id TEXT NOT NULL, tag_id TEXT NOT NULL);
      CREATE TABLE project_auto_include_exclusions (
        project_id TEXT NOT NULL, task_id TEXT NOT NULL
      );
      CREATE TABLE task_projects (
        task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        UNIQUE(task_id, project_id)
      );
      CREATE TABLE project_phases (
        id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'pending', color TEXT, estimated_days REAL,
        target_start TEXT, target_end TEXT, start_after_phase_id TEXT,
        sort_order REAL NOT NULL DEFAULT 0, completed_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_phase_items (
        id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, task_id TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0, estimated_effort_hours REAL,
        is_proposed INTEGER NOT NULL DEFAULT 0, proposal_type TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE task_dependencies (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'blocks', connector_instance_id TEXT,
        sync_status TEXT NOT NULL DEFAULT 'local', sync_action TEXT, sync_error TEXT,
        last_synced_at TEXT, created_at TEXT NOT NULL,
        UNIQUE(task_id, depends_on_task_id, type)
      );
      CREATE TABLE task_history_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        field_name TEXT, previous_value TEXT, new_value TEXT, project_id TEXT, phase_id TEXT,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, provenance TEXT NOT NULL,
        provenance_ref TEXT, metadata TEXT
      );
    `);
    const db = drizzle(sqlite, { schema });
    return {
      repository: createSqliteGraphReportingRepository(sqlite, db),
      async insert(table: string, row: Record<string, unknown>) {
        const columns = Object.keys(row);
        sqlite.prepare(
          `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        ).run(...columns.map((column) => {
          const value = row[column];
          if (typeof value === 'boolean') return value ? 1 : 0;
          return value ?? null;
        }));
      },
      close: () => {
        sqlite.close();
      },
    };
  });
}
