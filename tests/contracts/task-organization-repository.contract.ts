import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalDisposition } from '@/types';
import type {
  SubtaskTemplateSeed,
  TaskOrganizationRepository,
} from '@/lib/tasks/core/contracts';

/**
 * Shared behavioural contract for `TaskCorePersistence.organization`.
 *
 * Both the SQLite adapter and the PostgreSQL adapter must satisfy it byte for
 * byte: same rows, same ordering, same outcome unions, and — for the operations
 * routes rely on to be all-or-nothing — the same atomicity and concurrency
 * guarantees. The suite deliberately drives the repository through its public
 * typed methods only; it never reaches for a driver handle or raw SQL.
 */

export interface SeedTaskRow {
  readonly id: string;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: string;
  readonly priority?: string;
  readonly connectorType?: string;
  readonly connectorInstanceId?: string;
  readonly sourceId?: string;
  readonly sourceListId?: string | null;
  readonly sourceListName?: string | null;
  readonly parentId?: string | null;
  readonly depth?: number;
  readonly isChecklistItem?: boolean;
  readonly localDisposition?: LocalDisposition;
  readonly effort?: number | null;
  readonly dueDate?: string | null;
  readonly assignee?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SeedTagRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly type?: string;
  readonly source?: string | null;
  readonly color?: string | null;
  readonly confirmed?: boolean;
  readonly unifiedInto?: string | null;
  readonly createdAt?: string;
}

export interface SeedSourceListRow {
  readonly id: string;
  readonly connectorInstanceId: string;
  readonly sourceId: string;
  readonly name: string;
}

export interface SeedScheduleRow {
  readonly taskId: string;
  readonly scheduledDate?: string;
  readonly scheduledTime?: string | null;
  readonly estimatedDuration?: number | null;
  readonly isTimeBlocked?: boolean;
  readonly recurrence?: string | null;
}

export interface SeedAttachmentRow {
  readonly id: string;
  readonly taskId: string;
  readonly name: string;
  readonly size: number;
  readonly sourceAttachmentId?: string | null;
}

export interface SeedProjectRow {
  readonly id: string;
  readonly name: string;
}

export interface SeedSourceRankingRow {
  readonly id: string;
  readonly connectorType: string;
  readonly name: string;
  readonly rank: number;
}

export interface TaskOrganizationContractHarness {
  readonly repository: TaskOrganizationRepository;
  reset(): Promise<void>;
  insertTasks(rows: readonly SeedTaskRow[]): Promise<void>;
  insertTags(rows: readonly SeedTagRow[]): Promise<void>;
  insertTaskTags(
    rows: ReadonlyArray<{ readonly taskId: string; readonly tagId: string }>,
  ): Promise<void>;
  insertSourceLists(rows: readonly SeedSourceListRow[]): Promise<void>;
  insertSchedules(rows: readonly SeedScheduleRow[]): Promise<void>;
  insertAttachments(rows: readonly SeedAttachmentRow[]): Promise<void>;
  insertProjects(rows: readonly SeedProjectRow[]): Promise<void>;
  insertTaskProjects(
    rows: ReadonlyArray<{ readonly taskId: string; readonly projectId: string }>,
  ): Promise<void>;
  insertSourceRankings(rows: readonly SeedSourceRankingRow[]): Promise<void>;
  /** Ids of every tag currently stored, sorted. */
  listTagIds(): Promise<string[]>;
  /** `unifiedInto` for one tag, or `undefined` when the tag is gone. */
  getTagUnifiedInto(tagId: string): Promise<string | null | undefined>;
  /** Tag ids linked to a task, sorted. */
  listTaskTagIds(taskId: string): Promise<string[]>;
  /** Ids of every task currently stored, sorted. */
  listTaskIds(): Promise<string[]>;
  /** Parent id for one task, or `undefined` when the task is gone. */
  getTaskParentId(taskId: string): Promise<string | null | undefined>;
  deleteTask(taskId: string, recursive: boolean): Promise<void>;
  /** `sourceListId` / `sourceId` for one task. */
  getTaskSource(
    taskId: string,
  ): Promise<{ sourceListId: string | null; sourceId: string } | null>;
  /**
   * Forces the next `mergeTags` write to abort mid-transaction so the suite can
   * prove the merge rolls back as a unit. Returns the thrown error.
   */
  forceMergeFailure(input: {
    readonly targetTagId: string;
    readonly sourceTagIds: readonly string[];
  }): Promise<unknown>;
}

const NOW = '2026-09-01T09:00:00.000Z';

function seed(overrides: Partial<SubtaskTemplateSeed> & Pick<SubtaskTemplateSeed, 'id'>) {
  return {
    name: overrides.id,
    description: 'Built-in',
    category: 'work',
    type: 'single',
    icon: null,
    subtasks: JSON.stringify([{ title: 'Step', priority: 'medium', estimatedMinutes: 15 }]),
    workflowTasks: null,
    ...overrides,
  } satisfies SubtaskTemplateSeed;
}

export function describeTaskOrganizationRepositoryContract(
  name: string,
  createHarness: () => TaskOrganizationContractHarness | Promise<TaskOrganizationContractHarness>,
): void {
  describe(`TaskOrganizationRepository contract (${name})`, () => {
    let harness: TaskOrganizationContractHarness;
    let organization: TaskOrganizationRepository;

    beforeEach(async () => {
      harness = await createHarness();
      organization = harness.repository;
      await harness.reset();
    });

    /* ── Tag overview ────────────────────────────────────────────────── */

    describe('readTagOverview', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          {
            id: 'task-gh',
            connectorType: 'github-issues',
            connectorInstanceId: 'gh-1',
            sourceId: 'acme/repo:1',
            sourceListId: 'acme/repo',
            sourceListName: 'acme/repo',
          },
          {
            id: 'task-todo',
            connectorType: 'microsoft-todo',
            connectorInstanceId: 'todo-1',
            sourceId: 'list-a:2',
            sourceListId: 'list-a',
            sourceListName: 'Inbox',
          },
        ]);
        await harness.insertTags([
          { id: 'tag-bug', name: 'bug', slug: 'bug', type: 'source', source: 'github-issues' },
          { id: 'tag-hub', name: 'Focus', slug: 'focus', type: 'hub', color: '#123456' },
          { id: 'tag-unused', name: 'Unused', slug: 'unused', type: 'hub' },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-gh', tagId: 'tag-bug' },
          { taskId: 'task-gh', tagId: 'tag-hub' },
          { taskId: 'task-todo', tagId: 'tag-hub' },
        ]);
      });

      it('returns usage counts, sorted sources and source-list names', async () => {
        const overview = await organization.readTagOverview({
          type: null,
          source: null,
          listId: null,
          includeUsageBreakdown: false,
        });

        const hub = overview.tags.find((tag) => tag.id === 'tag-hub');
        expect(hub).toBeDefined();
        expect(hub?.usageCount).toBe(2);
        expect(hub?.sources).toEqual(['github-issues', 'microsoft-todo']);
        expect(hub?.sourceNames).toEqual(['Inbox', 'acme/repo']);
        expect(hub?.confirmed).toBe(true);
        expect(hub?.unifiedInto).toBeNull();
        // Usage breakdowns stay empty unless explicitly requested.
        expect(hub?.listUsage).toEqual([]);
        expect(hub?.sourceUsage).toEqual([]);
      });

      it('falls back to the tag own source when no task links it', async () => {
        const overview = await organization.readTagOverview({
          type: null,
          source: null,
          listId: null,
          includeUsageBreakdown: false,
        });
        const unused = overview.tags.find((tag) => tag.id === 'tag-unused');
        expect(unused?.usageCount).toBe(0);
        expect(unused?.sources).toEqual([]);
        expect(unused?.sourceNames).toEqual([]);
      });

      it('filters by type', async () => {
        const overview = await organization.readTagOverview({
          type: 'hub',
          source: null,
          listId: null,
          includeUsageBreakdown: false,
        });
        expect(overview.tags.map((tag) => tag.id).sort())
          .toEqual(['tag-hub', 'tag-unused']);
      });

      it('filters by connector source across the tag own source and task links', async () => {
        const overview = await organization.readTagOverview({
          type: null,
          source: 'github-issues',
          listId: null,
          includeUsageBreakdown: false,
        });
        expect(overview.tags.map((tag) => tag.id).sort())
          .toEqual(['tag-bug', 'tag-hub']);
      });

      it('filters by source list', async () => {
        const overview = await organization.readTagOverview({
          type: null,
          source: null,
          listId: 'list-a',
          includeUsageBreakdown: false,
        });
        expect(overview.tags.map((tag) => tag.id)).toEqual(['tag-hub']);
      });

      it('computes usage breakdowns only when asked', async () => {
        const overview = await organization.readTagOverview({
          type: null,
          source: null,
          listId: null,
          includeUsageBreakdown: true,
        });
        const hub = overview.tags.find((tag) => tag.id === 'tag-hub');
        expect(hub?.sourceUsage).toEqual(expect.arrayContaining([
          { tagId: 'tag-hub', connectorType: 'github-issues', usageCount: 1 },
          { tagId: 'tag-hub', connectorType: 'microsoft-todo', usageCount: 1 },
        ]));
        expect(hub?.listUsage).toEqual(expect.arrayContaining([
          {
            tagId: 'tag-hub',
            connectorInstanceId: 'gh-1',
            sourceListId: 'acme/repo',
            usageCount: 1,
          },
        ]));
      });

      it('always returns every source tag slug regardless of the filters', async () => {
        const overview = await organization.readTagOverview({
          type: 'hub',
          source: 'microsoft-todo',
          listId: 'list-a',
          includeUsageBreakdown: false,
        });
        expect(overview.sourceTagSlugs).toEqual(['bug']);
      });
    });

    /* ── Tag writes ──────────────────────────────────────────────────── */

    describe('createHubTag', () => {
      it('creates a hub tag', async () => {
        const outcome = await organization.createHubTag({
          id: 'tag-urgent',
          name: 'Urgent',
          slug: 'urgent',
          color: '#ff8800',
          createdAt: NOW,
        });
        expect(outcome).toEqual({
          kind: 'created',
          tag: {
            id: 'tag-urgent',
            name: 'Urgent',
            slug: 'urgent',
            type: 'hub',
            color: '#ff8800',
          },
        });
        expect(await harness.listTagIds()).toEqual(['tag-urgent']);
      });

      it('resolves an existing slug instead of racing to a duplicate', async () => {
        await harness.insertTags([
          { id: 'tag-existing', name: 'Urgent', slug: 'urgent', type: 'hub', color: '#111111' },
        ]);
        const outcome = await organization.createHubTag({
          id: 'tag-urgent',
          name: 'Urgent',
          slug: 'urgent',
          color: '#ff8800',
          createdAt: NOW,
        });
        expect(outcome.kind).toBe('existing');
        expect(outcome.tag.id).toBe('tag-existing');
        expect(await harness.listTagIds()).toEqual(['tag-existing']);
      });

      it('converges concurrent creates of the same slug onto one tag', async () => {
        const results = await Promise.all([
          organization.createHubTag({
            id: 'tag-a',
            name: 'Race',
            slug: 'race',
            color: '#aaaaaa',
            createdAt: NOW,
          }),
          organization.createHubTag({
            id: 'tag-b',
            name: 'Race',
            slug: 'race',
            color: '#bbbbbb',
            createdAt: NOW,
          }),
        ]);
        expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
        expect(await harness.listTagIds()).toHaveLength(1);
      });
    });

    describe('updateTag', () => {
      beforeEach(async () => {
        await harness.insertTasks([{ id: 'task-1' }, { id: 'task-2' }]);
        await harness.insertTags([
          { id: 'tag-1', name: 'Old', slug: 'old', type: 'ai-inferred', confirmed: false },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-1', tagId: 'tag-1' },
          { taskId: 'task-2', tagId: 'tag-1' },
        ]);
      });

      it('applies only the supplied fields and reports affected tasks', async () => {
        const result = await organization.updateTag({
          tagId: 'tag-1',
          name: 'New',
          slug: 'new',
          confirmed: true,
        });
        expect(result.affectedTaskIds.sort()).toEqual(['task-1', 'task-2']);

        const overview = await organization.readTagOverview({
          type: null,
          source: null,
          listId: null,
          includeUsageBreakdown: false,
        });
        const updated = overview.tags.find((tag) => tag.id === 'tag-1');
        expect(updated?.name).toBe('New');
        expect(updated?.slug).toBe('new');
        expect(updated?.confirmed).toBe(true);
        // `color` was not supplied, so it must be untouched.
        expect(updated?.color).toBeNull();
      });

      it('reports no affected tasks for an unknown tag', async () => {
        const result = await organization.updateTag({ tagId: 'missing', color: '#000000' });
        expect(result.affectedTaskIds).toEqual([]);
      });
    });

    describe('deleteHubTag', () => {
      beforeEach(async () => {
        await harness.insertTasks([{ id: 'task-1' }]);
        await harness.insertTags([
          { id: 'tag-hub', name: 'Hub', slug: 'hub', type: 'hub' },
          { id: 'tag-src', name: 'Src', slug: 'src', type: 'source', source: 'github-issues' },
        ]);
        await harness.insertTaskTags([{ taskId: 'task-1', tagId: 'tag-hub' }]);
      });

      it('deletes the tag together with its task links', async () => {
        const outcome = await organization.deleteHubTag('tag-hub');
        expect(outcome).toEqual({ kind: 'deleted', affectedTaskIds: ['task-1'] });
        expect(await harness.listTagIds()).toEqual(['tag-src']);
        expect(await harness.listTaskTagIds('task-1')).toEqual([]);
      });

      it('reports a missing tag', async () => {
        expect(await organization.deleteHubTag('nope')).toEqual({ kind: 'missing' });
      });

      it('refuses to delete a source-managed tag', async () => {
        expect(await organization.deleteHubTag('tag-src')).toEqual({ kind: 'source-managed' });
        expect(await harness.listTagIds()).toContain('tag-src');
      });
    });

    /* ── Tag consolidation ───────────────────────────────────────────── */

    describe('tag consolidation', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          { id: 'task-1' },
          { id: 'task-2' },
          {
            id: 'task-src',
            connectorType: 'github-issues',
            connectorInstanceId: 'gh-1',
            sourceId: 'acme/repo:9',
          },
        ]);
        await harness.insertTags([
          { id: 'tag-target', name: 'Target', slug: 'target', type: 'hub' },
          { id: 'tag-a', name: 'A', slug: 'a', type: 'hub' },
          { id: 'tag-b', name: 'B', slug: 'b', type: 'hub' },
          { id: 'tag-alias', name: 'Alias', slug: 'alias', type: 'hub', unifiedInto: 'tag-a' },
          {
            id: 'tag-source',
            name: 'Source',
            slug: 'source',
            type: 'source',
            source: 'github-issues',
          },
          {
            id: 'tag-source-empty',
            name: 'Source Empty',
            slug: 'source-empty',
            type: 'source',
            source: 'github-issues',
          },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-1', tagId: 'tag-a' },
          { taskId: 'task-1', tagId: 'tag-target' },
          { taskId: 'task-2', tagId: 'tag-b' },
          { taskId: 'task-src', tagId: 'tag-source' },
        ]);
      });

      it('reads only the tags that still exist, ordered by id', async () => {
        const candidates = await organization.getTagConsolidationCandidates({
          targetTagId: 'tag-target',
          sourceTagIds: ['tag-b', 'tag-a', 'ghost'],
        });
        expect(candidates.target).toEqual({
          id: 'tag-target',
          name: 'Target',
          type: 'hub',
        });
        expect(candidates.sources.map((tag) => tag.id)).toEqual(['tag-a', 'tag-b']);
      });

      it('reports a missing target', async () => {
        const candidates = await organization.getTagConsolidationCandidates({
          targetTagId: 'ghost',
          sourceTagIds: ['tag-a'],
        });
        expect(candidates.target).toBeNull();
      });

      describe('mergeTags', () => {
        it('reassigns links without duplicating, repoints aliases and removes sources', async () => {
          const outcome = await organization.mergeTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a', 'tag-b'],
            newName: 'Merged',
            newSlug: 'merged',
            newColor: '#00ff00',
          });

          expect(outcome).toEqual({ kind: 'merged', reassigned: 1 });
          expect(await harness.listTagIds()).toEqual(
            ['tag-alias', 'tag-source', 'tag-source-empty', 'tag-target'],
          );
          // `task-1` already carried the target, so the duplicate link is dropped.
          expect(await harness.listTaskTagIds('task-1')).toEqual(['tag-target']);
          expect(await harness.listTaskTagIds('task-2')).toEqual(['tag-target']);
          // The alias chain follows the merge instead of dangling.
          expect(await harness.getTagUnifiedInto('tag-alias')).toBe('tag-target');
        });

        it('renames the target when new fields are supplied', async () => {
          await organization.mergeTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a'],
            newName: 'Merged',
            newSlug: 'merged',
            newColor: '#00ff00',
          });
          const overview = await organization.readTagOverview({
            type: null,
            source: null,
            listId: null,
            includeUsageBreakdown: false,
          });
          const target = overview.tags.find((tag) => tag.id === 'tag-target');
          expect(target?.name).toBe('Merged');
          expect(target?.slug).toBe('merged');
          expect(target?.color).toBe('#00ff00');
        });

        it('reports stale input rather than partially merging', async () => {
          const outcome = await organization.mergeTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a', 'ghost'],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          expect(outcome).toEqual({ kind: 'stale' });
          expect(await harness.listTagIds()).toContain('tag-a');
          expect(await harness.listTaskTagIds('task-1').then((ids) => ids.sort()))
            .toEqual(['tag-a', 'tag-target']);
        });

        it('refuses to destroy a source-backed tag', async () => {
          const outcome = await organization.mergeTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-source'],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          expect(outcome).toEqual({ kind: 'source-backed' });
          expect(await harness.listTagIds()).toContain('tag-source');
        });

        it('rolls back as a unit when a write inside the transaction fails', async () => {
          const before = await harness.listTagIds();
          await harness.forceMergeFailure({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a', 'tag-b'],
          });
          // Nothing may be durable: no tag removed, no link reassigned.
          expect(await harness.listTagIds()).toEqual(before);
          expect(await harness.listTaskTagIds('task-2')).toEqual(['tag-b']);
        });

        it('serializes concurrent consolidation on the same target', async () => {
          const [first, second] = await Promise.all([
            organization.mergeTags({
              targetTagId: 'tag-target',
              sourceTagIds: ['tag-a'],
              newName: null,
              newSlug: null,
              newColor: null,
            }),
            organization.mergeTags({
              targetTagId: 'tag-target',
              sourceTagIds: ['tag-a'],
              newName: null,
              newSlug: null,
              newColor: null,
            }),
          ]);
          // The loser re-validates inside the transaction and reports stale
          // instead of double-applying or corrupting the target.
          expect([first.kind, second.kind].sort()).toEqual(['merged', 'stale']);
          expect(await harness.listTagIds()).not.toContain('tag-a');
        });

        it('serializes concurrent consolidation of the same source into different targets', async () => {
          const [first, second] = await Promise.all([
            organization.mergeTags({
              targetTagId: 'tag-target',
              sourceTagIds: ['tag-a'],
              newName: null,
              newSlug: null,
              newColor: null,
            }),
            organization.mergeTags({
              targetTagId: 'tag-b',
              sourceTagIds: ['tag-a'],
              newName: null,
              newSlug: null,
              newColor: null,
            }),
          ]);
          expect([first.kind, second.kind].sort()).toEqual(['merged', 'stale']);
          expect(await harness.listTagIds()).not.toContain('tag-a');
        });

        it('serializes target deletion against consolidation', async () => {
          const [merge, deletion] = await Promise.all([
            organization.mergeTags({
              targetTagId: 'tag-target',
              sourceTagIds: ['tag-a'],
              newName: null,
              newSlug: null,
              newColor: null,
            }),
            organization.deleteHubTag('tag-target'),
          ]);
          expect(deletion.kind).toBe('deleted');
          const remainingTags = await harness.listTagIds();
          expect(remainingTags).not.toContain('tag-target');
          if (merge.kind === 'merged') {
            expect(remainingTags).not.toContain('tag-a');
          } else {
            expect(merge.kind).toBe('stale');
            expect(remainingTags).toContain('tag-a');
          }
          expect(await harness.listTaskTagIds('task-1')).not.toContain('tag-target');
          expect(await harness.listTaskTagIds('task-2')).not.toContain('tag-target');
        });
      });

      describe('unifyTags', () => {
        it('links local sources to the target and reports the counts', async () => {
          const outcome = await organization.unifyTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a', 'tag-b'],
            newName: null,
            newSlug: null,
            newColor: null,
          });

          expect(outcome.kind).toBe('unified');
          if (outcome.kind !== 'unified') throw new Error('unreachable');
          // `task-1` already carried the target, so only `task-2` is newly linked.
          expect(outcome.linked).toBe(1);
          expect(outcome.localTagIds.sort()).toEqual(['tag-a', 'tag-b']);
          expect(outcome.targetIsSourceBacked).toBe(false);
          expect(outcome.detached).toBe(0);
          // A local winner absorbs the local losers outright.
          expect(await harness.listTagIds()).toEqual(
            ['tag-alias', 'tag-source', 'tag-source-empty', 'tag-target'],
          );
          expect(await harness.listTaskTagIds('task-1')).toEqual(['tag-target']);
          expect(await harness.listTaskTagIds('task-2')).toEqual(['tag-target']);
          // The alias chain follows the unification instead of dangling.
          expect(await harness.getTagUnifiedInto('tag-alias')).toBe('tag-target');
        });

        it('reports stale input rather than partially unifying', async () => {
          const outcome = await organization.unifyTags({
            targetTagId: 'tag-target',
            sourceTagIds: ['tag-a', 'ghost'],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          expect(outcome).toEqual({ kind: 'stale' });
          expect(await harness.getTagUnifiedInto('tag-a')).toBeNull();
        });

        it('refuses a source-backed target with no task scope to detach from', async () => {
          const outcome = await organization.unifyTags({
            targetTagId: 'tag-source-empty',
            sourceTagIds: ['tag-a'],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          expect(outcome.kind).toBe('missing-source-scope');
          expect(await harness.getTagUnifiedInto('tag-a')).toBeNull();
        });

        it('detaches local links when unifying into a source-backed target', async () => {
          await harness.insertTaskTags([{ taskId: 'task-src', tagId: 'tag-a' }]);
          const outcome = await organization.unifyTags({
            targetTagId: 'tag-source',
            sourceTagIds: ['tag-a'],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          expect(outcome.kind).toBe('unified');
          if (outcome.kind !== 'unified') throw new Error('unreachable');
          expect(outcome.targetIsSourceBacked).toBe(true);
          expect(outcome.detached).toBeGreaterThan(0);
          expect(outcome.detachedTaskIds).toContain('task-src');
        });
      });

      it('lists the task ids linked to a tag', async () => {
        expect(await organization.listTaskIdsForTag('tag-a')).toEqual(['task-1']);
        expect(await organization.listTaskIdsForTag('ghost')).toEqual([]);
      });

      it('reads the push subject for a tag', async () => {
        expect(await organization.getTagPushSubject('tag-target')).toEqual({
          id: 'tag-target',
          name: 'Target',
          slug: 'target',
          type: 'hub',
          color: null,
        });
        expect(await organization.getTagPushSubject('ghost')).toBeNull();
      });

      it('reads the source-removal context for a tag', async () => {
        const context = await organization.getTagSourceRemovalContext('tag-source');
        expect(context.tag).toEqual({ id: 'tag-source', name: 'Source' });
        expect(context.tasks).toEqual([{
          id: 'task-src',
          sourceId: 'acme/repo:9',
          connectorInstanceId: 'gh-1',
        }]);
      });

      it('returns a null tag with no tasks for an unknown removal subject', async () => {
        const context = await organization.getTagSourceRemovalContext('ghost');
        expect(context.tag).toBeNull();
        expect(context.tasks).toEqual([]);
      });
    });

    /* ── Subtask templates ───────────────────────────────────────────── */

    describe('subtask templates', () => {
      it('seeds only the missing built-ins', async () => {
        await organization.ensureBuiltInSubtaskTemplates([seed({ id: 'builtin-a' })], NOW);
        await organization.ensureBuiltInSubtaskTemplates(
          [seed({ id: 'builtin-a', name: 'Renamed' }), seed({ id: 'builtin-b' })],
          NOW,
        );

        const templates = await organization.listSubtaskTemplates({
          category: null,
          type: null,
        });
        expect(templates.map((template) => template.id).sort())
          .toEqual(['builtin-a', 'builtin-b']);
        // The already-present seed keeps its stored name.
        expect(templates.find((template) => template.id === 'builtin-a')?.name)
          .toBe('builtin-a');
        expect(templates.every((template) => template.isBuiltIn)).toBe(true);
      });

      it('is idempotent under concurrent seeding', async () => {
        const seeds = [seed({ id: 'builtin-a' }), seed({ id: 'builtin-b' })];
        await Promise.all([
          organization.ensureBuiltInSubtaskTemplates(seeds, NOW),
          organization.ensureBuiltInSubtaskTemplates(seeds, NOW),
          organization.ensureBuiltInSubtaskTemplates(seeds, NOW),
        ]);
        const templates = await organization.listSubtaskTemplates({
          category: null,
          type: null,
        });
        expect(templates.map((template) => template.id).sort())
          .toEqual(['builtin-a', 'builtin-b']);
      });

      it('ANDs the category and type filters', async () => {
        await organization.createSubtaskTemplate({
          id: 'tpl-1',
          template: {
            name: 'Work single',
            description: '',
            category: 'work',
            type: 'single',
            icon: null,
            subtasks: JSON.stringify([]),
            workflowTasks: null,
          },
          now: NOW,
        });
        await organization.createSubtaskTemplate({
          id: 'tpl-2',
          template: {
            name: 'Work workflow',
            description: '',
            category: 'work',
            type: 'workflow',
            icon: null,
            subtasks: JSON.stringify([]),
            workflowTasks: JSON.stringify([]),
          },
          now: NOW,
        });
        await organization.createSubtaskTemplate({
          id: 'tpl-3',
          template: {
            name: 'Home single',
            description: '',
            category: 'home',
            type: 'single',
            icon: null,
            subtasks: JSON.stringify([]),
            workflowTasks: null,
          },
          now: NOW,
        });

        const filtered = await organization.listSubtaskTemplates({
          category: 'work',
          type: 'single',
        });
        expect(filtered.map((template) => template.id)).toEqual(['tpl-1']);
      });

      it('creates, reads, updates and deletes a template', async () => {
        const created = await organization.createSubtaskTemplate({
          id: 'tpl-1',
          template: {
            name: 'Original',
            description: 'desc',
            category: 'work',
            type: 'single',
            icon: 'star',
            subtasks: JSON.stringify([
              { title: 'One', priority: 'high', estimatedMinutes: 5 },
            ]),
            workflowTasks: null,
          },
          now: NOW,
        });
        expect(created.id).toBe('tpl-1');
        expect(created.isBuiltIn).toBe(false);
        expect(created.createdAt).toBe(NOW);

        expect((await organization.getSubtaskTemplate('tpl-1'))?.name).toBe('Original');
        expect(await organization.getSubtaskTemplate('ghost')).toBeNull();

        const updated = await organization.updateSubtaskTemplate({
          id: 'tpl-1',
          patch: { name: 'Renamed', icon: null },
          now: '2026-09-02T09:00:00.000Z',
        });
        expect(updated?.name).toBe('Renamed');
        expect(updated?.icon).toBeNull();
        // Fields outside the patch are untouched.
        expect(updated?.description).toBe('desc');
        expect(updated?.updatedAt).toBe('2026-09-02T09:00:00.000Z');

        expect(await organization.updateSubtaskTemplate({
          id: 'ghost',
          patch: { name: 'x' },
          now: NOW,
        })).toBeNull();

        expect(await organization.deleteSubtaskTemplate('tpl-1')).toEqual({ kind: 'deleted' });
        expect(await organization.deleteSubtaskTemplate('tpl-1')).toEqual({ kind: 'missing' });
      });

      it('refuses to delete a built-in template', async () => {
        await organization.ensureBuiltInSubtaskTemplates([seed({ id: 'builtin-a' })], NOW);
        expect(await organization.deleteSubtaskTemplate('builtin-a'))
          .toEqual({ kind: 'built-in' });
      });

      it('decodes the stored payload into an application plan', async () => {
        await organization.createSubtaskTemplate({
          id: 'tpl-workflow',
          template: {
            name: 'Workflow',
            description: '',
            category: null,
            type: 'workflow',
            icon: null,
            subtasks: JSON.stringify([]),
            workflowTasks: JSON.stringify([
              {
                title: 'Phase one',
                description: 'first',
                priority: 'high',
                subtasks: ['Step A', 'Step B'],
              },
            ]),
          },
          now: NOW,
        });

        const plan = await organization.getSubtaskTemplateApplicationPlan('tpl-workflow');
        expect(plan).toEqual({
          id: 'tpl-workflow',
          type: 'workflow',
          subtasks: [],
          workflowTasks: [{
            title: 'Phase one',
            description: 'first',
            priority: 'high',
            subtasks: ['Step A', 'Step B'],
          }],
        });
        expect(await organization.getSubtaskTemplateApplicationPlan('ghost')).toBeNull();
      });
    });

    describe('template application', () => {
      it('stamps out a workflow with its checklist children in one step', async () => {
        await organization.applyWorkflowTemplate({
          templateId: 'tpl-workflow',
          parentTaskId: null,
          connectorType: 'local',
          connectorInstanceId: 'local',
          isLocalOnly: true,
          sourceListId: null,
          sourceListName: null,
          now: NOW,
          tasks: [{
            id: 'wf-1',
            title: 'Phase one',
            description: 'first',
            priority: 'high',
            subtasks: [
              { id: 'wf-1-a', title: 'Step A' },
              { id: 'wf-1-b', title: 'Step B' },
            ],
          }],
        });

        expect(await harness.listTaskIds()).toEqual(['wf-1', 'wf-1-a', 'wf-1-b']);
      });

      it('creates subtasks under an existing parent', async () => {
        await harness.insertTasks([{
          id: 'parent-1',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          sourceId: 'list-a:parent',
          sourceListId: 'list-a',
          depth: 0,
        }]);

        const outcome = await organization.applySingleTemplate({
          templateId: 'tpl-single',
          parentTaskId: 'parent-1',
          now: NOW,
          subtasks: [
            { id: 'sub-1', title: 'One', priority: 'high', estimatedMinutes: 5 },
            { id: 'sub-2', title: 'Two', priority: 'medium', estimatedMinutes: null },
          ],
        });
        expect(outcome).toEqual({ kind: 'applied' });
        expect(await harness.listTaskIds()).toEqual(['parent-1', 'sub-1', 'sub-2']);
      });

      it('reports a missing parent without writing anything', async () => {
        const outcome = await organization.applySingleTemplate({
          templateId: 'tpl-single',
          parentTaskId: 'ghost',
          now: NOW,
          subtasks: [{ id: 'sub-1', title: 'One', priority: 'high', estimatedMinutes: 5 }],
        });
        expect(outcome).toEqual({ kind: 'missing-parent' });
        expect(await harness.listTaskIds()).toEqual([]);
      });

      it('keeps non-recursive deletion coherent with concurrent template application', async () => {
        await harness.insertTasks([{ id: 'parent-1' }]);
        const [outcome] = await Promise.all([
          organization.applySingleTemplate({
            templateId: 'tpl-single',
            parentTaskId: 'parent-1',
            now: NOW,
            subtasks: [{
              id: 'sub-1',
              title: 'One',
              priority: 'high',
              estimatedMinutes: null,
            }],
          }),
          harness.deleteTask('parent-1', false),
        ]);

        expect(await harness.listTaskIds()).not.toContain('parent-1');
        if (outcome.kind === 'applied') {
          expect(await harness.getTaskParentId('sub-1')).toBeNull();
        } else {
          expect(outcome.kind).toBe('missing-parent');
          expect(await harness.getTaskParentId('sub-1')).toBeUndefined();
        }
      });

      it('keeps recursive deletion coherent with concurrent template application', async () => {
        await harness.insertTasks([{ id: 'parent-1' }]);
        const [outcome] = await Promise.all([
          organization.applySingleTemplate({
            templateId: 'tpl-single',
            parentTaskId: 'parent-1',
            now: NOW,
            subtasks: [{
              id: 'sub-1',
              title: 'One',
              priority: 'high',
              estimatedMinutes: null,
            }],
          }),
          harness.deleteTask('parent-1', true),
        ]);

        expect(await harness.listTaskIds()).not.toContain('parent-1');
        if (outcome.kind === 'applied') {
          expect(await harness.getTaskParentId('sub-1')).toBeUndefined();
        } else {
          expect(outcome.kind).toBe('missing-parent');
          expect(await harness.getTaskParentId('sub-1')).toBeUndefined();
        }
      });

      it('never leaves a partially applied workflow durable', async () => {
        // A duplicate child id aborts the insert; nothing from the run may survive.
        await expect(organization.applyWorkflowTemplate({
          templateId: 'tpl-workflow',
          parentTaskId: null,
          connectorType: 'local',
          connectorInstanceId: 'local',
          isLocalOnly: true,
          sourceListId: null,
          sourceListName: null,
          now: NOW,
          tasks: [
            {
              id: 'wf-1',
              title: 'Phase one',
              description: null,
              priority: 'medium',
              subtasks: [{ id: 'dup', title: 'Step A' }],
            },
            {
              id: 'wf-2',
              title: 'Phase two',
              description: null,
              priority: 'medium',
              subtasks: [{ id: 'dup', title: 'Step B' }],
            },
          ],
        })).rejects.toThrow();

        expect(await harness.listTaskIds()).toEqual([]);
      });
    });

    /* ── Within-source list moves ────────────────────────────────────── */

    describe('within-source list moves', () => {
      beforeEach(async () => {
        await harness.insertTasks([{
          id: 'task-1',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          sourceId: 'list-a:task-1',
          sourceListId: 'list-a',
        }]);
      });

      it('reads the move context', async () => {
        expect(await organization.getTaskMoveToListContext('task-1')).toEqual({
          id: 'task-1',
          sourceId: 'list-a:task-1',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          sourceListId: 'list-a',
        });
        expect(await organization.getTaskMoveToListContext('ghost')).toBeNull();
      });

      it('finalizes a move that changed the source id', async () => {
        await organization.finalizeTaskMoveToList({
          taskId: 'task-1',
          sourceListId: 'list-b',
          sourceId: 'list-b:task-1',
          updatedAt: '2026-09-03T09:00:00.000Z',
        });
        expect(await harness.getTaskSource('task-1')).toEqual({
          sourceListId: 'list-b',
          sourceId: 'list-b:task-1',
        });
      });

      it('keeps the existing source id when the move did not change it', async () => {
        await organization.finalizeTaskMoveToList({
          taskId: 'task-1',
          sourceListId: 'list-b',
          sourceId: null,
          updatedAt: '2026-09-03T09:00:00.000Z',
        });
        expect(await harness.getTaskSource('task-1')).toEqual({
          sourceListId: 'list-b',
          sourceId: 'list-a:task-1',
        });
      });
    });

    /* ── Move preview ────────────────────────────────────────────────── */

    describe('getTaskMovePreviewSnapshot', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          {
            id: 'task-1',
            title: 'Fix login',
            description: 'Broken auth',
            connectorType: 'microsoft-todo',
            connectorInstanceId: 'todo-1',
            sourceId: 'list-a:task-1',
            sourceListId: 'list-a',
            priority: 'high',
            effort: 3,
            dueDate: '2026-10-01',
            assignee: 'user@example.com',
          },
          { id: 'child-1', parentId: 'task-1', depth: 1 },
          { id: 'child-2', parentId: 'task-1', depth: 1 },
          { id: 'other' },
        ]);
        await harness.insertTags([
          { id: 'tag-bug', name: 'bug', slug: 'bug', type: 'source' },
          { id: 'tag-hub', name: 'Focus', slug: 'focus', type: 'hub' },
        ]);
        await harness.insertTaskTags([
          { taskId: 'task-1', tagId: 'tag-bug' },
          { taskId: 'task-1', tagId: 'tag-hub' },
        ]);
        await harness.insertSchedules([{
          taskId: 'task-1',
          scheduledDate: '2026-10-02',
          scheduledTime: '09:00',
          estimatedDuration: 60,
          isTimeBlocked: true,
          recurrence: 'FREQ=DAILY',
        }]);
        await harness.insertAttachments([
          { id: 'att-1', taskId: 'task-1', name: 'a.txt', size: 10, sourceAttachmentId: 'remote-1' },
          { id: 'att-2', taskId: 'task-1', name: 'b.txt', size: 20, sourceAttachmentId: null },
          { id: 'att-3', taskId: 'other', name: 'c.txt', size: 30 },
        ]);
        await harness.insertProjects([{ id: 'proj-1', name: 'Alpha' }]);
        await harness.insertTaskProjects([{ taskId: 'task-1', projectId: 'proj-1' }]);
      });

      it('assembles the full preview snapshot', async () => {
        const snapshot = await organization.getTaskMovePreviewSnapshot('task-1');
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('unreachable');

        expect(snapshot.task.id).toBe('task-1');
        expect(snapshot.task.title).toBe('Fix login');
        expect(snapshot.task.effort).toBe(3);
        expect(snapshot.task.metadata).toEqual({});
        expect(snapshot.tags).toEqual(expect.arrayContaining([
          { name: 'bug', slug: 'bug' },
          { name: 'Focus', slug: 'focus' },
        ]));
        expect(snapshot.tags).toHaveLength(2);
        expect(snapshot.subtaskCount).toBe(2);
        expect(snapshot.schedule).toEqual({
          estimatedDuration: 60,
          recurrence: 'FREQ=DAILY',
          scheduledDate: '2026-10-02',
          scheduledTime: '09:00',
          isTimeBlocked: true,
        });
        expect(snapshot.storedAttachmentCount).toBe(2);
        expect(snapshot.storedAttachmentSourceIds).toEqual(['remote-1']);
        expect(snapshot.projectCount).toBe(1);
      });

      it('returns null for an unknown task', async () => {
        expect(await organization.getTaskMovePreviewSnapshot('ghost')).toBeNull();
      });

      it('reports a null schedule and zero counts for a bare task', async () => {
        const snapshot = await organization.getTaskMovePreviewSnapshot('other');
        expect(snapshot?.schedule).toBeNull();
        expect(snapshot?.subtaskCount).toBe(0);
        expect(snapshot?.tags).toEqual([]);
        expect(snapshot?.projectCount).toBe(0);
        expect(snapshot?.storedAttachmentCount).toBe(1);
        expect(snapshot?.storedAttachmentSourceIds).toEqual([]);
      });
    });

    /* ── Smart score ─────────────────────────────────────────────────── */

    describe('readSmartScoreInputs', () => {
      beforeEach(async () => {
        await harness.insertTasks([
          {
            id: 'task-open',
            status: 'todo',
            connectorType: 'github-issues',
            connectorInstanceId: 'gh-1',
            sourceId: 'acme/repo:1',
            sourceListId: 'acme/repo',
          },
          { id: 'task-active', status: 'in_progress' },
          { id: 'task-done', status: 'done' },
        ]);
        await harness.insertTags([
          { id: 'tag-alias', name: 'Alias', slug: 'alias', type: 'hub', unifiedInto: 'tag-real' },
          { id: 'tag-real', name: 'Real', slug: 'real', type: 'hub' },
        ]);
        await harness.insertTaskTags([{ taskId: 'task-open', tagId: 'tag-alias' }]);
        await harness.insertProjects([{ id: 'proj-1', name: 'Alpha' }]);
        await harness.insertTaskProjects([{ taskId: 'task-open', projectId: 'proj-1' }]);
        await harness.insertSchedules([
          { taskId: 'task-open', estimatedDuration: 45 },
        ]);
        await harness.insertSourceRankings([{
          id: 'gh-1',
          connectorType: 'github-issues',
          name: 'GitHub',
          rank: 2,
        }]);
      });

      it('returns only the requested statuses with their scoring inputs', async () => {
        const snapshot = await organization.readSmartScoreInputs({
          statuses: ['todo', 'in_progress'],
        });

        expect(snapshot.tasks.map((task) => task.id).sort())
          .toEqual(['task-active', 'task-open']);
        // Tag links collapse onto their unification target.
        expect(snapshot.taskTags).toEqual([{
          taskId: 'task-open',
          tagId: 'tag-real',
          tagName: 'Alias',
        }]);
        expect(snapshot.taskProjects).toEqual([{
          taskId: 'task-open',
          projectId: 'proj-1',
          projectName: 'Alpha',
        }]);
        expect(snapshot.estimatedDurations).toEqual([{
          taskId: 'task-open',
          estimatedDuration: 45,
        }]);
        expect(snapshot.sourceRankings).toEqual([{
          id: 'gh-1',
          connectorType: 'github-issues',
          name: 'GitHub',
          rank: 2,
          updatedAt: expect.any(String),
        }]);
      });

      it('returns empty inputs when no task matches the statuses', async () => {
        const snapshot = await organization.readSmartScoreInputs({ statuses: ['cancelled'] });
        expect(snapshot.tasks).toEqual([]);
        expect(snapshot.taskTags).toEqual([]);
        expect(snapshot.taskProjects).toEqual([]);
        expect(snapshot.estimatedDurations).toEqual([]);
        // Source rankings are global, not scoped to the matched tasks.
        expect(snapshot.sourceRankings).toHaveLength(1);
      });
    });
  });
}
