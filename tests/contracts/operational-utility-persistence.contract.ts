import { describe, expect, it, beforeEach } from 'vitest';
import type {
  OperationalUtilityPersistence,
} from '@/db/persistence/operational-utility';

export const OPERATIONAL_UTILITY_NOW = '2026-09-14T12:00:00.000Z';

export interface SeedConnectorInput {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly syncedLists?: unknown[];
  readonly capabilities?: Record<string, unknown>;
  readonly createdAt?: string;
  readonly deletedAt?: string | null;
}

export interface SeedSourceListInput {
  readonly id: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly name: string;
}

export interface SeedTaskInput {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly status?: string;
  readonly sourceListId?: string | null;
  readonly dueDate?: string | null;
  readonly completedAt?: string | null;
  readonly updatedAt?: string;
  readonly lastSyncedAt?: string | null;
  /** Structured metadata; mutually exclusive with `rawMetadata`. */
  readonly metadata?: Record<string, unknown> | null;
  /** Verbatim stored metadata, used to exercise non-object documents. */
  readonly rawMetadata?: string;
}

export interface SeedTagInput {
  readonly id: string;
  readonly slug: string;
  readonly name?: string;
}

export interface OperationalUtilityContractHarness {
  readonly persistence: OperationalUtilityPersistence;
  /**
   * Both shipped schemas declare a unique index on
   * `(source_id, connector_instance_id)`, so duplicate rows only exist in
   * legacy data. A harness sets this when it can reproduce that state.
   */
  readonly supportsDuplicateSourceRows: boolean;
  /** Set when the backend column can hold text that is not valid JSON. */
  readonly supportsCorruptMetadataText: boolean;
  reset(): Promise<void>;
  seedConnector(input: SeedConnectorInput): Promise<void>;
  seedSourceList(input: SeedSourceListInput): Promise<void>;
  seedTask(input: SeedTaskInput): Promise<void>;
  seedTag(input: SeedTagInput): Promise<void>;
  seedTaskTag(taskId: string, tagId: string): Promise<void>;
  seedSyncLogEntry(id: string): Promise<void>;
  listTaskIds(): Promise<string[]>;
  listTaskTagPairs(): Promise<Array<{ taskId: string; tagId: string }>>;
  listTags(): Promise<Array<{ id: string; slug: string }>>;
  listSourceListIds(): Promise<string[]>;
  readSeedMarker(): Promise<{ id: string; seededAt: string } | null>;
}

const RECURRENCE = { recurrence: { pattern: 'daily' } };

export function describeOperationalUtilityPersistenceContract(
  label: string,
  createHarness: () => Promise<OperationalUtilityContractHarness>,
): void {
  describe(`operational utility persistence (${label})`, () => {
    let harness: OperationalUtilityContractHarness;
    let persistence: OperationalUtilityPersistence;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
      persistence = harness.persistence;
    });

    describe('maintenance cleanup', () => {
      it('keeps the most recently synced duplicate and removes its dependents', async () => {
        if (!harness.supportsDuplicateSourceRows) return;
        await harness.seedTag({ id: 'tag-1', slug: 'tag-1' });
        for (const [id, lastSyncedAt, updatedAt] of [
          ['dupe-old', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
          ['dupe-new', '2026-09-03T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
          ['dupe-mid', '2026-09-02T00:00:00.000Z', '2026-09-09T00:00:00.000Z'],
        ]) {
          await harness.seedTask({
            id,
            sourceId: 'issue-1',
            connectorInstanceId: 'connector-1',
            title: 'Duplicate',
            lastSyncedAt,
            updatedAt,
          });
          await harness.seedTaskTag(id, 'tag-1');
        }

        const result = await persistence.maintenance.runDuplicateCleanup();

        expect(result).toMatchObject({ duplicateGroupsFound: 1, tasksRemoved: 2 });
        expect(await harness.listTaskIds()).toEqual(['dupe-new']);
        expect(await harness.listTaskTagPairs()).toEqual([
          { taskId: 'dupe-new', tagId: 'tag-1' },
        ]);
      });

      it('breaks duplicate ties by updatedAt then id', async () => {
        if (!harness.supportsDuplicateSourceRows) return;
        await harness.seedTask({
          id: 'b-tie',
          sourceId: 'issue-2',
          connectorInstanceId: 'connector-1',
          title: 'Tie',
          lastSyncedAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:00.000Z',
        });
        await harness.seedTask({
          id: 'a-tie',
          sourceId: 'issue-2',
          connectorInstanceId: 'connector-1',
          title: 'Tie',
          lastSyncedAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:00.000Z',
        });

        await persistence.maintenance.runDuplicateCleanup();

        expect(await harness.listTaskIds()).toEqual(['a-tie']);
      });

      it('keeps the most recently completed recurring instance', async () => {
        await harness.seedTask({
          id: 'done-old',
          sourceId: 'rec-1',
          connectorInstanceId: 'connector-1',
          sourceListId: 'list-1',
          title: 'Water plants',
          status: 'done',
          completedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          metadata: RECURRENCE,
        });
        await harness.seedTask({
          id: 'done-new',
          sourceId: 'rec-2',
          connectorInstanceId: 'connector-1',
          sourceListId: 'list-1',
          title: '  water PLANTS ',
          status: 'done',
          completedAt: null,
          updatedAt: '2026-09-07T00:00:00.000Z',
          metadata: RECURRENCE,
        });

        const result = await persistence.maintenance.runDuplicateCleanup();

        expect(result.recurringInstancesRemoved).toBe(1);
        expect(await harness.listTaskIds()).toEqual(['done-new']);
      });

      it('keeps the nearest due open recurring instance and treats nulls as furthest', async () => {
        await harness.seedTask({
          id: 'open-none',
          sourceId: 'open-1',
          connectorInstanceId: 'connector-1',
          title: 'Standup',
          dueDate: null,
          updatedAt: '2026-09-09T00:00:00.000Z',
          metadata: RECURRENCE,
        });
        await harness.seedTask({
          id: 'open-late',
          sourceId: 'open-2',
          connectorInstanceId: 'connector-1',
          title: 'Standup',
          dueDate: '2026-10-01',
          updatedAt: '2026-09-08T00:00:00.000Z',
          metadata: RECURRENCE,
        });
        await harness.seedTask({
          id: 'open-soon',
          sourceId: 'open-3',
          connectorInstanceId: 'connector-1',
          title: 'Standup',
          dueDate: '2026-09-15',
          updatedAt: '2026-09-07T00:00:00.000Z',
          metadata: RECURRENCE,
        });

        const result = await persistence.maintenance.runDuplicateCleanup();

        expect(result.openRecurringInstancesRemoved).toBe(2);
        expect(await harness.listTaskIds()).toEqual(['open-soon']);
      });

      it('never groups tasks whose metadata is not a JSON object', async () => {
        await harness.seedTask({
          id: 'meta-null',
          sourceId: 'meta-1',
          connectorInstanceId: 'connector-1',
          title: 'Repeat me',
          rawMetadata: 'null',
        });
        await harness.seedTask({
          id: 'meta-scalar',
          sourceId: 'meta-2',
          connectorInstanceId: 'connector-1',
          title: 'Repeat me',
          rawMetadata: '"recurrence"',
        });
        if (harness.supportsCorruptMetadataText) {
          await harness.seedTask({
            id: 'meta-corrupt',
            sourceId: 'meta-3',
            connectorInstanceId: 'connector-1',
            title: 'Repeat me',
            rawMetadata: '{"recurrence":',
          });
        }

        const result = await persistence.maintenance.runDuplicateCleanup();

        expect(result.openRecurringInstancesRemoved).toBe(0);
        expect(result.recurringInstancesRemoved).toBe(0);
        expect((await harness.listTaskIds()).length)
          .toBe(harness.supportsCorruptMetadataText ? 3 : 2);
      });

      it('reports zeroed counts for an empty database', async () => {
        expect(await persistence.maintenance.runDuplicateCleanup()).toEqual({
          duplicateGroupsFound: 0,
          tasksRemoved: 0,
          recurringInstancesRemoved: 0,
          openRecurringInstancesRemoved: 0,
        });
      });
    });

    describe('bug reports', () => {
      const bugReportTask = {
        id: 'bug-task',
        sourceId: 'bug-snap-bug-task',
        connectorType: 'local',
        connectorInstanceId: 'bug-snap',
        title: '🐛 Broken',
        description: 'details',
        status: 'todo',
        priority: 'high',
        createdAt: OPERATIONAL_UTILITY_NOW,
        updatedAt: OPERATIONAL_UTILITY_NOW,
        lastSyncedAt: OPERATIONAL_UTILITY_NOW,
        metadata: { bugSnap: true },
      };

      it('creates the task, reuses tags by slug, and applies every association', async () => {
        await harness.seedTag({ id: 'tag-bug', slug: 'bug', name: 'bug' });

        const result = await persistence.bugReports.create({
          task: bugReportTask,
          tags: [
            { slug: 'bug', name: 'bug', color: '#ef4444', newTagId: 'unused-tag' },
            { slug: 'app-portal', name: 'portal', color: '#6366f1', newTagId: 'tag-app' },
          ],
        });

        expect(result).toEqual({ taskId: 'bug-task', tagIds: ['tag-bug', 'tag-app'] });
        expect(await harness.listTaskIds()).toEqual(['bug-task']);
        expect(await harness.listTaskTagPairs()).toEqual([
          { taskId: 'bug-task', tagId: 'tag-app' },
          { taskId: 'bug-task', tagId: 'tag-bug' },
        ].sort((left, right) => left.tagId.localeCompare(right.tagId)));
        expect((await harness.listTags()).map((tag) => tag.slug).sort())
          .toEqual(['app-portal', 'bug']);
      });

      it('rolls back the task and every tag when one association fails', async () => {
        await harness.seedTag({ id: 'tag-collision', slug: 'unrelated' });

        await expect(persistence.bugReports.create({
          task: bugReportTask,
          tags: [
            { slug: 'bug', name: 'bug', color: '#ef4444', newTagId: 'tag-bug' },
            // Reusing an existing primary key fails after the first tag was written.
            { slug: 'app-portal', name: 'portal', color: '#6366f1', newTagId: 'tag-collision' },
          ],
        })).rejects.toThrow();

        expect(await harness.listTaskIds()).toEqual([]);
        expect(await harness.listTaskTagPairs()).toEqual([]);
        expect((await harness.listTags()).map((tag) => tag.slug)).toEqual(['unrelated']);
      });
    });

    describe('retained source lists', () => {
      beforeEach(async () => {
        await harness.seedConnector({
          id: 'github-1',
          type: 'github-issues',
          name: 'GitHub',
          settings: { repos: ['octo/active'] },
          syncedLists: ['octo/active'],
        });
        await harness.seedConnector({ id: 'github-2', type: 'github-issues', name: 'Other' });
        await harness.seedSourceList({
          id: 'retained-list',
          connectorInstanceId: 'github-1',
          sourceId: 'octo/removed',
          name: 'Retained',
        });
        await harness.seedSourceList({
          id: 'foreign-list',
          connectorInstanceId: 'github-2',
          sourceId: 'octo/foreign',
          name: 'Foreign',
        });
      });

      it('reports a missing connector without a source list', async () => {
        expect(await persistence.retainedSourceLists.loadSnapshot({
          connectorId: 'nope',
          sourceListId: 'retained-list',
        })).toEqual({ connector: null, sourceList: null });
      });

      it('never returns a source list owned by another connector', async () => {
        const snapshot = await persistence.retainedSourceLists.loadSnapshot({
          connectorId: 'github-1',
          sourceListId: 'foreign-list',
        });

        expect(snapshot.connector).toMatchObject({ id: 'github-1', type: 'github-issues' });
        expect(snapshot.sourceList).toBeNull();
      });

      it('lists retained task ids in a deterministic order scoped to the list', async () => {
        await harness.seedTask({
          id: 'task-b',
          sourceId: 'issue-b',
          connectorInstanceId: 'github-1',
          sourceListId: 'octo/removed',
          title: 'B',
        });
        await harness.seedTask({
          id: 'task-a',
          sourceId: 'issue-a',
          connectorInstanceId: 'github-1',
          sourceListId: 'octo/removed',
          title: 'A',
        });
        await harness.seedTask({
          id: 'task-other',
          sourceId: 'issue-c',
          connectorInstanceId: 'github-1',
          sourceListId: 'octo/active',
          title: 'C',
        });

        expect(await persistence.retainedSourceLists.listRetainedTaskIds({
          connectorId: 'github-1',
          sourceListSourceId: 'octo/removed',
        })).toEqual(['task-a', 'task-b']);
      });

      it('deletes only the list owned by the connector', async () => {
        await persistence.retainedSourceLists.deleteSourceList({
          connectorId: 'github-1',
          sourceListId: 'foreign-list',
        });
        expect(await harness.listSourceListIds()).toEqual(['foreign-list', 'retained-list']);

        await persistence.retainedSourceLists.deleteSourceList({
          connectorId: 'github-1',
          sourceListId: 'retained-list',
        });
        expect(await harness.listSourceListIds()).toEqual(['foreign-list']);
      });
    });

    describe('exports', () => {
      it('pages tasks with an exclusive id cursor', async () => {
        for (const id of ['task-1', 'task-2', 'task-3']) {
          await harness.seedTask({
            id,
            sourceId: id,
            connectorInstanceId: 'connector-1',
            title: id,
          });
        }

        const first = await persistence.exports.listTasksPage({ limit: 2 });
        const second = await persistence.exports.listTasksPage({
          afterId: String(first[first.length - 1].id),
          limit: 2,
        });

        expect(first.map((row) => row.id)).toEqual(['task-1', 'task-2']);
        expect(second.map((row) => row.id)).toEqual(['task-3']);
        expect(first[0]).toMatchObject({ id: 'task-1', title: 'task-1' });
        expect(first[0]).not.toHaveProperty('searchVector');
      });

      it('pages task tags by the declared (taskId, tagId) order', async () => {
        await harness.seedTag({ id: 'tag-a', slug: 'tag-a' });
        await harness.seedTag({ id: 'tag-b', slug: 'tag-b' });
        for (const id of ['task-1', 'task-2']) {
          await harness.seedTask({
            id,
            sourceId: id,
            connectorInstanceId: 'connector-1',
            title: id,
          });
          await harness.seedTaskTag(id, 'tag-a');
          await harness.seedTaskTag(id, 'tag-b');
        }

        const first = await persistence.exports.listTaskTagsPage({ limit: 3 });
        const second = await persistence.exports.listTaskTagsPage({
          after: {
            taskId: String(first[first.length - 1].taskId),
            tagId: String(first[first.length - 1].tagId),
          },
          limit: 3,
        });

        expect(first).toEqual([
          { taskId: 'task-1', tagId: 'tag-a' },
          { taskId: 'task-1', tagId: 'tag-b' },
          { taskId: 'task-2', tagId: 'tag-a' },
        ]);
        expect(second).toEqual([{ taskId: 'task-2', tagId: 'tag-b' }]);
      });

      it('projects connectors to public columns and hides deleted rows', async () => {
        await harness.seedConnector({ id: 'connector-a', type: 'github-issues', name: 'A' });
        await harness.seedConnector({
          id: 'connector-b',
          type: 'microsoft-todo',
          name: 'B',
          deletedAt: OPERATIONAL_UTILITY_NOW,
        });

        const records = await persistence.exports.listConnectorsPage({ limit: 10 });

        expect(records).toHaveLength(1);
        expect(Object.keys(records[0]).sort()).toEqual(['enabled', 'id', 'name', 'type']);
        expect(records[0]).toMatchObject({ id: 'connector-a', type: 'github-issues', name: 'A' });
      });

      it('pages the sync log by id', async () => {
        await harness.seedConnector({ id: 'connector-a', type: 'github-issues', name: 'A' });
        await harness.seedSyncLogEntry('sync-2');
        await harness.seedSyncLogEntry('sync-1');

        const records = await persistence.exports.listSyncLogPage({ limit: 10 });

        expect(records.map((row) => row.id)).toEqual(['sync-1', 'sync-2']);
      });
    });

    describe('feature snapshot', () => {
      it('returns enabled, non-deleted connectors ordered by createdAt then id', async () => {
        await harness.seedConnector({
          id: 'connector-late',
          type: 'github-issues',
          name: 'Late',
          createdAt: '2026-09-03T00:00:00.000Z',
        });
        await harness.seedConnector({
          id: 'connector-b-early',
          type: 'microsoft-todo',
          name: 'Early B',
          createdAt: '2026-09-01T00:00:00.000Z',
        });
        await harness.seedConnector({
          id: 'connector-a-early',
          type: 'microsoft-todo',
          name: 'Early A',
          createdAt: '2026-09-01T00:00:00.000Z',
        });
        await harness.seedConnector({
          id: 'connector-disabled',
          type: 'scout',
          name: 'Disabled',
          enabled: false,
          createdAt: '2026-09-01T00:00:00.000Z',
        });
        await harness.seedConnector({
          id: 'connector-deleted',
          type: 'scout',
          name: 'Deleted',
          createdAt: '2026-09-01T00:00:00.000Z',
          deletedAt: OPERATIONAL_UTILITY_NOW,
        });

        const snapshot = await persistence.features.listActiveConnectors();

        expect(snapshot.map((connector) => connector.id))
          .toEqual(['connector-a-early', 'connector-b-early', 'connector-late']);
        expect(snapshot[0]).toMatchObject({ type: 'microsoft-todo', name: 'Early A' });
      });
    });

    describe('public demo runtime', () => {
      it('records and updates the seed marker idempotently', async () => {
        await persistence.publicDemo.ensureReady();
        await persistence.publicDemo.markSeeded('2026-09-14T00:00:00.000Z');
        await persistence.publicDemo.markSeeded('2026-09-15T00:00:00.000Z');

        expect(await harness.readSeedMarker())
          .toEqual({ id: 'seed', seededAt: '2026-09-15T00:00:00.000Z' });
      });
    });
  });
}
