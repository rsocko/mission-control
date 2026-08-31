import { beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkTodoBridgePersistence,
} from '@/db/persistence/work-todo';
import {
  TASK_ASSOCIATION_TABLES,
  TASK_DEPENDENCY_TABLE,
  TASK_NOTIFICATION_TABLE,
} from '@/db/persistence/task-deletion';

/** Marks a seed value that must be written to a JSON/JSONB column. */
export interface JsonSeedValue {
  __json: Record<string, unknown>;
}

export interface TaskAssociationSeedRow {
  table: string;
  values: Record<string, string | number | boolean | null | JsonSeedValue>;
}

export function isJsonSeedValue(value: unknown): value is JsonSeedValue {
  return typeof value === 'object' && value !== null && '__json' in value;
}

/**
 * One row per canonical task association, plus the notification whose
 * `related_task_id` must be nulled rather than deleted. Both harnesses write
 * exactly this set, so the SQLite and PostgreSQL deletion regressions cover the
 * same rows.
 */
export function taskAssociationSeedRows(
  taskId: string,
  variant = 0,
): TaskAssociationSeedRow[] {
  const at = '2026-08-07T12:00:00.000Z';
  const day = `2026-08-${String(7 + (variant % 20)).padStart(2, '0')}`;
  return [
    { table: 'task_tags', values: { task_id: taskId, tag_id: `tag:${taskId}` } },
    {
      table: 'project_auto_include_exclusions',
      values: { project_id: `project:${taskId}`, task_id: taskId, excluded_at: at },
    },
    { table: 'task_projects', values: { task_id: taskId, project_id: `project:${taskId}` } },
    {
      table: 'task_schedules',
      values: {
        task_id: taskId,
        scheduled_date: '2026-08-07',
        scheduled_time: null,
        estimated_duration: null,
        is_time_blocked: false,
        recurrence: null,
        recurrence_mode: 'schedule',
      },
    },
    {
      table: 'task_field_states',
      values: {
        task_id: taskId,
        field_name: 'title',
        source_value: 'Remote title',
        locally_overridden: false,
        updated_at: at,
      },
    },
    {
      table: 'my_day_items',
      values: {
        id: `my-day:${taskId}`,
        task_id: taskId,
        date: day,
        added_at: at,
        is_auto_included: false,
        order: 0,
      },
    },
    {
      table: 'my_day_exclusions',
      values: {
        id: `my-day-exclusion:${taskId}`,
        task_id: taskId,
        date: day,
        removed_at: at,
      },
    },
    {
      table: 'focus_items',
      values: {
        id: `focus:${taskId}`,
        task_id: taskId,
        scope: 'today',
        date: day,
        slot: (variant % 3) + 1,
        added_at: at,
        is_ai_suggested: false,
      },
    },
    {
      table: 'weekly_one_thing',
      values: {
        id: `weekly:${taskId}`,
        task_id: taskId,
        week_monday: `2026-08-${String(3 + (variant % 20)).padStart(2, '0')}`,
        is_manual_override: false,
        completed_at: null,
        created_at: at,
      },
    },
    {
      table: 'priority_sync_log',
      values: {
        id: `priority:${taskId}`,
        task_id: taskId,
        connector_type: 'microsoft-todo-work',
        connector_instance_id: CONNECTOR,
        previous_priority: 'none',
        new_priority: 'high',
        direction: 'inbound',
        write_back_triggered: false,
        note: null,
        timestamp: at,
      },
    },
    {
      table: 'task_triage_log',
      values: {
        id: `triage:${taskId}`,
        task_id: taskId,
        operation_id: null,
        mode: 'no_priority',
        action: 'applied',
        triaged_at: at,
        reversed_at: null,
      },
    },
    {
      table: 'quick_sort_operations',
      values: {
        id: `quick-sort:${taskId}`,
        task_id: taskId,
        mode: 'no_priority',
        action: 'applied',
        label: 'High',
        context_key: 'context',
        queue_index: 0,
        before_snapshot: { __json: {} },
        after_snapshot: { __json: {} },
        state: 'applied',
        ai_accepted: false,
        created_at: at,
        undone_at: null,
      },
    },
    {
      table: 'task_linked_sources',
      values: {
        id: `linked:${taskId}`,
        task_id: taskId,
        connector_type: 'microsoft-todo-work',
        connector_instance_id: CONNECTOR,
        source_id: `linked-source:${taskId}`,
        title: 'Linked',
        linked_at: at,
        match_confidence: null,
        metadata: { __json: {} },
      },
    },
    {
      table: 'task_attachments',
      values: {
        id: `attachment:${taskId}`,
        task_id: taskId,
        name: 'note.txt',
        content_type: 'text/plain',
        size: 4,
        content_base64: null,
        source_attachment_id: null,
        created_at: at,
      },
    },
    {
      table: 'project_phase_items',
      values: {
        id: `phase-item:${taskId}`,
        phase_id: `phase:${taskId}`,
        task_id: taskId,
        sort_order: 0,
        estimated_effort_hours: null,
        is_proposed: false,
        proposal_type: null,
        created_at: at,
      },
    },
    {
      table: 'sync_deletion_candidates',
      values: {
        id: `deletion-candidate:${taskId}`,
        connector_id: CONNECTOR,
        task_id: taskId,
        source_id: `deletion-source:${taskId}`,
        first_missing_at: at,
        last_missing_at: at,
        missing_count: 1,
      },
    },
    {
      // Self-referential so the seed needs no second task while still covering
      // both `task_id` and `depends_on_task_id`.
      table: TASK_DEPENDENCY_TABLE,
      values: {
        id: `dependency:${taskId}`,
        task_id: taskId,
        depends_on_task_id: taskId,
        type: 'blocks',
        connector_instance_id: null,
        sync_status: 'local',
        created_at: at,
      },
    },
    {
      table: TASK_NOTIFICATION_TABLE,
      values: {
        id: notificationIdForTask(taskId),
        source_id: `notification-source:${taskId}`,
        connector_type: 'microsoft-todo-work',
        connector_instance_id: CONNECTOR,
        title: 'Work To Do notification',
        level: 'fyi',
        level_rank: 3,
        category: 'system',
        state: 'unread',
        read_state: 'unread',
        disposition: 'inbox',
        source_state: 'active',
        sync_state: 'synced',
        is_actionable: false,
        received_at: at,
        sort_at: at,
        reconcile_attempts: 0,
        metadata: { __json: {} },
        presentation: { __json: {} },
        related_task_id: taskId,
      },
    },
  ];
}

/** Deterministic notification ID the deletion regressions assert survives. */
export function notificationIdForTask(taskId: string): string {
  return `notification:${taskId}`;
}

/** Every table a canonical deletion must leave empty for the task. */
export const CANONICAL_TASK_ASSOCIATION_TABLES: readonly string[] = [
  ...TASK_ASSOCIATION_TABLES,
  TASK_DEPENDENCY_TABLE,
];

export interface WorkTodoTaskSnapshot {
  id: string;
  sourceId: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  syncStatus: string;
  updatedAt: string;
  lastSyncedAt: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
}

export interface WorkTodoChangeSnapshot {
  idempotencyKey: string;
  taskId: string;
  sourceId: string;
  listSourceId: string;
  remoteTaskId: string;
  operation: string;
  fields: Record<string, unknown> | null;
  taskVersion: string;
  status: string;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

export interface WorkTodoBridgeStateSnapshot {
  transport: string;
  capabilityProfile: string;
  listDeltaLink: string | null;
  resetRequired: boolean;
  lastIngestAt: string | null;
  lastIngestMode: string | null;
}

export interface WorkTodoHarness {
  repositories: WorkTodoBridgePersistence;
  /** Clears all Work To Do state and re-seeds one enabled Work connector. */
  reset(): Promise<void>;
  setConnector(input: {
    id: string;
    type: string;
    enabled: boolean;
    deletedAt?: string | null;
  }): Promise<void>;
  seedBridgeState(state: {
    connectorId: string;
    transport: string;
    capabilityProfile: string;
    listDeltaLink?: string | null;
    resetRequired?: boolean;
    lastIngestAt?: string | null;
    lastIngestMode?: string | null;
  }): Promise<void>;
  seedListDeltaState(input: {
    connectorId: string;
    listSourceId: string;
    deltaLink: string | null;
  }): Promise<void>;
  seedSourceListHidden(input: {
    connectorId: string;
    sourceId: string;
    hidden: boolean;
  }): Promise<void>;
  listTasks(connectorId: string): Promise<WorkTodoTaskSnapshot[]>;
  updateTask(taskId: string, patch: {
    title?: string;
    status?: string;
    priority?: string;
    dueDate?: string | null;
    syncStatus?: string;
    updatedAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  listChanges(connectorId: string): Promise<WorkTodoChangeSnapshot[]>;
  expireLease(idempotencyKey: string, leaseExpiresAt: string): Promise<void>;
  getBridgeState(connectorId: string): Promise<WorkTodoBridgeStateSnapshot | null>;
  listSourceListIds(connectorId: string): Promise<string[]>;
  listTaskTagSlugs(taskId: string): Promise<string[]>;
  /** Writes one row per canonical task association plus a notification. */
  seedTaskAssociations(taskId: string): Promise<void>;
  /** Canonical association tables that still hold rows for the task. */
  residualTaskAssociations(taskId: string): Promise<string[]>;
  /** Reads the seeded notification so tests can prove it survives, nulled. */
  getNotification(id: string): Promise<{ id: string; relatedTaskId: string | null } | null>;
  close(): Promise<void> | void;
}

const CONNECTOR = 'work-todo-contract';
const TIMEZONE = 'UTC';

type RemoteDateTime = { dateTime: string; timeZone: string } | null;

function snapshotPayload(overrides: {
  syncTimestamp?: string;
  title?: string;
  taskId?: string;
  listId?: string;
} = {}) {
  const listId = overrides.listId ?? 'list-1';
  return {
    schemaVersion: '1.0' as const,
    connectorInstanceId: CONNECTOR,
    syncTimestamp: overrides.syncTimestamp ?? '2026-08-07T18:05:00.000Z',
    isFullSnapshot: true as const,
    lists: [{
      id: listId,
      displayName: 'Tasks',
      tasks: [{
        id: overrides.taskId ?? 'task-1',
        title: overrides.title ?? 'Review report #work',
        status: 'notStarted' as const,
        importance: 'high' as const,
        body: { content: 'Prepare the report', contentType: 'text' as const },
        createdDateTime: '2026-08-07T17:00:00.000Z',
        lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
        completedDateTime: null as RemoteDateTime,
        dueDateTime: { dateTime: '2026-08-10T00:00:00', timeZone: 'UTC' } as RemoteDateTime,
        isReminderOn: false,
        reminderDateTime: null as RemoteDateTime,
      }],
    }],
  };
}

function deltaPayload(overrides: {
  syncTimestamp?: string;
  listDeltaLink?: string;
  taskDeltaLink?: string | null;
  reset?: boolean;
  title?: string;
} = {}) {
  return {
    schemaVersion: '1.1' as const,
    connectorInstanceId: CONNECTOR,
    syncTimestamp: overrides.syncTimestamp ?? '2026-08-07T19:00:00.000Z',
    syncMode: 'delta' as const,
    reset: overrides.reset ?? false,
    complete: true as const,
    listDeltaLink: overrides.listDeltaLink ?? 'https://graph.example/lists/delta?$deltatoken=v1',
    lists: [{
      id: 'list-1',
      removed: false as const,
      displayName: 'Tasks',
      taskDeltaLink: overrides.taskDeltaLink ?? 'https://graph.example/tasks/delta?$deltatoken=t1',
      tasks: [{
        id: 'task-1',
        removed: false as const,
        title: overrides.title ?? 'Delta title',
        status: 'notStarted' as const,
        importance: 'normal' as const,
        body: { content: 'Delta body', contentType: 'text' as const },
        createdDateTime: '2026-08-07T17:00:00.000Z',
        lastModifiedDateTime: '2026-08-07T18:55:00.000Z',
        completedDateTime: null,
        dueDateTime: null,
        isReminderOn: false,
        reminderDateTime: null,
        categories: ['Work'],
      }],
    }],
  };
}

export function describeWorkTodoRepositoriesContract(
  backend: string,
  createHarness: () => Promise<WorkTodoHarness>,
): void {
  describe(`WorkTodoBridgePersistence (${backend})`, () => {
    let harness: WorkTodoHarness;
    let repositories: WorkTodoBridgePersistence;

    beforeEach(async () => {
      harness = await createHarness();
      repositories = harness.repositories;
      await harness.reset();
    });

    async function ingestSnapshot(overrides = {}) {
      return repositories.ingest({
        payload: snapshotPayload(overrides),
        now: '2026-08-07T18:05:00.000Z',
        timezone: TIMEZONE,
      });
    }

    async function markPendingPush(taskId: string, patch: {
      title?: string;
      status?: string;
      updatedAt: string;
      dirtyFields: string[];
      metadata: Record<string, unknown>;
    }): Promise<void> {
      await harness.updateTask(taskId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        syncStatus: 'pending_push',
        updatedAt: patch.updatedAt,
        metadata: { ...patch.metadata, workTodoDirtyFields: patch.dirtyFields },
      });
    }

    describe('connector assertion', () => {
      it('rejects an unknown or foreign connector', async () => {
        await harness.setConnector({
          id: CONNECTOR,
          type: 'microsoft-todo',
          enabled: true,
        });

        await expect(ingestSnapshot()).rejects.toMatchObject({
          code: 'CONNECTOR_NOT_FOUND',
          status: 404,
        });
      });

      it('rejects a soft-deleted connector', async () => {
        await harness.setConnector({
          id: CONNECTOR,
          type: 'microsoft-todo-work',
          enabled: true,
          deletedAt: '2026-08-07T00:00:00.000Z',
        });

        await expect(ingestSnapshot()).rejects.toMatchObject({
          code: 'CONNECTOR_NOT_FOUND',
          status: 404,
        });
      });

      it('rejects a disabled connector', async () => {
        await harness.setConnector({
          id: CONNECTOR,
          type: 'microsoft-todo-work',
          enabled: false,
        });

        await expect(ingestSnapshot()).rejects.toMatchObject({
          code: 'CONNECTOR_DISABLED',
          status: 409,
        });
      });
    });

    describe('snapshot ingest', () => {
      it('creates the list, task, source tags, and searchable projection', async () => {
        const result = await ingestSnapshot();
        const tasks = await harness.listTasks(CONNECTOR);

        expect(result).toMatchObject({ mode: 'snapshot', created: 1, updated: 0, removed: 0 });
        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
          sourceId: 'list-1:task-1',
          priority: 'high',
          dueDate: '2026-08-10',
          syncStatus: 'synced',
        });
        expect(await harness.listSourceListIds(CONNECTOR)).toEqual(['list-1']);
        expect(await harness.listTaskTagSlugs(tasks[0].id)).toEqual(['work']);
        expect(result.indexedTasks.map((task) => task.id)).toEqual([tasks[0].id]);
        expect(result.indexedTasks[0]).toMatchObject({
          connectorType: 'microsoft-todo-work',
          title: 'Review report #work',
        });
      });

      it('replays an identical snapshot idempotently by source ID', async () => {
        const first = await ingestSnapshot();
        const [created] = await harness.listTasks(CONNECTOR);
        const second = await ingestSnapshot();
        const tasks = await harness.listTasks(CONNECTOR);

        expect(first.created).toBe(1);
        expect(second).toMatchObject({ created: 0, updated: 1, removed: 0 });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe(created.id);
      });

      it('dedupes a duplicated source ID inside one payload', async () => {
        const payload = snapshotPayload();
        payload.lists[0].tasks = [payload.lists[0].tasks[0], { ...payload.lists[0].tasks[0] }];

        await repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: TIMEZONE,
        });

        expect(await harness.listTasks(CONNECTOR)).toHaveLength(1);
      });

      it('refuses an ambiguous 999-task standard list before writing anything', async () => {
        const payload = snapshotPayload();
        const template = payload.lists[0].tasks[0];
        payload.lists[0].tasks = Array.from({ length: 999 }, (_, index) => ({
          ...template,
          id: `task-${index}`,
        }));

        await expect(repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toMatchObject({ code: 'SNAPSHOT_MAY_BE_TRUNCATED', status: 409 });
        expect(await harness.listTasks(CONNECTOR)).toEqual([]);
      });

      it('rolls the whole ingest back when a later list fails to map', async () => {
        const payload = snapshotPayload();
        payload.lists.push({
          id: 'list-2',
          displayName: 'Broken',
          tasks: [{
            ...payload.lists[0].tasks[0],
            id: 'task-2',
            isReminderOn: true,
            reminderDateTime: { dateTime: 'not-a-datetime+00:00', timeZone: 'UTC' },
          }],
        });

        await expect(repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toThrow();

        expect(await harness.listTasks(CONNECTOR)).toEqual([]);
        expect(await harness.listSourceListIds(CONNECTOR)).toEqual([]);
      });

      it('removes tasks and lists an authoritative snapshot no longer reports', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);

        const emptied = snapshotPayload({ syncTimestamp: '2026-08-07T19:00:00.000Z' });
        emptied.lists = [];
        const result = await repositories.ingest({
          payload: emptied,
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });

        expect(result.removed).toBe(1);
        expect(result.removedTaskIds).toEqual([task.id]);
        expect(await harness.listTasks(CONNECTOR)).toEqual([]);
        expect(await harness.listSourceListIds(CONNECTOR)).toEqual([]);
      });

      it('rejects an older snapshot instead of removing the newer tasks', async () => {
        await ingestSnapshot({ syncTimestamp: '2026-08-07T19:00:00.0009Z' });
        const emptied = snapshotPayload({ syncTimestamp: '2026-08-07T19:00:00.0001Z' });
        emptied.lists = [];

        await expect(repositories.ingest({
          payload: emptied,
          now: '2026-08-07T19:30:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toMatchObject({ code: 'STALE_INGEST_ENVELOPE', status: 409 });

        expect(await harness.listTasks(CONNECTOR)).toHaveLength(1);
        expect(await harness.listSourceListIds(CONNECTOR)).toEqual(['list-1']);
        expect(await harness.getBridgeState(CONNECTOR)).toMatchObject({
          lastIngestAt: '2026-08-07T19:00:00.0009Z',
        });
      });

      it('protects a pending local edit from remote values and from removal', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'Local revised title',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });

        const overwrite = await ingestSnapshot({
          title: 'Stale remote title',
          syncTimestamp: '2026-08-07T18:30:00.000Z',
        });
        const [protectedTask] = await harness.listTasks(CONNECTOR);

        expect(protectedTask.title).toBe('Local revised title');
        expect(protectedTask.syncStatus).toBe('pending_push');
        expect(overwrite.indexedTasks[0].title).toBe('Local revised title');

        const emptied = snapshotPayload({ syncTimestamp: '2026-08-07T19:00:00.000Z' });
        emptied.lists = [];
        const removal = await repositories.ingest({
          payload: emptied,
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });

        expect(removal).toMatchObject({ removed: 0, protectedPending: 1 });
        expect(await harness.listTasks(CONNECTOR)).toHaveLength(1);
      });
    });

    describe('delta ingest and checkpoints', () => {
      beforeEach(async () => {
        await harness.seedBridgeState({
          connectorId: CONNECTOR,
          transport: 'power-automate-graph',
          capabilityProfile: 'extended-v1',
        });
      });

      it('rejects a payload whose capability profile does not match', async () => {
        await expect(ingestSnapshot()).rejects.toMatchObject({
          code: 'CAPABILITY_PROFILE_MISMATCH',
          status: 409,
        });
      });

      it('stores the list and task checkpoints from an accepted delta', async () => {
        const result = await repositories.ingest({
          payload: deltaPayload(),
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });
        const state = await harness.getBridgeState(CONNECTOR);
        const pull = await repositories.readPullState(CONNECTOR);

        expect(result.mode).toBe('delta');
        expect(state).toMatchObject({
          lastIngestMode: 'delta',
          lastIngestAt: '2026-08-07T19:00:00.000Z',
          listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v1',
        });
        expect(pull.taskDeltaLinks).toEqual([{
          listSourceId: 'list-1',
          deltaLink: 'https://graph.example/tasks/delta?$deltatoken=t1',
        }]);
      });

      it('rejects a delayed delta instead of regressing a newer checkpoint', async () => {
        await repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T20:00:00.0009Z',
            listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=newest',
            taskDeltaLink: 'https://graph.example/tasks/delta?$deltatoken=newest',
            title: 'Newest title',
          }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });

        await expect(repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T20:00:00.0001Z',
            listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=stale',
            taskDeltaLink: 'https://graph.example/tasks/delta?$deltatoken=stale',
            title: 'Replayed title',
          }),
          now: '2026-08-07T20:05:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toMatchObject({ code: 'STALE_INGEST_ENVELOPE', status: 409 });

        const state = await harness.getBridgeState(CONNECTOR);
        const pull = await repositories.readPullState(CONNECTOR);

        expect(state).toMatchObject({
          lastIngestAt: '2026-08-07T20:00:00.0009Z',
          listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=newest',
        });
        expect(pull.taskDeltaLinks[0].deltaLink)
          .toBe('https://graph.example/tasks/delta?$deltatoken=newest');
        // The rejected envelope applied no task mutation at all.
        expect((await harness.listTasks(CONNECTOR))[0].title).toBe('Newest title');
      });

      it('accepts a newer sub-millisecond delta and advances its checkpoints', async () => {
        await repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T20:00:00.0001Z',
            listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=older',
          }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });
        await repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T20:00:00.0009Z',
            listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=newer',
            taskDeltaLink: 'https://graph.example/tasks/delta?$deltatoken=newer',
            title: 'Sub-millisecond newer title',
          }),
          now: '2026-08-07T20:01:00.000Z',
          timezone: TIMEZONE,
        });

        expect(await harness.getBridgeState(CONNECTOR)).toMatchObject({
          lastIngestAt: '2026-08-07T20:00:00.0009Z',
          listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=newer',
        });
        expect((await repositories.readPullState(CONNECTOR)).taskDeltaLinks[0].deltaLink)
          .toBe('https://graph.example/tasks/delta?$deltatoken=newer');
        expect((await harness.listTasks(CONNECTOR))[0].title)
          .toBe('Sub-millisecond newer title');
      });

      it('never lets a delayed delta remove a task the newer envelope kept', async () => {
        await repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T20:00:00.0009Z',
            title: 'Newest title',
          }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });
        const removal = deltaPayload({ syncTimestamp: '2026-08-07T20:00:00.0001Z' });
        removal.lists[0].tasks = [{
          id: 'task-1',
          removed: true,
        }] as unknown as typeof removal.lists[0]['tasks'];

        await expect(repositories.ingest({
          payload: removal,
          now: '2026-08-07T20:05:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toMatchObject({ code: 'STALE_INGEST_ENVELOPE', status: 409 });

        const tasks = await harness.listTasks(CONNECTOR);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].title).toBe('Newest title');
        expect(await harness.getBridgeState(CONNECTOR)).toMatchObject({
          lastIngestAt: '2026-08-07T20:00:00.0009Z',
        });
      });

      it('never lets a delayed delta remove a list the newer envelope kept', async () => {
        await repositories.ingest({
          payload: deltaPayload({ syncTimestamp: '2026-08-07T20:00:00.0009Z' }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });
        const removal = deltaPayload({ syncTimestamp: '2026-08-07T20:00:00.0001Z' });
        removal.lists = [{
          id: 'list-1',
          removed: true,
        }] as unknown as typeof removal.lists;

        await expect(repositories.ingest({
          payload: removal,
          now: '2026-08-07T20:05:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toMatchObject({ code: 'STALE_INGEST_ENVELOPE', status: 409 });

        expect(await harness.listSourceListIds(CONNECTOR)).toEqual(['list-1']);
        expect(await harness.listTasks(CONNECTOR)).toHaveLength(1);
        expect((await repositories.readPullState(CONNECTOR)).taskDeltaLinks)
          .toHaveLength(1);
        expect(await harness.getBridgeState(CONNECTOR)).toMatchObject({
          lastIngestAt: '2026-08-07T20:00:00.0009Z',
        });
      });

      it('accepts a replay carrying the same accepted instant in another offset', async () => {
        await repositories.ingest({
          payload: deltaPayload({ syncTimestamp: '2026-08-07T20:00:00.1234Z' }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });
        await repositories.ingest({
          payload: deltaPayload({
            syncTimestamp: '2026-08-07T16:00:00.123400000-04:00',
            listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v2',
          }),
          now: '2026-08-07T20:01:00.000Z',
          timezone: TIMEZONE,
        });

        expect(await harness.getBridgeState(CONNECTOR)).toMatchObject({
          lastIngestAt: '2026-08-07T16:00:00.123400000-04:00',
          listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v2',
        });
      });

      it('reports a reset envelope without leaking the stored checkpoints', async () => {
        await repositories.ingest({
          payload: deltaPayload(),
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });

        const reset = await repositories.resetDelta({
          connectorId: CONNECTOR,
          now: '2026-08-07T19:30:00.000Z',
        });
        const state = await harness.getBridgeState(CONNECTOR);
        const pull = await repositories.readPullState(CONNECTOR);
        const status = await repositories.readStatus(CONNECTOR);

        expect(reset).toEqual({ resetRequired: true, updatedAt: '2026-08-07T19:30:00.000Z' });
        expect(state).toMatchObject({ resetRequired: true, listDeltaLink: null });
        expect(pull.taskDeltaLinks).toEqual([]);
        expect(status.deltaCheckpointStored).toBe(false);
        expect(JSON.stringify(status)).not.toContain('deltatoken');
      });

      it('returns only visible lists in the pull envelope state', async () => {
        await repositories.ingest({
          payload: deltaPayload(),
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });
        await harness.seedSourceListHidden({
          connectorId: CONNECTOR,
          sourceId: 'list-1',
          hidden: true,
        });

        expect((await repositories.readPullState(CONNECTOR)).selectedListIds).toEqual([]);
      });

      it('fails closed when the bridge has never been configured', async () => {
        await harness.reset();

        await expect(repositories.readPullState(CONNECTOR)).rejects.toMatchObject({
          code: 'BRIDGE_NOT_CONFIGURED',
          status: 409,
        });
      });
    });

    describe('canonical task deletion cleanup', () => {
      function checklistDelta(overrides: {
        syncTimestamp: string;
        removed?: boolean;
      }) {
        const payload = deltaPayload({ syncTimestamp: overrides.syncTimestamp });
        payload.lists[0].tasks[0] = {
          ...payload.lists[0].tasks[0],
          ...(overrides.removed ? { removed: true as const } : {}),
          checklistItems: [{
            id: 'item-a',
            displayName: 'Checklist item',
            isChecked: false,
          }],
        } as unknown as typeof payload.lists[0]['tasks'][0];
        return payload;
      }

      it('clears every canonical association when a snapshot drops the task', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await harness.seedTaskAssociations(task.id);
        expect((await harness.residualTaskAssociations(task.id)).sort())
          .toEqual([...CANONICAL_TASK_ASSOCIATION_TABLES, TASK_NOTIFICATION_TABLE].sort());

        const emptied = snapshotPayload({ syncTimestamp: '2026-08-07T19:00:00.000Z' });
        emptied.lists = [];
        const result = await repositories.ingest({
          payload: emptied,
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });

        expect(result.removed).toBe(1);
        expect(await harness.listTasks(CONNECTOR)).toEqual([]);
        expect(await harness.residualTaskAssociations(task.id)).toEqual([]);
        // The notification survives with its task reference nulled, never deleted.
        expect(await harness.getNotification(notificationIdForTask(task.id))).toEqual({
          id: notificationIdForTask(task.id),
          relatedTaskId: null,
        });
      });

      it('applies the same cleanup to descendants of a removed task', async () => {
        await harness.seedBridgeState({
          connectorId: CONNECTOR,
          transport: 'power-automate-graph',
          capabilityProfile: 'extended-v1',
        });
        await repositories.ingest({
          payload: checklistDelta({ syncTimestamp: '2026-08-07T19:00:00.000Z' }),
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });
        const seeded = await harness.listTasks(CONNECTOR);
        expect(seeded).toHaveLength(2);
        const parent = seeded.find((task) => task.parentId === null)!;
        const child = seeded.find((task) => task.parentId === parent.id)!;
        await harness.seedTaskAssociations(parent.id);
        await harness.seedTaskAssociations(child.id);

        const result = await repositories.ingest({
          payload: checklistDelta({
            syncTimestamp: '2026-08-07T20:00:00.000Z',
            removed: true,
          }),
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        });

        expect(result.removedTaskIds).toEqual(
          expect.arrayContaining([parent.id, child.id]),
        );
        expect(await harness.listTasks(CONNECTOR)).toEqual([]);
        expect(await harness.residualTaskAssociations(parent.id)).toEqual([]);
        expect(await harness.residualTaskAssociations(child.id)).toEqual([]);
        expect(await harness.getNotification(notificationIdForTask(child.id))).toEqual({
          id: notificationIdForTask(child.id),
          relatedTaskId: null,
        });
      });
      it('rolls a removal back with the rest of a failed ingest', async () => {
        await harness.seedBridgeState({
          connectorId: CONNECTOR,
          transport: 'power-automate-graph',
          capabilityProfile: 'extended-v1',
        });
        await repositories.ingest({
          payload: checklistDelta({ syncTimestamp: '2026-08-07T19:00:00.000Z' }),
          now: '2026-08-07T19:00:00.000Z',
          timezone: TIMEZONE,
        });
        const [parent] = await harness.listTasks(CONNECTOR);
        await harness.seedTaskAssociations(parent.id);

        const failing = deltaPayload({ syncTimestamp: '2026-08-07T20:00:00.000Z' });
        failing.lists = [
          { id: 'list-1', removed: true },
          {
            ...failing.lists[0],
            id: 'list-2',
            tasks: [{
              ...failing.lists[0].tasks[0],
              id: 'task-2',
              isReminderOn: true,
              reminderDateTime: { dateTime: 'not-a-datetime+00:00', timeZone: 'UTC' },
            }],
          },
        ] as unknown as typeof failing.lists;

        await expect(repositories.ingest({
          payload: failing,
          now: '2026-08-07T20:00:00.000Z',
          timezone: TIMEZONE,
        })).rejects.toThrow();

        // The removal and its association cleanup were rolled back with the
        // rest of the failed envelope.
        expect(await harness.listTasks(CONNECTOR)).toHaveLength(2);
        expect(await harness.listSourceListIds(CONNECTOR)).toEqual(['list-1']);
        expect((await harness.residualTaskAssociations(parent.id)).sort())
          .toEqual([...CANONICAL_TASK_ASSOCIATION_TABLES, TASK_NOTIFICATION_TABLE].sort());
      });
    });

    describe('write-back lease', () => {
      it('refuses to lease before an inbound baseline exists', async () => {
        await harness.seedBridgeState({
          connectorId: CONNECTOR,
          transport: 'power-automate-standard',
          capabilityProfile: 'standard-v1',
        });

        await expect(repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:10:00.000Z',
        })).rejects.toMatchObject({ code: 'BRIDGE_NOT_INITIALIZED', status: 409 });
      });

      it('creates one change per dirty task and re-leases it idempotently', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'Local revised title',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });

        const first = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });
        const retry = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:12:00.000Z',
        });

        expect(first.changes).toHaveLength(1);
        expect(first.changes[0]).toMatchObject({
          sourceId: 'list-1:task-1',
          listSourceId: 'list-1',
          remoteTaskId: 'task-1',
          operation: 'update',
          fields: { title: 'Local revised title' },
        });
        expect(retry.changes.map((change) => change.idempotencyKey))
          .toEqual(first.changes.map((change) => change.idempotencyKey));
        expect(retry.leaseId).toBe(first.leaseId);
        expect(await harness.listChanges(CONNECTOR)).toHaveLength(1);
      });

      it('collapses a completion-only edit into a complete operation', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          status: 'done',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['status'],
          metadata: task.metadata,
        });

        const lease = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });

        expect(lease.changes[0]).toMatchObject({ operation: 'complete', fields: null });
      });

      it('skips checklist items and tasks without dirty fields', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await harness.updateTask(task.id, {
          syncStatus: 'pending_push',
          updatedAt: '2026-08-07T18:10:00.000Z',
          metadata: task.metadata,
        });
        await harness.seedBridgeState({
          connectorId: CONNECTOR,
          transport: 'power-automate-standard',
          capabilityProfile: 'standard-v1',
          lastIngestAt: '2026-08-07T18:05:00.000Z',
          lastIngestMode: 'snapshot',
        });

        const lease = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });

        expect(lease.changes).toEqual([]);
      });

      it('reclaims only an expired lease and issues a fresh lease ID', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'Local revised title',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });
        const first = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });
        await harness.expireLease(
          first.changes[0].idempotencyKey,
          '2026-08-07T18:12:00.000Z',
        );

        const reclaimed = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:30:00.000Z',
        });
        const [change] = await harness.listChanges(CONNECTOR);

        expect(reclaimed.leaseId).not.toBe(first.leaseId);
        expect(reclaimed.changes[0].idempotencyKey).toBe(first.changes[0].idempotencyKey);
        expect(change.attemptCount).toBe(2);
      });

      it('supersedes a queued change once a newer local edit lands', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'First local edit',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });
        const first = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });
        await harness.expireLease(
          first.changes[0].idempotencyKey,
          '2026-08-07T18:12:00.000Z',
        );
        await harness.updateTask(task.id, {
          title: 'Newer local edit',
          updatedAt: '2026-08-07T18:20:00.000Z',
        });

        const release = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:30:00.000Z',
        });
        const changes = await harness.listChanges(CONNECTOR);
        const superseded = changes.find(
          (change) => change.idempotencyKey === first.changes[0].idempotencyKey,
        );

        expect(superseded?.status).toBe('superseded');
        expect(release.changes).toHaveLength(1);
        expect(release.changes[0].idempotencyKey)
          .not.toBe(first.changes[0].idempotencyKey);
        expect(release.changes[0].fields).toEqual({ title: 'Newer local edit' });
      });

      it('bounds one lease batch by the requested limit', async () => {
        const payload = snapshotPayload();
        const template = payload.lists[0].tasks[0];
        payload.lists[0].tasks = Array.from({ length: 3 }, (_, index) => ({
          ...template,
          id: `task-${index}`,
        }));
        await repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: TIMEZONE,
        });
        const tasks = await harness.listTasks(CONNECTOR);
        for (const [index, task] of tasks.entries()) {
          await markPendingPush(task.id, {
            title: `Local ${index}`,
            updatedAt: `2026-08-07T18:1${index}:00.000Z`,
            dirtyFields: ['title'],
            metadata: task.metadata,
          });
        }

        const lease = await repositories.lease({
          connectorId: CONNECTOR,
          limit: 2,
          now: '2026-08-07T18:20:00.000Z',
        });

        expect(lease.changes).toHaveLength(2);
      });
    });

    describe('acknowledgement', () => {
      async function leaseOne() {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'Local revised title',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });
        const lease = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });
        return { task, lease };
      }

      it('settles a successful acknowledgement and clears the dirty fields', async () => {
        const { task, lease } = await leaseOne();

        const result = await repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        });
        const [settled] = await harness.listTasks(CONNECTOR);

        expect(result).toMatchObject({ succeeded: 1, stale: 0, failed: 0, skipped: 0 });
        expect(settled.id).toBe(task.id);
        expect(settled.syncStatus).toBe('synced');
        expect(settled.metadata.workTodoDirtyFields).toBeUndefined();
      });

      it('treats a duplicate acknowledgement of a settled change as succeeded', async () => {
        const { lease } = await leaseOne();
        const ack = {
          connectorInstanceId: CONNECTOR,
          leaseId: lease.leaseId,
          processedAt: '2026-08-07T18:12:00.000Z',
          results: [{
            idempotencyKey: lease.changes[0].idempotencyKey,
            sourceId: lease.changes[0].sourceId,
            status: 'succeeded' as const,
          }],
        };
        await repositories.acknowledge({ payload: ack, now: '2026-08-07T18:12:00.000Z' });

        const replay = await repositories.acknowledge({
          payload: ack,
          now: '2026-08-07T18:13:00.000Z',
        });

        expect(replay).toMatchObject({ succeeded: 1, stale: 0 });
      });

      it('rejects an acknowledgement that does not belong to the active lease', async () => {
        const { lease } = await leaseOne();

        await expect(repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: '11111111-1111-4111-8111-111111111111',
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        })).rejects.toMatchObject({ code: 'ACK_LEASE_MISMATCH', status: 409 });
      });

      it('rejects an acknowledgement for an unknown change or mismatched source', async () => {
        const { lease } = await leaseOne();

        await expect(repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: 'missing-key-000000',
              sourceId: lease.changes[0].sourceId,
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        })).rejects.toMatchObject({ code: 'ACK_CHANGE_NOT_FOUND', status: 409 });

        await expect(repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: 'list-1:other-task',
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        })).rejects.toMatchObject({ code: 'ACK_CHANGE_NOT_FOUND', status: 409 });
      });

      it('does not let a delayed success settle a newer local edit', async () => {
        const { task, lease } = await leaseOne();
        await harness.updateTask(task.id, {
          title: 'Newer local edit',
          updatedAt: '2026-08-07T18:15:00.000Z',
        });

        const result = await repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:16:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:16:00.000Z',
        });
        const [current] = await harness.listTasks(CONNECTOR);

        expect(result).toMatchObject({ succeeded: 1, stale: 1 });
        expect(current).toMatchObject({
          title: 'Newer local edit',
          syncStatus: 'pending_push',
        });
      });

      it('does not let a delayed failure regress a newer local edit', async () => {
        const { task, lease } = await leaseOne();
        await harness.updateTask(task.id, {
          title: 'Newer local edit',
          updatedAt: '2026-08-07T18:15:00.000Z',
        });

        const result = await repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:16:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'failed',
              errorCode: 'REMOTE_CONFLICT',
            }],
          },
          now: '2026-08-07T18:16:00.000Z',
        });
        const [current] = await harness.listTasks(CONNECTOR);
        const [change] = await harness.listChanges(CONNECTOR);

        expect(result).toMatchObject({ failed: 1, stale: 1 });
        expect(current).toMatchObject({
          title: 'Newer local edit',
          syncStatus: 'pending_push',
        });
        expect(change.status).toBe('superseded');
      });

      it('keeps a skipped change retryable and a failed change in error', async () => {
        const { lease } = await leaseOne();

        const skipped = await repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'skipped',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        });
        const [change] = await harness.listChanges(CONNECTOR);
        const [current] = await harness.listTasks(CONNECTOR);

        expect(skipped).toMatchObject({ skipped: 1, failed: 0, stale: 0 });
        expect(change).toMatchObject({ status: 'pending', leaseId: null });
        expect(current.syncStatus).toBe('pending_push');
      });
    });

    describe('status', () => {
      it('reports an uninitialized bridge without exposing checkpoints', async () => {
        const status = await repositories.readStatus(CONNECTOR);

        expect(status).toMatchObject({
          enabled: true,
          initialized: false,
          transport: null,
          capabilityProfile: null,
          resetRequired: false,
          deltaCheckpointStored: false,
          pendingWriteBackCount: 0,
        });
      });

      it('counts pending, leased, and failed write-backs only', async () => {
        await ingestSnapshot();
        const [task] = await harness.listTasks(CONNECTOR);
        await markPendingPush(task.id, {
          title: 'Local revised title',
          updatedAt: '2026-08-07T18:10:00.000Z',
          dirtyFields: ['title'],
          metadata: task.metadata,
        });
        const lease = await repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:11:00.000Z',
        });

        expect((await repositories.readStatus(CONNECTOR)).pendingWriteBackCount).toBe(1);

        await repositories.acknowledge({
          payload: {
            connectorInstanceId: CONNECTOR,
            leaseId: lease.leaseId,
            processedAt: '2026-08-07T18:12:00.000Z',
            results: [{
              idempotencyKey: lease.changes[0].idempotencyKey,
              sourceId: lease.changes[0].sourceId,
              status: 'succeeded',
            }],
          },
          now: '2026-08-07T18:12:00.000Z',
        });

        const settled = await repositories.readStatus(CONNECTOR);
        expect(settled.pendingWriteBackCount).toBe(0);
        expect(settled).toMatchObject({ initialized: true, lastIngestMode: 'snapshot' });
      });

      it('rejects status for a connector of another type', async () => {
        await harness.setConnector({
          id: CONNECTOR,
          type: 'microsoft-todo',
          enabled: true,
        });

        await expect(repositories.readStatus(CONNECTOR)).rejects.toMatchObject({
          code: 'CONNECTOR_NOT_FOUND',
          status: 404,
        });
      });
    });
  });
}
