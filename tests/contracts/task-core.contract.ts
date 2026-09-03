import { describe, expect, it, beforeEach } from 'vitest';
import type {
  PendingSyncTaskMoveRequest,
  TaskCorePersistence,
  TaskFilterSpec,
} from '@/lib/tasks/core/contracts';

/**
 * Shared, backend-neutral contract suite for the L04 task-core persistence
 * composition.
 *
 * The same assertions run against the SQLite adapter (in-process, real
 * better-sqlite3) and the PostgreSQL adapter (guarded live integration).
 * Anywhere the two dialects disagree — jsonb vs. TEXT metadata, real booleans
 * vs. 0/1, `IS` vs. `IS NOT DISTINCT FROM` — the disagreement has to be
 * resolved *inside* the adapters, because these expectations are identical.
 */

export interface SeedTask {
  id: string;
  sourceId?: string;
  connectorType?: string;
  connectorInstanceId?: string;
  title?: string;
  description?: string | null;
  status?: string;
  localDisposition?: string;
  priority?: string;
  planningHorizon?: string | null;
  dueDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  parentId?: string | null;
  depth?: number;
  isChecklistItem?: boolean;
  sourceListId?: string | null;
  sourceListName?: string | null;
  assignee?: string | null;
  microStatus?: string | null;
  metadata?: Record<string, unknown>;
  syncStatus?: string;
  lastSyncedAt?: string;
  effort?: number | null;
}

export interface SeedTag {
  id: string;
  name: string;
  slug: string;
  type?: string;
  source?: string | null;
  color?: string | null;
  confirmed?: boolean;
  createdAt?: string;
  unifiedInto?: string | null;
}

export interface SeedSourceList {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  type?: string;
  userDisplayName?: string | null;
  groupId?: string | null;
  iconColor?: string | null;
}

export interface SeedConnector {
  id: string;
  type: string;
  name?: string;
  enabled?: boolean;
  settings?: Record<string, unknown>;
  syncedLists?: string[];
  deletedAt?: string | null;
}

export interface SeedAttachment {
  id: string;
  taskId: string;
  name: string;
  contentType?: string;
  size: number;
  contentBase64?: string | null;
  sourceAttachmentId?: string | null;
  createdAt?: string;
}

export interface SeedPriorityEntity {
  id: string;
  name: string;
  type: string;
  referenceId?: string | null;
  rank?: number;
}

export interface SeedSchedule {
  taskId: string;
  scheduledDate?: string;
  scheduledTime?: string | null;
  estimatedDuration?: number | null;
  isTimeBlocked?: boolean;
  recurrence?: string | null;
  recurrenceMode?: 'schedule' | 'completion';
}

export interface TaskCoreContractHarness {
  readonly persistence: TaskCorePersistence;
  reset(): Promise<void>;
  insertTasks(rows: SeedTask[]): Promise<void>;
  insertTags(rows: SeedTag[]): Promise<void>;
  insertTaskTags(rows: Array<{ taskId: string; tagId: string }>): Promise<void>;
  insertProjects(rows: Array<{ id: string; name: string }>): Promise<void>;
  insertTaskProjects(rows: Array<{ taskId: string; projectId: string }>): Promise<void>;
  insertSourceLists(rows: SeedSourceList[]): Promise<void>;
  insertMyDayItems(rows: Array<{ id: string; taskId: string; date: string }>): Promise<void>;
  insertConnectors(rows: SeedConnector[]): Promise<void>;
  setAppSetting(key: string, value: unknown): Promise<void>;
  insertAttachments(rows: SeedAttachment[]): Promise<void>;
  insertPriorityEntities(rows: SeedPriorityEntity[]): Promise<void>;
  insertMyDayExclusion(row: { id: string; taskId: string; date: string }): Promise<void>;
  insertTaskSchedules(rows: SeedSchedule[]): Promise<void>;
  listTaskIds(): Promise<string[]>;
  listTaskTagIds(taskId: string): Promise<string[]>;
  listTaskProjectIds(taskId: string): Promise<string[]>;
  listIngestSuppressions(): Promise<Array<{ connectorInstanceId: string; sourceId: string }>>;
  listAttachmentTaskIds(): Promise<string[]>;
  listMyDayTaskIds(): Promise<string[]>;
  getTaskUpdatedAt(taskId: string): Promise<string | null>;
  countMyDayItems(): Promise<number>;
}

const TODAY = '2026-08-10';
const WEEK = '2026-08-17';
const RECENT_CUTOFF = '2026-08-03';

export function makeSpec(overrides: Partial<TaskFilterSpec> = {}): TaskFilterSpec {
  return {
    connectorTypes: [],
    statuses: [],
    priorities: [],
    planningHorizons: [],
    planningHorizonIsNull: false,
    localDispositions: [],
    excludeClosedStatuses: false,
    openOnly: false,
    parentOnly: false,
    sourceListIds: [],
    sourceListGroupId: null,
    createdAtMax: null,
    createdAtMin: null,
    filterQuery: null,
    tagSlug: null,
    tagSlugs: [],
    projectId: null,
    quickFilter: null,
    myDayDate: TODAY,
    today: TODAY,
    weekFromNow: WEEK,
    recentCutoff: RECENT_CUTOFF,
    ...overrides,
  };
}

const NOW = '2026-08-05T12:00:00.000Z';

function baseTasks(): SeedTask[] {
  return [
    {
      id: 'task-alpha',
      title: 'Alpha ships today',
      connectorType: 'github-issues',
      connectorInstanceId: 'gh-1',
      sourceId: 'gh-1:1',
      priority: 'high',
      status: 'todo',
      dueDate: TODAY,
      assignee: 'octocat',
      sourceListId: 'repo-a',
      sourceListName: 'Repo A',
      planningHorizon: 'next',
      metadata: { issueNumber: 1 },
      effort: 3,
    },
    {
      id: 'task-beta',
      title: 'Beta is overdue',
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceId: 'local:task-beta',
      priority: 'medium',
      status: 'in_progress',
      dueDate: '2026-08-01',
      microStatus: 'waiting_on_someone',
      metadata: {},
      effort: null,
    },
    {
      id: 'task-gamma',
      title: 'Gamma is done',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'ms-1',
      sourceId: 'ms-1:g',
      priority: 'low',
      status: 'done',
      completedAt: '2026-08-06T00:00:00.000Z',
      dueDate: null,
      metadata: {},
    },
    {
      id: 'task-delta',
      title: 'Delta is dismissed',
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceId: 'local:task-delta',
      localDisposition: 'dismissed',
      priority: 'none',
      status: 'todo',
      dueDate: null,
      metadata: {},
    },
  ];
}

export function describeTaskCoreContract(
  label: string,
  createHarness: () => Promise<TaskCoreContractHarness>,
): void {
  describe(`task-core contract: ${label}`, () => {
    let harness: TaskCoreContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
    });

    describe('canonical filter semantics', () => {
      beforeEach(async () => {
        await harness.insertTasks(baseTasks());
        await harness.insertTags([
          { id: 'tag-feature', name: 'Feature', slug: 'feature' },
          { id: 'tag-feature-dup', name: 'Feature duplicate', slug: 'feature' },
          { id: 'tag-api', name: 'API', slug: 'api' },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-alpha', tagId: 'tag-feature' },
          { taskId: 'task-alpha', tagId: 'tag-feature-dup' },
          { taskId: 'task-alpha', tagId: 'tag-api' },
          { taskId: 'task-beta', tagId: 'tag-feature' },
        ]);
        await harness.insertProjects([{ id: 'project-1', name: 'Project One' }]);
        await harness.insertTaskProjects([{ taskId: 'task-beta', projectId: 'project-1' }]);
      });

      it('an empty spec matches every visible task', async () => {
        const count = await harness.persistence.queries.countTasks(makeSpec());
        expect(count).toBe(4);
      });

      it('applies the default active disposition without dropping other rows', async () => {
        const count = await harness.persistence.queries.countTasks(
          makeSpec({ localDispositions: ['active'] }),
        );
        expect(count).toBe(3);
      });

      it('excludes closed statuses only when asked', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ excludeClosedStatuses: true }),
        )).toBe(3);
        expect(await harness.persistence.queries.countTasks(makeSpec())).toBe(4);
      });

      it('treats an unknown connector/status/priority value as matching nothing', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ connectorTypes: ['does-not-exist'] }),
        )).toBe(0);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ statuses: ['todo', 'nope'] }),
        )).toBe(2);
      });

      it('distinguishes a NULL planning horizon from a set one', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ planningHorizons: ['next'] }),
        )).toBe(1);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ planningHorizonIsNull: true }),
        )).toBe(3);
      });

      it('requires every requested tag slug, collapsing duplicate tag rows', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ tagSlugs: ['feature'] }),
        )).toBe(2);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ tagSlugs: ['feature', 'api'] }),
        )).toBe(1);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ tagSlugs: ['feature', 'missing'] }),
        )).toBe(0);
      });

      it('matches project membership without duplicating task rows', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ projectId: 'project-1' }),
        )).toBe(1);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ projectId: 'unknown-project' }),
        )).toBe(0);
      });

      it('honours the created-at age window boundaries inclusively', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ createdAtMax: NOW }),
        )).toBe(4);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ createdAtMin: NOW }),
        )).toBe(4);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ createdAtMax: '2026-08-04T00:00:00.000Z' }),
        )).toBe(0);
      });

      it('compiles positive and negated filter-query tokens identically', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'priority:high' }),
        )).toBe(1);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'priority:>=medium' }),
        )).toBe(2);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: '-source:local' }),
        )).toBe(2);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'tag:none' }),
        )).toBe(2);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'assignee:none' }),
        )).toBe(3);
      });

      it('matches metadata substrings regardless of the stored JSON representation', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'issueNumber' }),
        )).toBe(1);
      });

      it('matches substring filters without ASCII case sensitivity', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ filterQuery: 'ALPHA' }),
        )).toBe(1);
      });

      it('scopes to a source list by bare id and by connector-qualified id', async () => {
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ sourceListIds: ['repo-a'] }),
        )).toBe(1);
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ sourceListIds: ['gh-1:repo-a'] }),
        )).toBe(1);
        // A connector-qualified id only matches inside its own connector.
        expect(await harness.persistence.queries.countTasks(
          makeSpec({ sourceListIds: ['other:repo-a'] }),
        )).toBe(0);
      });

      it('hides tasks belonging to a soft-deleted connector', async () => {
        await harness.insertConnectors([
          { id: 'gh-1', type: 'github-issues', deletedAt: '2026-08-09T00:00:00.000Z' },
        ]);
        expect(await harness.persistence.queries.countTasks(makeSpec())).toBe(3);
      });
    });

    describe('quick filters and stats', () => {
      beforeEach(async () => {
        await harness.insertTasks(baseTasks());
        await harness.insertMyDayItems([
          { id: 'my-day-1', taskId: 'task-beta', date: TODAY },
        ]);
      });

      it('resolves My Day membership from stored rows', async () => {
        expect(await harness.persistence.filterInputs.listMyDayTaskIds(TODAY))
          .toEqual(['task-beta']);
        expect(await harness.persistence.filterInputs.listMyDayTaskIds('2020-01-01'))
          .toEqual([]);
      });

      it('applies quick filters only to the task set, never to the stats denominator', async () => {
        const spec = makeSpec({ quickFilter: 'overdue' });
        expect(await harness.persistence.queries.countTasks(spec)).toBe(4);
        expect(await harness.persistence.queries.countTasks(spec, { includeQuickFilter: true }))
          .toBe(1);
      });

      it('computes every stat counter over the same base filter', async () => {
        const stats = await harness.persistence.queries.getStats(makeSpec());
        expect(stats.totalOpen).toBe(3);
        expect(stats.overdue).toBe(1);
        expect(stats.dueToday).toBe(1);
        expect(stats.dueThisWeek).toBe(1);
        expect(stats.noDate).toBe(1);
        expect(stats.highPriority).toBe(1);
        expect(stats.myDay).toBe(1);
        expect(stats.waiting).toBe(1);
        expect(stats.recentlyClosed).toBe(1);
      });

      it('reads GitHub identity evidence only from enabled, non-deleted connectors', async () => {
        await harness.insertConnectors([
          { id: 'gh-1', type: 'github-issues', settings: { authenticatedUser: 'octocat' } },
          {
            id: 'gh-2',
            type: 'github-issues',
            enabled: false,
            settings: { authenticatedUser: 'ghost' },
          },
          {
            id: 'gh-3',
            type: 'github-issues',
            deletedAt: '2026-08-01T00:00:00.000Z',
            settings: { authenticatedUser: 'deleted' },
          },
        ]);
        expect(await harness.persistence.filterInputs.listAssignedGitHubUsernames())
          .toEqual(['octocat']);
      });

      it('reads inbox list configuration from app settings, tolerating junk entries', async () => {
        await harness.setAppSetting('inbox.lists', [
          { connectorType: 'microsoft-todo', sourceListName: 'Tasks' },
          { sourceListName: 'no connector type' },
          'not an object',
        ]);
        expect(await harness.persistence.filterInputs.listInboxListEntries()).toEqual([
          { connectorType: 'microsoft-todo', sourceListId: undefined, sourceListName: 'Tasks' },
        ]);
      });

      it('returns an empty inbox list configuration when the setting is absent', async () => {
        expect(await harness.persistence.filterInputs.listInboxListEntries()).toEqual([]);
      });

      it('counts tasks per connector type over the base filter', async () => {
        expect(await harness.persistence.queries.getSourceCounts(makeSpec())).toEqual({
          'github-issues': 1,
          local: 2,
          'microsoft-todo': 1,
        });
      });
    });

    describe('deterministic ordering', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          { id: 'ord-c', title: 'Same', priority: 'high', dueDate: '2026-08-10' },
          { id: 'ord-a', title: 'Same', priority: 'high', dueDate: '2026-08-10' },
          { id: 'ord-b', title: 'Same', priority: 'high', dueDate: '2026-08-10' },
          { id: 'ord-z', title: 'Later', priority: 'low', dueDate: '2026-08-12' },
        ]);
      });

      it('breaks ties by id so both backends agree on page boundaries', async () => {
        const ids = await harness.persistence.queries.listTaskIds(makeSpec(), {
          order: { field: 'dueDate', direction: 'asc' },
          limit: 10,
          offset: 0,
        });
        expect(ids).toEqual(['ord-a', 'ord-b', 'ord-c', 'ord-z']);
      });

      it('paginates without repeating or skipping a tied row', async () => {
        const page = (offset: number) => harness.persistence.queries.listTaskIds(makeSpec(), {
          order: { field: 'priority', direction: 'asc' },
          limit: 2,
          offset,
        });
        expect(await page(0)).toEqual(['ord-a', 'ord-b']);
        expect(await page(2)).toEqual(['ord-c', 'ord-z']);
      });

      it('sorts descending deterministically as well', async () => {
        const ids = await harness.persistence.queries.listTaskIds(makeSpec(), {
          order: { field: 'dueDate', direction: 'desc' },
          limit: 10,
          offset: 0,
        });
        expect(ids[0]).toBe('ord-z');
        expect(ids.slice(1)).toEqual(['ord-a', 'ord-b', 'ord-c']);
      });

      it('uses backend-independent binary collation for text ordering', async () => {
        await harness.insertTasks([
          { id: 'case-upper', title: 'Zebra', connectorType: 'case-order' },
          { id: 'case-lower', title: 'apple', connectorType: 'case-order' },
        ]);
        const ids = await harness.persistence.queries.listTaskIds(
          makeSpec({ connectorTypes: ['case-order'] }),
          {
            order: { field: 'title', direction: 'asc' },
            limit: 10,
            offset: 0,
          },
        );
        expect(ids).toEqual(['case-upper', 'case-lower']);
      });
    });

    /**
     * NULL placement for the nullable sort columns is a real dialect
     * difference — SQLite treats NULL as the lowest value, PostgreSQL defaults
     * to NULLS LAST ascending — so both adapters have to state it explicitly.
     * The pinned behavior is "NULL sorts lowest", which is what the legacy
     * SQLite `/api/tasks` route already returns.
     */
    describe('nullable sort ordering', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          { id: 'nul-a', title: 'No date', dueDate: null, sourceListName: null, effort: null },
          { id: 'nul-b', title: 'No date', dueDate: null, sourceListName: null, effort: null },
          { id: 'set-x', title: 'Earlier', dueDate: '2026-08-09', sourceListName: 'Alpha', effort: 1 },
          { id: 'set-y', title: 'Later', dueDate: '2026-08-11', sourceListName: 'Beta', effort: 5 },
        ]);
      });

      const page = (
        field: 'dueDate' | 'sourceList' | 'effort',
        direction: 'asc' | 'desc',
        limit = 10,
        offset = 0,
      ) => harness.persistence.queries.listTaskIds(makeSpec(), {
        order: { field, direction },
        limit,
        offset,
      });

      it('places a null dueDate first ascending and last descending', async () => {
        expect(await page('dueDate', 'asc')).toEqual(['nul-a', 'nul-b', 'set-x', 'set-y']);
        expect(await page('dueDate', 'desc')).toEqual(['set-y', 'set-x', 'nul-a', 'nul-b']);
      });

      it('keeps the null dueDate page boundary stable in both directions', async () => {
        expect(await page('dueDate', 'asc', 2, 0)).toEqual(['nul-a', 'nul-b']);
        expect(await page('dueDate', 'asc', 2, 2)).toEqual(['set-x', 'set-y']);
        expect(await page('dueDate', 'desc', 2, 0)).toEqual(['set-y', 'set-x']);
        expect(await page('dueDate', 'desc', 2, 2)).toEqual(['nul-a', 'nul-b']);
      });

      it('places a null sourceListName first ascending and last descending', async () => {
        expect(await page('sourceList', 'asc')).toEqual(['nul-a', 'nul-b', 'set-x', 'set-y']);
        expect(await page('sourceList', 'desc')).toEqual(['set-y', 'set-x', 'nul-a', 'nul-b']);
      });

      it('keeps the null sourceListName page boundary stable in both directions', async () => {
        expect(await page('sourceList', 'asc', 2, 2)).toEqual(['set-x', 'set-y']);
        expect(await page('sourceList', 'desc', 2, 2)).toEqual(['nul-a', 'nul-b']);
      });

      /**
       * `effort` is coalesced to the largest sortable integer on both backends
       * rather than left NULL, so "unknown effort" sorts last ascending. That
       * is deliberately *not* the legacy route's `COALESCE(effort, 0)`; the
       * divergence is documented in `docs/architecture/persistence-boundaries.md`
       * and belongs to the read-route migration, not to this contract. What
       * this pins is that both adapters agree.
       */
      it('sorts a null effort last ascending and first descending on both backends', async () => {
        expect(await page('effort', 'asc')).toEqual(['set-x', 'set-y', 'nul-a', 'nul-b']);
        expect(await page('effort', 'desc')).toEqual(['nul-a', 'nul-b', 'set-y', 'set-x']);
      });
    });

    describe('available tags', () => {
      it('normalizes the confirmed flag to a real boolean and counts per tag', async () => {
        await harness.insertTasks(baseTasks());
        await harness.insertTags([
          { id: 'tag-yes', name: 'Confirmed', slug: 'confirmed', confirmed: true },
          { id: 'tag-no', name: 'Unconfirmed', slug: 'unconfirmed', confirmed: false },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-alpha', tagId: 'tag-yes' },
          { taskId: 'task-beta', tagId: 'tag-yes' },
          { taskId: 'task-beta', tagId: 'tag-no' },
        ]);

        const tags = await harness.persistence.queries.getAvailableTags(makeSpec());
        expect(tags.map((tag) => [tag.slug, tag.count, tag.confirmed])).toEqual([
          ['confirmed', 2, true],
          ['unconfirmed', 1, false],
        ]);
      });

      it('returns nothing when no task matches', async () => {
        expect(await harness.persistence.queries.getAvailableTags(
          makeSpec({ connectorTypes: ['nope'] }),
        )).toEqual([]);
      });
    });

    describe('policy identity loading', () => {
      beforeEach(async () => {
        await harness.insertTasks(baseTasks());
      });

      it('omits unknown ids instead of failing', async () => {
        const rows = await harness.persistence.policyIdentities.listTaskSourceIdentities([
          'task-alpha',
          'missing',
          'task-alpha',
          '',
        ]);
        expect(rows.map((row) => row.id)).toEqual(['task-alpha']);
      });

      it('returns an empty result for an empty id list', async () => {
        expect(await harness.persistence.policyIdentities.listTaskSourceIdentities([]))
          .toEqual([]);
      });

      it('resolves a single identity and null for an unknown id', async () => {
        const row = await harness.persistence.policyIdentities.getTaskSourceIdentity('task-beta');
        expect(row).toMatchObject({
          id: 'task-beta',
          sourceId: 'local:task-beta',
          connectorType: 'local',
          connectorInstanceId: 'local',
        });
        expect(await harness.persistence.policyIdentities.getTaskSourceIdentity('nope'))
          .toBeNull();
      });

      it('returns null for an unknown dependency id', async () => {
        expect(await harness.persistence.policyIdentities.getDependencyEndpoints('nope'))
          .toBeNull();
      });
    });

    describe('local task lifecycle', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          { id: 'parent', title: 'Parent' },
          { id: 'child', title: 'Child', parentId: 'parent', depth: 1 },
          { id: 'grandchild', title: 'Grandchild', parentId: 'child', depth: 2 },
        ]);
        await harness.insertTags([{ id: 'tag-x', name: 'X', slug: 'x' }]);
        await harness.insertTaskTags([{ taskId: 'parent', tagId: 'tag-x' }]);
        await harness.insertMyDayItems([{ id: 'md-1', taskId: 'parent', date: TODAY }]);
      });

      it('detaches descendants and clears every reference for a non-recursive delete', async () => {
        await harness.persistence.lifecycle.deleteTaskLocally({
          taskId: 'parent',
          recursive: false,
        });
        expect((await harness.listTaskIds()).sort()).toEqual(['child', 'grandchild']);
        expect(await harness.listTaskTagIds('parent')).toEqual([]);
        expect(await harness.countMyDayItems()).toBe(0);
      });

      it('removes the whole subtree for a recursive delete', async () => {
        await harness.persistence.lifecycle.deleteTaskLocally({
          taskId: 'parent',
          recursive: true,
        });
        expect(await harness.listTaskIds()).toEqual([]);
      });

      it('is idempotent for an unknown id and leaves other rows untouched', async () => {
        await harness.persistence.lifecycle.deleteTaskLocally({
          taskId: 'does-not-exist',
          recursive: true,
        });
        expect((await harness.listTaskIds()).sort()).toEqual(['child', 'grandchild', 'parent']);
      });

      it('rewrites a subtree to Mission-Control ownership with retention provenance', async () => {
        await harness.persistence.lifecycle.convertTaskTreeToLocal(
          'parent',
          'keep_local',
          '2026-08-11T00:00:00.000Z',
        );
        const row = await harness.persistence.lifecycle.findTaskByRetentionIdentity({
          connectorId: 'local',
          taskSourceId: 'local:child',
        });
        expect(row?.id).toBe('child');
        expect(row?.metadata).toMatchObject({
          retentionResolution: { action: 'keep_local' },
        });
      });

      it('does not match a retention identity from another connector', async () => {
        expect(await harness.persistence.lifecycle.findTaskByRetentionIdentity({
          connectorId: 'someone-else',
          taskSourceId: 'local:parent',
        })).toBeNull();
      });
    });

    describe('scout hard delete', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          {
            id: 'scout-root',
            title: 'Scout root',
            connectorType: 'scout',
            connectorInstanceId: 'scout-1',
            sourceId: 'scout:email:1',
          },
          {
            id: 'scout-child',
            title: 'Scout child',
            connectorType: 'scout',
            connectorInstanceId: 'scout-1',
            sourceId: 'scout:email:2',
            parentId: 'scout-root',
            depth: 1,
          },
          {
            id: 'scout-local-child',
            title: 'Local child',
            connectorType: 'scout',
            connectorInstanceId: 'scout-1',
            sourceId: 'local:scout-local-child',
            parentId: 'scout-root',
            depth: 1,
          },
          { id: 'other', title: 'Unrelated', connectorType: 'local' },
        ]);
      });

      it('deletes the graph and writes ingest tombstones in one transaction', async () => {
        const result = await harness.persistence.scoutDeletion.hardDeleteScoutTask('scout-root');
        expect(result.kind).toBe('deleted');
        if (result.kind !== 'deleted') return;
        expect(result.deletedTaskIds.sort()).toEqual([
          'scout-child',
          'scout-local-child',
          'scout-root',
        ]);
        expect(await harness.listTaskIds()).toEqual(['other']);

        const suppressions = (await harness.listIngestSuppressions())
          .map((row) => row.sourceId)
          .sort();
        expect(suppressions).toEqual(['scout:email:1', 'scout:email:2']);
      });

      it('is idempotent: a second hard delete reports not-found and writes nothing new', async () => {
        await harness.persistence.scoutDeletion.hardDeleteScoutTask('scout-root');
        const before = await harness.listIngestSuppressions();
        const second = await harness.persistence.scoutDeletion.hardDeleteScoutTask('scout-root');
        expect(second).toEqual({ kind: 'not-found' });
        expect(await harness.listIngestSuppressions()).toHaveLength(before.length);
      });

      it('refuses a non-Scout task without deleting anything', async () => {
        expect(await harness.persistence.scoutDeletion.hardDeleteScoutTask('other'))
          .toEqual({ kind: 'not-scout' });
        expect((await harness.listTaskIds()).length).toBe(4);
        expect(await harness.listIngestSuppressions()).toEqual([]);
      });

      it('reports not-found for an unknown id', async () => {
        expect(await harness.persistence.scoutDeletion.hardDeleteScoutTask('nope'))
          .toEqual({ kind: 'not-found' });
      });
    });

    describe('pending-sync task move', () => {
      const MOVE_NOW = '2026-08-12T09:00:00.000Z';

      beforeEach(async () => {
        await harness.insertConnectors([
          { id: 'target-1', type: 'microsoft-todo', syncedLists: ['list-a'] },
        ]);
        await harness.insertSourceLists([
          {
            id: 'sl-1',
            connectorInstanceId: 'target-1',
            sourceId: 'list-a',
            name: 'List A',
          },
        ]);
        await harness.insertTasks([
          {
            id: 'move-source',
            title: 'Move me',
            connectorType: 'local',
            connectorInstanceId: 'local',
            sourceId: 'local:move-source',
            updatedAt: NOW,
          },
        ]);
        await harness.insertTags([{ id: 'tag-move', name: 'Move', slug: 'move' }]);
        await harness.insertTaskTags([{ taskId: 'move-source', tagId: 'tag-move' }]);
        await harness.insertAttachments([
          {
            id: 'att-1',
            taskId: 'move-source',
            name: 'notes.txt',
            size: 3,
            contentBase64: 'YWJj',
          },
        ]);
      });

      const request = (
        overrides: Partial<PendingSyncTaskMoveRequest> = {},
      ): PendingSyncTaskMoveRequest => ({
        sourceTaskId: 'move-source',
        newTaskId: 'move-successor',
        expectedSourceId: 'local:move-source',
        expectedUpdatedAt: NOW,
        attachmentSnapshot: [{ id: 'att-1', size: 3, sourceAttachmentId: null }],
        targetConnectorType: 'microsoft-todo',
        targetConnectorInstanceId: 'target-1',
        targetSourceListId: 'list-a',
        keepTags: true,
        now: MOVE_NOW,
        ...overrides,
      });

      it('resolves a move target list by id or source id, scoped to the connector', async () => {
        expect(await harness.persistence.moves.findTargetList('target-1', 'sl-1'))
          .toEqual({ id: 'sl-1', sourceId: 'list-a' });
        expect(await harness.persistence.moves.findTargetList('target-1', 'list-a'))
          .toEqual({ id: 'sl-1', sourceId: 'list-a' });
        expect(await harness.persistence.moves.findTargetList('other-connector', 'list-a'))
          .toBeNull();
      });

      it('moves the task atomically, repointing references and removing the source', async () => {
        const outcome = await harness.persistence.moves.executePendingSyncMove(request());
        expect(outcome).toEqual({ kind: 'moved' });
        expect(await harness.listTaskIds()).toEqual(['move-successor']);
        expect(await harness.listTaskTagIds('move-successor')).toEqual(['tag-move']);
        expect(await harness.listAttachmentTaskIds()).toEqual(['move-successor']);
        expect(await harness.persistence.moves.taskExists('move-source')).toBe(false);
      });

      it('rejects a stale updatedAt claim and leaves the source completely intact', async () => {
        const outcome = await harness.persistence.moves.executePendingSyncMove(
          request({ expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }),
        );
        expect(outcome).toEqual({ kind: 'source-changed' });
        expect(await harness.listTaskIds()).toEqual(['move-source']);
        expect(await harness.listTaskTagIds('move-source')).toEqual(['tag-move']);
        expect(await harness.listAttachmentTaskIds()).toEqual(['move-source']);
      });

      it('rejects a mismatched attachment fingerprint (null-safe comparison)', async () => {
        const outcome = await harness.persistence.moves.executePendingSyncMove(
          request({
            attachmentSnapshot: [{ id: 'att-1', size: 3, sourceAttachmentId: 'upstream-1' }],
          }),
        );
        expect(outcome).toEqual({ kind: 'source-changed' });
        expect(await harness.listTaskIds()).toEqual(['move-source']);
      });

      it('rejects a snapshot whose attachment count no longer matches', async () => {
        const outcome = await harness.persistence.moves.executePendingSyncMove(
          request({ attachmentSnapshot: [] }),
        );
        expect(outcome).toEqual({ kind: 'source-changed' });
        expect(await harness.listAttachmentTaskIds()).toEqual(['move-source']);
      });

      it('reports not-found for an unknown source task', async () => {
        const outcome = await harness.persistence.moves.executePendingSyncMove(
          request({ sourceTaskId: 'missing', expectedSourceId: 'local:missing' }),
        );
        expect(outcome).toEqual({ kind: 'not-found' });
      });

      it('does not copy tags when keepTags is false', async () => {
        await harness.persistence.moves.executePendingSyncMove(request({ keepTags: false }));
        expect(await harness.listTaskTagIds('move-successor')).toEqual([]);
      });

      it('exposes the source row and its attachments before the move', async () => {
        expect(await harness.persistence.moves.getMoveSource('move-source')).toMatchObject({
          id: 'move-source',
          sourceId: 'local:move-source',
          updatedAt: NOW,
        });
        expect(await harness.persistence.moves.getMoveSource('nope')).toBeNull();
        const attachments = await harness.persistence.moves.listTaskAttachments('move-source');
        expect(attachments).toHaveLength(1);
        expect(attachments[0]).toMatchObject({ id: 'att-1', size: 3, sourceAttachmentId: null });
      });
    });

    describe('write-through task move', () => {
      const MOVE_NOW = '2026-08-12T09:00:00.000Z';
      const moves = () => harness.persistence.writeThroughMoves;

      beforeEach(async () => {
        await harness.insertConnectors([
          { id: 'target-1', type: 'microsoft-todo', syncedLists: ['list-a'] },
        ]);
        await harness.insertSourceLists([
          { id: 'sl-1', connectorInstanceId: 'target-1', sourceId: 'list-a', name: 'List A' },
        ]);
        await harness.insertProjects([{ id: 'proj-1', name: 'Project One' }]);
        await harness.insertTasks([
          {
            id: 'wt-source',
            title: 'Write-through source',
            description: 'Body',
            connectorType: 'microsoft-todo',
            connectorInstanceId: 'source-1',
            sourceId: 'remote:wt-source',
            updatedAt: NOW,
            metadata: { origin: 'seed' },
          },
          {
            id: 'wt-child',
            title: 'Child',
            parentId: 'wt-source',
            depth: 1,
            connectorType: 'microsoft-todo',
            connectorInstanceId: 'source-1',
            sourceId: 'remote:wt-child',
          },
        ]);
        await harness.insertTags([{ id: 'tag-wt', name: 'WT', slug: 'wt' }]);
        await harness.insertTaskTags([
          { taskId: 'wt-source', tagId: 'tag-wt' },
          { taskId: 'wt-child', tagId: 'tag-wt' },
        ]);
        await harness.insertTaskProjects([
          { taskId: 'wt-source', projectId: 'proj-1' },
          { taskId: 'wt-child', projectId: 'proj-1' },
        ]);
        await harness.insertTaskSchedules([
          { taskId: 'wt-source', scheduledDate: '2026-08-12', recurrence: 'weekly' },
          { taskId: 'wt-child', scheduledDate: '2026-08-13' },
        ]);
        await harness.insertAttachments([
          { id: 'wt-att', taskId: 'wt-source', name: 'notes.txt', size: 3, contentBase64: 'YWJj' },
        ]);
        await harness.insertMyDayItems([
          { id: 'wt-myday', taskId: 'wt-source', date: TODAY },
        ]);
      });

      const successor = async (overrides: Record<string, unknown> = {}) => {
        const source = await moves().getTask('wt-source');
        if (!source) throw new Error('seed missing');
        return {
          ...source,
          id: 'wt-successor',
          sourceId: 'remote:wt-successor',
          connectorInstanceId: 'target-1',
          sourceListId: 'list-a',
          sourceListName: 'List A',
          updatedAt: MOVE_NOW,
          lastSyncedAt: MOVE_NOW,
          syncStatus: 'synced',
          pushRetryCount: 0,
          metadata: { origin: 'seed', movedFrom: { taskId: 'wt-source' } },
          ...overrides,
        };
      };

      /* ---------------------------- reads ---------------------------- */

      it('reads the whole move source, its children, tags, attachments and schedule', async () => {
        const source = await moves().getTask('wt-source');
        expect(source).toMatchObject({
          id: 'wt-source',
          sourceId: 'remote:wt-source',
          title: 'Write-through source',
          description: 'Body',
          syncStatus: 'synced',
          metadata: { origin: 'seed' },
        });
        expect(await moves().getTask('nope')).toBeNull();

        expect((await moves().listChildTasks('wt-source', 10)).map((row) => row.id))
          .toEqual(['wt-child']);
        expect(await moves().listChildTasks('wt-child', 10)).toEqual([]);

        expect(await moves().listTaskTagRefs('wt-source')).toEqual([
          { id: 'tag-wt', name: 'WT', slug: 'wt', type: 'label', color: null },
        ]);

        const attachments = await moves().listAttachmentMetadata(['wt-source', 'wt-child'], 10);
        expect(attachments).toEqual([
          expect.objectContaining({ id: 'wt-att', taskId: 'wt-source', size: 3, sourceAttachmentId: null }),
        ]);
        expect(await moves().listAttachmentMetadata([], 10)).toEqual([]);

        expect(await moves().listAttachmentContents(['wt-att']))
          .toEqual([{ id: 'wt-att', contentBase64: 'YWJj' }]);
        expect(await moves().listAttachmentContents([])).toEqual([]);

        expect(await moves().getTaskSchedule('wt-source'))
          .toMatchObject({ taskId: 'wt-source', recurrence: 'weekly' });
        expect(await moves().getTaskSchedule('nope')).toBeNull();
      });

      it('resolves a destination list by connector-scoped source id only', async () => {
        expect(await moves().findTargetListBySourceId('target-1', 'list-a'))
          .toEqual({ id: 'sl-1', name: 'List A', sourceId: 'list-a' });
        // Deliberately *not* matched by primary key: `targetSourceListId` is the
        // connector's identifier, so a primary-key match would silently accept
        // an id from a different namespace.
        expect(await moves().findTargetListBySourceId('target-1', 'sl-1')).toBeNull();
        expect(await moves().findTargetListBySourceId('other', 'list-a')).toBeNull();
      });

      /* -------------------- optimistic move claim -------------------- */

      const claim = (overrides: Record<string, unknown> = {}) => ({
        taskId: 'wt-source',
        expectedSourceId: 'remote:wt-source',
        expectedSyncStatus: 'synced',
        claimSyncStatus: 'move_in_progress',
        claimToken: 'token-1',
        metadata: {
          origin: 'seed',
          taskMoveClaim: {
            token: 'token-1',
            claimedAt: MOVE_NOW,
            previousSyncStatus: 'synced',
          },
        },
        ...overrides,
      });

      it('claims the source exactly once under concurrency', async () => {
        expect(await moves().claimTaskMove(claim())).toBe(true);
        const claimed = await moves().getTask('wt-source');
        expect(claimed?.syncStatus).toBe('move_in_progress');
        expect(claimed?.metadata).toMatchObject({
          origin: 'seed',
          taskMoveClaim: { token: 'token-1', previousSyncStatus: 'synced' },
        });

        // A second writer that observed the same pre-claim state loses: the
        // guard no longer matches, so the move cannot run twice.
        expect(await moves().claimTaskMove(claim({ claimToken: 'token-2' }))).toBe(false);
        expect((await moves().getTask('wt-source'))?.metadata)
          .toMatchObject({ taskMoveClaim: { token: 'token-1' } });
      });

      it('refuses a claim whose observed sourceId or task id no longer matches', async () => {
        expect(await moves().claimTaskMove(claim({ expectedSourceId: 'remote:stale' })))
          .toBe(false);
        expect(await moves().claimTaskMove(claim({ taskId: 'missing' }))).toBe(false);
        expect((await moves().getTask('wt-source'))?.syncStatus).toBe('synced');
      });

      it('releases a claim only for the matching token, idempotently', async () => {
        await moves().claimTaskMove(claim());

        // A stale token must never restore state it does not own.
        await moves().releaseTaskMoveClaim({
          taskId: 'wt-source',
          claimToken: 'token-other',
          syncStatus: 'synced',
          metadata: { origin: 'hijacked' },
        });
        expect((await moves().getTask('wt-source'))?.syncStatus).toBe('move_in_progress');

        const release = {
          taskId: 'wt-source',
          claimToken: 'token-1',
          syncStatus: 'synced',
          metadata: { origin: 'seed' },
        };
        await moves().releaseTaskMoveClaim(release);
        expect(await moves().getTask('wt-source')).toMatchObject({
          syncStatus: 'synced',
          metadata: { origin: 'seed' },
        });
        // Replaying the release is a no-op: the token is gone.
        await moves().releaseTaskMoveClaim(release);
        expect((await moves().getTask('wt-source'))?.metadata).toEqual({ origin: 'seed' });
      });

      /* ------------------ destination materialization ---------------- */

      it('materializes the destination and the copied subtask graph atomically', async () => {
        const child = await moves().getTask('wt-child');
        if (!child) throw new Error('seed missing');

        await moves().materializeDestination({
          task: await successor(),
          tagIds: ['tag-wt'],
          copyProjectsFromTaskId: 'wt-source',
          schedule: await moves().getTaskSchedule('wt-source'),
          attachments: [{
            id: 'wt-succ-att',
            taskId: 'wt-successor',
            name: 'notes.txt',
            contentType: 'text/plain',
            size: 3,
            contentBase64: 'YWJj',
            createdAt: MOVE_NOW,
          }],
          subtaskCopies: [{
            copyFromTaskId: 'wt-child',
            task: {
              ...child,
              id: 'wt-child-copy',
              sourceId: 'remote:wt-child-copy',
              connectorInstanceId: 'target-1',
              parentId: 'wt-successor',
              updatedAt: MOVE_NOW,
              lastSyncedAt: MOVE_NOW,
              metadata: { copiedFrom: { taskId: 'wt-child' } },
            },
            attachments: [],
          }],
        });

        expect(await harness.listTaskIds())
          .toEqual(['wt-child', 'wt-child-copy', 'wt-source', 'wt-successor']);
        expect(await harness.listTaskTagIds('wt-successor')).toEqual(['tag-wt']);
        expect(await harness.listTaskProjectIds('wt-successor')).toEqual(['proj-1']);
        expect(await moves().getTaskSchedule('wt-successor'))
          .toMatchObject({ taskId: 'wt-successor', recurrence: 'weekly' });
        expect(await harness.listAttachmentTaskIds()).toEqual(['wt-source', 'wt-successor']);
        // The copied subtask carries the source subtask's own tags, projects
        // and schedule, resolved inside the same transaction.
        expect(await harness.listTaskTagIds('wt-child-copy')).toEqual(['tag-wt']);
        expect(await harness.listTaskProjectIds('wt-child-copy')).toEqual(['proj-1']);
        expect(await moves().getTaskSchedule('wt-child-copy'))
          .toMatchObject({ taskId: 'wt-child-copy' });
        expect((await moves().getTask('wt-successor'))?.metadata)
          .toMatchObject({ movedFrom: { taskId: 'wt-source' } });
      });

      it('leaves no partial destination when any part of the materialization fails', async () => {
        const child = await moves().getTask('wt-child');
        if (!child) throw new Error('seed missing');

        await expect(moves().materializeDestination({
          task: await successor(),
          tagIds: ['tag-wt'],
          copyProjectsFromTaskId: 'wt-source',
          schedule: null,
          attachments: [],
          subtaskCopies: [{
            copyFromTaskId: 'wt-child',
            task: {
              ...child,
              id: 'wt-child-copy',
              // Collides with the existing source's (source_id, connector) key.
              sourceId: 'remote:wt-source',
              connectorInstanceId: 'source-1',
              parentId: 'wt-successor',
            },
            attachments: [],
          }],
        })).rejects.toThrow();

        expect(await harness.listTaskIds()).toEqual(['wt-child', 'wt-source']);
        expect(await harness.listTaskTagIds('wt-successor')).toEqual([]);
        expect(await harness.listTaskProjectIds('wt-successor')).toEqual([]);
      });

      it('discards a materialized destination completely and idempotently', async () => {
        await moves().materializeDestination({
          task: await successor(),
          tagIds: ['tag-wt'],
          copyProjectsFromTaskId: 'wt-source',
          schedule: await moves().getTaskSchedule('wt-source'),
          attachments: [{
            id: 'wt-succ-att',
            taskId: 'wt-successor',
            name: 'notes.txt',
            contentType: 'text/plain',
            size: 3,
            contentBase64: 'YWJj',
            createdAt: MOVE_NOW,
          }],
          subtaskCopies: [],
        });

        await moves().discardMaterializedDestination('wt-successor');
        expect(await harness.listTaskIds()).toEqual(['wt-child', 'wt-source']);
        expect(await harness.listTaskTagIds('wt-successor')).toEqual([]);
        expect(await harness.listTaskProjectIds('wt-successor')).toEqual([]);
        expect(await moves().getTaskSchedule('wt-successor')).toBeNull();
        expect(await harness.listAttachmentTaskIds()).toEqual(['wt-source']);

        // Compensation runs on a best-effort path and may be retried.
        await moves().discardMaterializedDestination('wt-successor');
        expect(await harness.listTaskIds()).toEqual(['wt-child', 'wt-source']);
        // The source graph is untouched by compensation.
        expect(await harness.listTaskTagIds('wt-source')).toEqual(['tag-wt']);
      });

      /* ---------------------- move finalization ---------------------- */

      const finalization = (overrides: Record<string, unknown> = {}) => ({
        sourceTaskId: 'wt-source',
        successorTaskId: 'wt-successor',
        claimToken: 'token-1',
        attachmentSnapshot: [{ id: 'wt-att', size: 3, sourceAttachmentId: null }],
        subtaskRepoints: [{
          taskId: 'wt-child',
          sourceId: 'remote:wt-child-moved',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'target-1',
          sourceListId: 'list-a',
          sourceListName: 'List A',
          parentId: 'wt-successor',
          updatedAt: MOVE_NOW,
          syncStatus: 'synced',
          lastSyncedAt: MOVE_NOW,
          attachments: [],
        }],
        sourceDisposition: {
          kind: 'retain' as const,
          status: 'cancelled',
          statusReason: 'moved',
          description: '[Moved] Body',
          updatedAt: MOVE_NOW,
          syncStatus: 'pending_push',
          metadata: {
            origin: 'seed',
            movedTo: { taskId: 'wt-successor' },
            pendingCleanup: true,
          },
        },
        ...overrides,
      });

      const materializeSuccessor = async () => {
        await moves().materializeDestination({
          task: await successor(),
          tagIds: [],
          copyProjectsFromTaskId: null,
          schedule: null,
          attachments: [],
          subtaskCopies: [],
        });
      };

      it('repoints references and records the durable sync intent in one transaction', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();

        expect(await moves().finalizeMove(finalization())).toEqual({ kind: 'finalized' });

        // The retained tombstone carries the pending sync intent exactly once,
        // written atomically with the graph rewrite.
        expect(await moves().getTask('wt-source')).toMatchObject({
          status: 'cancelled',
          statusReason: 'moved',
          syncStatus: 'pending_push',
          metadata: { movedTo: { taskId: 'wt-successor' }, pendingCleanup: true },
        });
        expect(await harness.listMyDayTaskIds()).toEqual(['wt-successor']);
        expect(await harness.listTaskProjectIds('wt-successor')).toEqual(['proj-1']);
        expect(await harness.listTaskProjectIds('wt-source')).toEqual([]);
        expect(await moves().getTaskSchedule('wt-source')).toBeNull();
        expect(await harness.listAttachmentTaskIds()).toEqual([]);
        expect(await moves().getTask('wt-child')).toMatchObject({
          sourceId: 'remote:wt-child-moved',
          connectorInstanceId: 'target-1',
          parentId: 'wt-successor',
          syncStatus: 'synced',
        });
      });

      it('deletes a local source and its tags when the disposition says so', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();

        expect(await moves().finalizeMove(finalization({
          sourceDisposition: { kind: 'delete' },
        }))).toEqual({ kind: 'finalized' });

        expect(await harness.listTaskIds()).toEqual(['wt-child', 'wt-successor']);
        expect(await harness.listTaskTagIds('wt-source')).toEqual([]);
        expect(await harness.listMyDayTaskIds()).toEqual(['wt-successor']);
      });

      it('is exactly-once: a replayed finalization reports source-changed and repoints nothing twice', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();
        await moves().finalizeMove(finalization());

        const replay = await moves().finalizeMove(finalization());
        expect(replay).toEqual({ kind: 'source-changed' });
        expect(await harness.listMyDayTaskIds()).toEqual(['wt-successor']);
        expect(await harness.countMyDayItems()).toBe(1);
        expect(await moves().getTask('wt-source')).toMatchObject({
          syncStatus: 'pending_push',
          statusReason: 'moved',
        });
      });

      it('rejects a stale claim token without mutating anything', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();

        expect(await moves().finalizeMove(finalization({ claimToken: 'token-other' })))
          .toEqual({ kind: 'source-changed' });
        expect(await harness.listMyDayTaskIds()).toEqual(['wt-source']);
        expect(await harness.listTaskProjectIds('wt-source')).toEqual(['proj-1']);
        expect((await moves().getTask('wt-source'))?.syncStatus).toBe('move_in_progress');
        expect(await moves().getTask('wt-child')).toMatchObject({
          sourceId: 'remote:wt-child',
          parentId: 'wt-source',
        });
      });

      it('rejects a changed attachment fingerprint (null-safe) without mutating anything', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();

        expect(await moves().finalizeMove(finalization({
          attachmentSnapshot: [{ id: 'wt-att', size: 3, sourceAttachmentId: 'upstream' }],
        }))).toEqual({ kind: 'source-changed' });
        expect(await moves().finalizeMove(finalization({ attachmentSnapshot: [] })))
          .toEqual({ kind: 'source-changed' });
        expect(await harness.listAttachmentTaskIds()).toEqual(['wt-source']);
        expect(await harness.listMyDayTaskIds()).toEqual(['wt-source']);
      });

      it('rolls back the whole finalization when a repoint fails', async () => {
        await moves().claimTaskMove(claim());
        await materializeSuccessor();

        await expect(moves().finalizeMove(finalization({
          subtaskRepoints: [{
            taskId: 'wt-child',
            // Collides with the successor's (source_id, connector) key.
            sourceId: 'remote:wt-successor',
            connectorType: 'microsoft-todo',
            connectorInstanceId: 'target-1',
            sourceListId: 'list-a',
            sourceListName: 'List A',
            parentId: 'wt-successor',
            updatedAt: MOVE_NOW,
            syncStatus: 'synced',
            lastSyncedAt: MOVE_NOW,
            attachments: [],
          }],
        }))).rejects.toThrow();

        expect(await harness.listMyDayTaskIds()).toEqual(['wt-source']);
        expect(await harness.listTaskProjectIds('wt-source')).toEqual(['proj-1']);
        expect(await harness.listAttachmentTaskIds()).toEqual(['wt-source']);
        expect(await moves().getTask('wt-source')).toMatchObject({
          status: 'todo',
          syncStatus: 'move_in_progress',
        });
      });

      /* ------------------ post-disposal sync intent ------------------ */

      it('settles the source sync intent idempotently after remote disposal', async () => {
        const settle = {
          taskId: 'wt-source',
          syncStatus: 'synced',
          metadata: { origin: 'seed', movedTo: { taskId: 'wt-successor' } },
        };
        await moves().recordSourceSyncIntent(settle);
        expect(await moves().getTask('wt-source')).toMatchObject({
          syncStatus: 'synced',
          metadata: { movedTo: { taskId: 'wt-successor' } },
        });
        await moves().recordSourceSyncIntent(settle);
        expect((await moves().getTask('wt-source'))?.metadata).toEqual({
          origin: 'seed',
          movedTo: { taskId: 'wt-successor' },
        });
        // A settle for an unknown task is a no-op rather than an error.
        await moves().recordSourceSyncIntent({ ...settle, taskId: 'missing' });
        expect(await harness.listTaskIds()).toEqual(['wt-child', 'wt-source']);
      });

      it('records copy provenance without disturbing the source graph', async () => {
        await moves().recordSourceCopyProvenance({
          taskId: 'wt-source',
          updatedAt: MOVE_NOW,
          metadata: { origin: 'seed', copiedTo: { taskId: 'wt-successor' } },
        });
        expect(await moves().getTask('wt-source')).toMatchObject({
          updatedAt: MOVE_NOW,
          syncStatus: 'synced',
          status: 'todo',
          metadata: { copiedTo: { taskId: 'wt-successor' } },
        });
        expect(await harness.listTaskTagIds('wt-source')).toEqual(['tag-wt']);
        expect(await harness.listAttachmentTaskIds()).toEqual(['wt-source']);
      });
    });

    describe('priority entities and source list names', () => {
      it('orders by rank with an id tie-break and resolves references', async () => {
        await harness.insertProjects([{ id: 'project-9', name: 'Ninth' }]);
        await harness.insertTags([
          { id: 'tag-old', name: 'Old', slug: 'old', unifiedInto: 'tag-new' },
          { id: 'tag-new', name: 'New', slug: 'new' },
        ]);
        await harness.insertSourceLists([
          {
            id: 'sl-9',
            connectorInstanceId: 'conn-9',
            sourceId: 'list-9',
            name: 'Raw name',
            userDisplayName: 'Renamed',
          },
        ]);
        await harness.insertPriorityEntities([
          { id: 'pe-b', name: 'B', type: 'project', referenceId: 'project-9', rank: 1 },
          { id: 'pe-a', name: 'A', type: 'person', rank: 1 },
          { id: 'pe-c', name: 'C', type: 'tag', referenceId: 'tag-old', rank: 2 },
        ]);

        const entities = await harness.persistence.priorityEntities.listPriorityEntitiesByRank();
        expect(entities.map((entity) => entity.id)).toEqual(['pe-a', 'pe-b', 'pe-c']);

        expect(await harness.persistence.priorityEntities.getProjectReference('project-9'))
          .toMatchObject({ id: 'project-9', name: 'Ninth' });
        expect(await harness.persistence.priorityEntities.getProjectReference('nope')).toBeNull();
        expect(await harness.persistence.priorityEntities.getTagReference('tag-old'))
          .toMatchObject({ id: 'tag-old', unifiedInto: 'tag-new' });
        expect(await harness.persistence.priorityEntities.getSourceListReference('conn-9', 'list-9'))
          .toMatchObject({ name: 'Raw name', userDisplayName: 'Renamed' });
        expect(await harness.persistence.priorityEntities.getSourceListReference('conn-9', 'nope'))
          .toBeNull();
      });

      it('resolves source list display names and ignores unknown ids', async () => {
        await harness.insertSourceLists([
          {
            id: 'sl-a',
            connectorInstanceId: 'conn-a',
            sourceId: 'list-a',
            name: 'Raw A',
            userDisplayName: 'Pretty A',
          },
        ]);
        expect(await harness.persistence.sourceListNames.listSourceListDisplayNames([
          'list-a',
          'list-a',
          'unknown',
        ])).toEqual([
          {
            connectorInstanceId: 'conn-a',
            sourceId: 'list-a',
            name: 'Raw A',
            userDisplayName: 'Pretty A',
          },
        ]);
        expect(await harness.persistence.sourceListNames.listSourceListDisplayNames([]))
          .toEqual([]);
      });
    });

    describe('transfer-identity reconciliation', () => {
      beforeEach(async () => {
        await harness.insertSourceLists([
          { id: 'sl-ti-x', connectorInstanceId: 'conn-ti', sourceId: 'list-x', name: 'List X' },
          { id: 'sl-ti-y', connectorInstanceId: 'conn-ti', sourceId: 'list-y', name: 'List Y' },
          // Same sourceId under a different connector: must never resolve for 'conn-ti'.
          {
            id: 'sl-other-x',
            connectorInstanceId: 'conn-mismatch',
            sourceId: 'list-x',
            name: 'Other List X',
          },
        ]);
        await harness.insertTasks([
          {
            id: 'ti-task',
            title: 'Transfer identity task',
            connectorType: 'github',
            connectorInstanceId: 'conn-ti',
            sourceId: 'remote:ti-task',
            updatedAt: NOW,
            metadata: { existing: 'a', shared: 'old' },
          },
        ]);
      });

      describe('resolveIdentityTargets', () => {
        it('resolves local ids scoped to the connector, deduplicated and ordered by first occurrence', async () => {
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-ti',
            sourceListIds: ['list-y', 'list-x', 'list-y', 'unknown'],
          });
          expect(result.sourceLists).toEqual([
            { sourceId: 'list-y', localId: 'sl-ti-y' },
            { sourceId: 'list-x', localId: 'sl-ti-x' },
          ]);
        });

        it('does not resolve a source list that belongs to a different connector', async () => {
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-mismatch',
            sourceListIds: ['list-x'],
          });
          expect(result.sourceLists).toEqual([]);
        });

        it('returns an empty source-list array for an empty input', async () => {
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-ti',
            sourceListIds: [],
          });
          expect(result.sourceLists).toEqual([]);
        });

        it('decodes the task current metadata', async () => {
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-ti',
            sourceListIds: [],
          });
          expect(result.taskExists).toBe(true);
          expect(result.taskMetadata).toEqual({ existing: 'a', shared: 'old' });
        });

        it('reports taskExists=false and empty metadata for a missing task, without affecting deterministic source-list resolution', async () => {
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'nope',
            connectorInstanceId: 'conn-ti',
            sourceListIds: ['list-x', 'list-y'],
          });
          expect(result.taskExists).toBe(false);
          expect(result.taskMetadata).toEqual({});
          expect(result.sourceLists).toEqual([
            { sourceId: 'list-x', localId: 'sl-ti-x' },
            { sourceId: 'list-y', localId: 'sl-ti-y' },
          ]);
        });
      });

      describe('reconcileTaskRefresh', () => {
        const refreshTask = (overrides: Record<string, unknown> = {}) => ({
          sourceId: 'remote:ti-task-2',
          sourceListId: 'list-y',
          sourceListName: 'List Y',
          title: 'Refreshed title',
          description: 'Refreshed body',
          status: 'in_progress',
          statusReason: 'waiting_on_review',
          priority: 'high',
          effort: 3,
          microStatus: 'blocked_external',
          assignee: 'octocat',
          updatedAt: '2026-08-15T00:00:00.000Z',
          completedAt: null,
          metadata: { shared: 'new', added: 'b' },
          ...overrides,
        });

        it('updates exactly the reconciled fields, syncStatus and lastSyncedAt, and returns true', async () => {
          const result = await harness.persistence.transferIdentity.reconcileTaskRefresh({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-ti',
            task: refreshTask(),
            observedAt: '2026-08-15T00:01:00.000Z',
          });
          expect(result).toBe(true);

          const row = await harness.persistence.writeThroughMoves.getTask('ti-task');
          expect(row).toMatchObject({
            sourceId: 'remote:ti-task-2',
            sourceListId: 'list-y',
            sourceListName: 'List Y',
            title: 'Refreshed title',
            description: 'Refreshed body',
            status: 'in_progress',
            statusReason: 'waiting_on_review',
            priority: 'high',
            effort: 3,
            microStatus: 'blocked_external',
            assignee: 'octocat',
            updatedAt: '2026-08-15T00:00:00.000Z',
            completedAt: null,
            syncStatus: 'synced',
            lastSyncedAt: '2026-08-15T00:01:00.000Z',
          });
        });

        it('merges incoming metadata over the existing metadata, incoming winning on collision', async () => {
          await harness.persistence.transferIdentity.reconcileTaskRefresh({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-ti',
            task: refreshTask({ metadata: { shared: 'new', added: 'b' } }),
            observedAt: '2026-08-15T00:01:00.000Z',
          });
          const row = await harness.persistence.writeThroughMoves.getTask('ti-task');
          expect(row?.metadata).toEqual({ existing: 'a', shared: 'new', added: 'b' });
        });

        it('returns false and makes no update when the task does not exist', async () => {
          const result = await harness.persistence.transferIdentity.reconcileTaskRefresh({
            taskId: 'nope',
            connectorInstanceId: 'conn-ti',
            task: refreshTask(),
            observedAt: '2026-08-15T00:01:00.000Z',
          });
          expect(result).toBe(false);
        });

        it('returns false and makes no update when connectorInstanceId does not match', async () => {
          const result = await harness.persistence.transferIdentity.reconcileTaskRefresh({
            taskId: 'ti-task',
            connectorInstanceId: 'conn-mismatch',
            task: refreshTask(),
            observedAt: '2026-08-15T00:01:00.000Z',
          });
          expect(result).toBe(false);

          const row = await harness.persistence.writeThroughMoves.getTask('ti-task');
          expect(row).toMatchObject({
            title: 'Transfer identity task',
            metadata: { existing: 'a', shared: 'old' },
          });
        });
      });
    });
  });
}
