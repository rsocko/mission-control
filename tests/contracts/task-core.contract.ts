import { describe, expect, it, beforeEach } from 'vitest';
import type {
  PendingSyncTaskMoveRequest,
  TaskCorePersistence,
  TaskCoreTaskRow,
  TaskFilterSpec,
} from '@/lib/tasks/core/contracts';

/**
 * Shared, backend-neutral contract suite for the task-core persistence
 * composition (L04/L05 behavior plus L07 collection/detail writes).
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
  snoozedUntil?: string | null;
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
  icon?: string | null;
  iconColor?: string | null;
  hidden?: boolean;
}

export interface SeedConnector {
  id: string;
  type: string;
  name?: string;
  enabled?: boolean;
  credentials?: Record<string, unknown>;
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

export interface SeedLinkedSource {
  id: string;
  taskId: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
  title: string;
  linkedAt?: string;
  matchConfidence?: number | null;
  metadata?: Record<string, unknown>;
}

export interface SeedProjectPhase {
  id: string;
  projectId?: string | null;
  name: string;
  isProposed?: boolean;
  taskIds?: string[];
}

export interface SeedSourceRanking {
  id: string;
  connectorType: string;
  name: string;
  rank: number;
  updatedAt?: string;
}

export interface TaskCoreContractHarness {
  readonly persistence: TaskCorePersistence;
  reset(): Promise<void>;
  insertTasks(rows: SeedTask[]): Promise<void>;
  insertTags(rows: SeedTag[]): Promise<void>;
  insertTaskTags(rows: Array<{ taskId: string; tagId: string }>): Promise<void>;
  insertProjects(rows: Array<{ id: string; name: string }>): Promise<void>;
  insertTaskProjects(rows: Array<{ taskId: string; projectId: string }>): Promise<void>;
  insertTaskDependencies(rows: Array<{
    id: string;
    taskId: string;
    dependsOnTaskId: string;
  }>): Promise<void>;
  insertSourceLists(rows: SeedSourceList[]): Promise<void>;
  insertMyDayItems(rows: Array<{ id: string; taskId: string; date: string }>): Promise<void>;
  insertConnectors(rows: SeedConnector[]): Promise<void>;
  setAppSetting(key: string, value: unknown): Promise<void>;
  insertAttachments(rows: SeedAttachment[]): Promise<void>;
  insertPriorityEntities(rows: SeedPriorityEntity[]): Promise<void>;
  insertMyDayExclusion(row: { id: string; taskId: string; date: string }): Promise<void>;
  insertTaskSchedules(rows: SeedSchedule[]): Promise<void>;
  insertLinkedSources(rows: SeedLinkedSource[]): Promise<void>;
  insertProjectPhases(rows: SeedProjectPhase[]): Promise<void>;
  insertSourceRankings(rows: SeedSourceRanking[]): Promise<void>;
  insertQuickSortLogs(rows: Array<{
    id: string;
    taskId: string;
    operationId?: string | null;
    mode?: string;
    action: string;
    triagedAt: string;
    reversedAt?: string | null;
  }>): Promise<void>;
  listQuickSortLogs(operationId: string): Promise<Array<{
    id: string;
    operationId: string | null;
    mode: string;
    action: string;
    reversedAt: string | null;
  }>>;
  listTaskIds(): Promise<string[]>;
  listTaskTagIds(taskId: string): Promise<string[]>;
  listTaskProjectIds(taskId: string): Promise<string[]>;
  listTaskDependencyIds(taskId: string): Promise<string[]>;
  listProjectPhaseIds(taskId: string): Promise<string[]>;
  listIngestSuppressions(): Promise<Array<{ connectorInstanceId: string; sourceId: string }>>;
  listAttachmentTaskIds(): Promise<string[]>;
  listMyDayTaskIds(): Promise<string[]>;
  getTaskUpdatedAt(taskId: string): Promise<string | null>;
  countOutboxEvents(stableKey: string): Promise<number>;
  insertTriageItem(input: {
    id: string;
    title: string;
    url: string;
    status?: string;
  }): Promise<void>;
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

function writableTask(id: string, title = id): TaskCoreTaskRow {
  const timestamp = '2025-03-01T12:00:00.000Z';
  return {
    id,
    sourceId: `local:${id}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    title,
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'medium',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: null,
    depth: 0,
    isChecklistItem: false,
    sourceListId: null,
    sourceListName: null,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: 'local',
    lastSyncedAt: timestamp,
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: null,
    isBulkImport: false,
  };
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

    describe('ancillary task lifecycle persistence', () => {
      it('orders attachment metadata and preserves binary, text, empty, and null content', async () => {
        await harness.insertTasks([{ id: 'attachment-task' }]);
        await harness.insertAttachments([
          {
            id: 'attachment-null',
            taskId: 'attachment-task',
            name: 'remote.bin',
            contentType: 'application/octet-stream',
            size: 8,
            contentBase64: null,
            sourceAttachmentId: 'remote-1',
            createdAt: '2026-08-10T12:02:00.000Z',
          },
          {
            id: 'attachment-binary',
            taskId: 'attachment-task',
            name: 'image.bin',
            contentType: 'application/octet-stream',
            size: 3,
            contentBase64: 'AP+A',
            createdAt: '2026-08-10T12:01:00.000Z',
          },
          {
            id: 'attachment-empty',
            taskId: 'attachment-task',
            name: 'empty.txt',
            contentType: 'text/plain',
            size: 0,
            contentBase64: '',
            createdAt: '2026-08-10T12:01:00.000Z',
          },
        ]);

        const context = await harness.persistence.ancillary
          .getAttachmentListContext('attachment-task');
        expect(context.attachments.map((attachment) => ({
          id: attachment.id,
          hasLocalContent: attachment.hasLocalContent,
        }))).toEqual([
          { id: 'attachment-binary', hasLocalContent: true },
          { id: 'attachment-empty', hasLocalContent: true },
          { id: 'attachment-null', hasLocalContent: false },
        ]);
        await expect(harness.persistence.taskReads.getAttachmentReadContext(
          'attachment-task',
          'attachment-binary',
        )).resolves.toMatchObject({
          attachment: { contentBase64: 'AP+A', contentType: 'application/octet-stream' },
        });
        await expect(harness.persistence.taskReads.getAttachmentReadContext(
          'attachment-task',
          'attachment-empty',
        )).resolves.toMatchObject({
          attachment: { contentBase64: '', contentType: 'text/plain' },
        });
        await expect(harness.persistence.taskReads.getAttachmentReadContext(
          'attachment-task',
          'attachment-null',
        )).resolves.toMatchObject({
          attachment: { contentBase64: null, sourceAttachmentId: 'remote-1' },
        });
      });

      it('copies atomically, rolls back invalid targets, and replays the same copy idempotently', async () => {
        await harness.insertTasks([{ id: 'copy-source', title: 'Copy source' }]);
        await harness.insertConnectors([{
          id: 'copy-target',
          type: 'microsoft-todo',
          syncedLists: [],
        }]);
        await harness.insertTags([{ id: 'copy-tag', name: 'Copy', slug: 'copy' }]);
        await harness.insertTaskTags([{ taskId: 'copy-source', tagId: 'copy-tag' }]);
        await harness.insertProjects([{ id: 'copy-project', name: 'Copy Project' }]);
        await harness.insertTaskProjects([{
          taskId: 'copy-source',
          projectId: 'copy-project',
        }]);

        await expect(harness.persistence.ancillary.copyTask({
          sourceTaskId: 'copy-source',
          newTaskId: 'copy-invalid',
          targetConnectorInstanceId: 'missing',
          targetListId: null,
          keepTags: true,
          now: '2026-08-10T12:00:00.000Z',
        })).resolves.toEqual({ kind: 'connector-not-found' });
        await expect(harness.persistence.ancillary.getTask('copy-invalid')).resolves.toBeNull();

        const request = {
          sourceTaskId: 'copy-source',
          newTaskId: 'copy-successor',
          targetConnectorInstanceId: 'copy-target',
          targetListId: null,
          keepTags: true,
          now: '2026-08-10T12:00:00.000Z',
        } as const;
        await expect(harness.persistence.ancillary.copyTask(request)).resolves.toEqual({
          kind: 'committed',
          connectorType: 'microsoft-todo',
        });
        await expect(harness.persistence.ancillary.copyTask(request)).resolves.toEqual({
          kind: 'already-committed',
          connectorType: 'microsoft-todo',
        });
        await expect(harness.persistence.details.getTaskDetail(
          'copy-successor',
          '2026-08-10',
        )).resolves.toMatchObject({
          task: {
            title: 'Copy source',
            connectorInstanceId: 'copy-target',
            syncStatus: 'pending_push',
          },
          tagIds: ['copy-tag'],
          projectIds: ['copy-project'],
        });
      });

      it('rejects stale promotion revisions and promotes only once', async () => {
        await harness.insertTasks([
          { id: 'promote-parent' },
          {
            id: 'promote-child',
            parentId: 'promote-parent',
            depth: 1,
            isChecklistItem: true,
            updatedAt: '2026-08-10T12:00:00.000Z',
          },
        ]);
        const repository = harness.persistence.ancillary;
        await expect(repository.promoteSubtask({
          taskId: 'promote-child',
          expectedUpdatedAt: 'stale',
          now: '2026-08-10T12:01:00.000Z',
        })).resolves.toEqual({
          kind: 'revision-conflict',
          currentUpdatedAt: '2026-08-10T12:00:00.000Z',
        });
        const outcomes = await Promise.all([
          repository.promoteSubtask({
            taskId: 'promote-child',
            expectedUpdatedAt: '2026-08-10T12:00:00.000Z',
            now: '2026-08-10T12:01:00.000Z',
          }),
          repository.promoteSubtask({
            taskId: 'promote-child',
            expectedUpdatedAt: '2026-08-10T12:00:00.000Z',
            now: '2026-08-10T12:02:00.000Z',
          }),
        ]);
        expect(outcomes.filter((outcome) => outcome.kind === 'promoted')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.kind !== 'promoted')).toHaveLength(1);
      });

      it('serializes concurrent proposal acceptance and returns deterministic child order', async () => {
        await harness.insertTasks([{
          id: 'proposal-parent',
          updatedAt: '2026-08-10T12:00:00.000Z',
        }]);
        const expected = await harness.persistence.ancillary
          .getSubtaskProposalSnapshot('proposal-parent');
        expect(expected).not.toBeNull();
        if (!expected) return;
        const first = {
          ...writableTask('proposal-a', 'First proposal'),
          sourceId: 'proposal-a',
          parentId: 'proposal-parent',
          depth: 1,
          isChecklistItem: true,
          createdAt: '2026-08-10T12:02:00.000Z',
          updatedAt: '2026-08-10T12:02:00.000Z',
        };
        const second = {
          ...writableTask('proposal-b', 'Second proposal'),
          sourceId: 'proposal-b',
          parentId: 'proposal-parent',
          depth: 1,
          isChecklistItem: true,
          createdAt: '2026-08-10T12:01:00.000Z',
          updatedAt: '2026-08-10T12:01:00.000Z',
        };
        const outcomes = await Promise.all([
          harness.persistence.ancillary.acceptSubtaskProposal({ task: first, expected }),
          harness.persistence.ancillary.acceptSubtaskProposal({ task: second, expected }),
        ]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['created', 'stale']);
        expect((await harness.persistence.ancillary.listSubtasks('proposal-parent'))
          .map((task) => task.id)).toHaveLength(1);
      });

      it('orders subtasks by creation time and stable id tie-breaker', async () => {
        await harness.insertTasks([{ id: 'ordered-parent' }]);
        const repository = harness.persistence.ancillary;
        for (const task of [
          {
            ...writableTask('ordered-c', 'Third'),
            parentId: 'ordered-parent',
            depth: 1,
            createdAt: '2026-08-10T12:02:00.000Z',
          },
          {
            ...writableTask('ordered-b', 'Second'),
            parentId: 'ordered-parent',
            depth: 1,
            createdAt: '2026-08-10T12:01:00.000Z',
          },
          {
            ...writableTask('ordered-a', 'First'),
            parentId: 'ordered-parent',
            depth: 1,
            createdAt: '2026-08-10T12:01:00.000Z',
          },
        ]) {
          await expect(repository.createSubtask({ task })).resolves.toEqual({
            kind: 'created',
          });
        }
        await expect(repository.listSubtasks('ordered-parent')).resolves.toEqual([
          expect.objectContaining({ id: 'ordered-a' }),
          expect.objectContaining({ id: 'ordered-b' }),
          expect.objectContaining({ id: 'ordered-c' }),
        ]);
      });

      it('normalizes concurrent tag mutations by slug and keeps links idempotent', async () => {
        await harness.insertTasks([{ id: 'tag-task' }]);
        const repository = harness.persistence.ancillary;
        const outcomes = await Promise.all([
          repository.addTaskTags({
            taskId: 'tag-task',
            candidates: [{ id: 'tag-first', name: 'Needs Review', slug: 'needs-review' }],
            tagCreationMode: 'freeform',
            now: '2026-08-10T12:00:00.000Z',
          }),
          repository.addTaskTags({
            taskId: 'tag-task',
            candidates: [{ id: 'tag-second', name: 'needs-review', slug: 'needs-review' }],
            tagCreationMode: 'freeform',
            now: '2026-08-10T12:00:01.000Z',
          }),
        ]);
        expect(outcomes.flatMap((outcome) => outcome.addedTags)).toHaveLength(1);
        const detail = await harness.persistence.details.getTaskDetail('tag-task', '2026-08-10');
        expect(detail?.tagIds).toHaveLength(1);
        await expect(repository.addTaskTags({
          taskId: 'tag-task',
          candidates: [{ id: 'tag-third', name: 'NEEDS REVIEW', slug: 'needs-review' }],
          tagCreationMode: 'freeform',
          now: '2026-08-10T12:00:02.000Z',
        })).resolves.toEqual({ addedTags: [], rejectedTags: [] });
      });

      it('serializes proposal acceptance against concurrent tag mutation', async () => {
        await harness.insertTasks([{
          id: 'proposal-tag-parent',
          updatedAt: '2026-08-10T12:00:00.000Z',
        }]);
        const repository = harness.persistence.ancillary;
        const expected = await repository.getSubtaskProposalSnapshot('proposal-tag-parent');
        expect(expected).not.toBeNull();
        if (!expected) return;

        const [proposalOutcome, tagOutcome] = await Promise.all([
          repository.acceptSubtaskProposal({
            expected,
            task: {
              ...writableTask('proposal-tag-child', 'Concurrent child'),
              sourceId: 'proposal-tag-child',
              parentId: 'proposal-tag-parent',
              depth: 1,
              isChecklistItem: true,
            },
          }),
          repository.addTaskTags({
            taskId: 'proposal-tag-parent',
            candidates: [{
              id: 'proposal-tag',
              name: 'Concurrent Tag',
              slug: 'concurrent-tag',
            }],
            tagCreationMode: 'freeform',
            now: '2026-08-10T12:01:00.000Z',
          }),
        ]);

        expect(['created', 'stale']).toContain(proposalOutcome.kind);
        expect(tagOutcome.addedTags).toEqual([{
          id: 'proposal-tag',
          name: 'Concurrent Tag',
        }]);
        const subtasks = await repository.listSubtasks('proposal-tag-parent');
        expect(subtasks).toHaveLength(proposalOutcome.kind === 'created' ? 1 : 0);
      });
    });

    describe('quick sort workflow persistence', () => {
      it('captures task revisions and normalized tag order', async () => {
        await harness.insertTasks([{
          id: 'quick-task',
          status: 'todo',
          localDisposition: 'active',
          priority: 'none',
          planningHorizon: null,
          dueDate: '2026-08-20',
          updatedAt: '2026-08-10T12:00:00.000Z',
          effort: 2,
        }]);
        await harness.insertTags([
          { id: 'tag-z', name: 'Zed', slug: 'zed' },
          { id: 'tag-a', name: 'Alpha', slug: 'alpha' },
        ]);
        await harness.insertTaskTags([
          { taskId: 'quick-task', tagId: 'tag-z' },
          { taskId: 'quick-task', tagId: 'tag-a' },
        ]);

        await expect(harness.persistence.quickSort.captureTask('quick-task')).resolves.toMatchObject({
          updatedAt: '2026-08-10T12:00:00.000Z',
          status: 'todo',
          localDisposition: 'active',
          priority: 'none',
          dueDate: '2026-08-20',
          effort: 2,
          tagIds: ['tag-a', 'tag-z'],
        });
      });

      it('reserves an operation exactly once and atomically finalizes ordered log inputs', async () => {
        await harness.insertTasks([{
          id: 'quick-task',
          updatedAt: '2026-08-10T12:00:00.000Z',
        }]);
        const snapshot = await harness.persistence.quickSort.captureTask('quick-task');
        expect(snapshot).not.toBeNull();
        if (!snapshot) return;
        const reservation = {
          id: 'operation-1',
          taskId: 'quick-task',
          mode: 'no_priority' as const,
          action: 'applied' as const,
          label: 'Set priority',
          contextKey: 'queue:no-priority',
          queueIndex: 0,
          beforeSnapshot: { ...snapshot, originalPatch: { priority: 'high' } },
          afterSnapshot: snapshot,
          aiAccepted: false,
          createdAt: '2026-08-10T12:01:00.000Z',
        };

        const outcomes = await Promise.all([
          harness.persistence.quickSort.reserveOperation(reservation),
          harness.persistence.quickSort.reserveOperation(reservation),
        ]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['existing', 'reserved']);

        const applied = await harness.persistence.quickSort.finalizeOperation(
          reservation.id,
          snapshot,
          [
            {
              id: 'log-1',
              taskId: 'quick-task',
              operationId: reservation.id,
              mode: 'no_priority',
              action: 'applied',
              triagedAt: '2026-08-10T12:01:00.000Z',
            },
            {
              id: 'log-2',
              taskId: 'quick-task',
              operationId: reservation.id,
              mode: 'no_effort',
              action: 'applied',
              triagedAt: '2026-08-10T12:01:00.000Z',
            },
          ],
        );
        expect(applied?.state).toBe('applied');
        expect(await harness.listQuickSortLogs(reservation.id)).toEqual([
          expect.objectContaining({ id: 'log-1', mode: 'no_priority' }),
          expect.objectContaining({ id: 'log-2', mode: 'no_effort' }),
        ]);

        const replay = await harness.persistence.quickSort.reserveOperation(reservation);
        expect(replay).toMatchObject({ kind: 'existing', operation: { state: 'applied' } });
      });

      it('allows only one concurrent undo claim and reverses logs idempotently', async () => {
        await harness.insertTasks([{
          id: 'quick-task',
          updatedAt: '2026-08-10T12:00:00.000Z',
        }]);
        const snapshot = await harness.persistence.quickSort.captureTask('quick-task');
        expect(snapshot).not.toBeNull();
        if (!snapshot) return;
        await harness.persistence.quickSort.reserveOperation({
          id: 'operation-undo',
          taskId: 'quick-task',
          mode: 'no_priority',
          action: 'applied',
          label: 'Set priority',
          contextKey: 'queue:no-priority',
          queueIndex: 0,
          beforeSnapshot: { ...snapshot, originalPatch: {} },
          afterSnapshot: snapshot,
          aiAccepted: false,
          createdAt: '2026-08-10T12:01:00.000Z',
        });
        await harness.persistence.quickSort.finalizeOperation(
          'operation-undo',
          snapshot,
          [{
            id: 'log-undo',
            taskId: 'quick-task',
            operationId: 'operation-undo',
            mode: 'no_priority',
            action: 'applied',
            triagedAt: '2026-08-10T12:01:00.000Z',
          }],
        );

        const claims = await Promise.all([
          harness.persistence.quickSort.claimUndo('operation-undo'),
          harness.persistence.quickSort.claimUndo('operation-undo'),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        await expect(harness.persistence.quickSort.finalizeUndo(
          'operation-undo',
          '2026-08-10T12:02:00.000Z',
        )).resolves.toBe(true);
        await expect(harness.persistence.quickSort.finalizeUndo(
          'operation-undo',
          '2026-08-10T12:03:00.000Z',
        )).resolves.toBe(false);
        await expect(harness.persistence.quickSort.claimUndo('operation-undo')).resolves.toBe(false);
        expect(await harness.listQuickSortLogs('operation-undo')).toEqual([
          expect.objectContaining({ id: 'log-undo', reversedAt: '2026-08-10T12:02:00.000Z' }),
        ]);
      });

      it('excludes skipped and reversed activity from stats reads', async () => {
        await harness.insertTasks([{ id: 'quick-task' }]);
        await harness.insertQuickSortLogs([
          {
            id: 'active',
            taskId: 'quick-task',
            mode: 'quadrant',
            action: 'applied',
            triagedAt: '2026-08-10T12:00:00.000Z',
          },
          {
            id: 'skipped',
            taskId: 'quick-task',
            mode: 'quadrant',
            action: 'skipped',
            triagedAt: '2026-08-10T12:01:00.000Z',
          },
          {
            id: 'reversed',
            taskId: 'quick-task',
            mode: 'no_effort',
            action: 'applied',
            triagedAt: '2026-08-10T12:02:00.000Z',
            reversedAt: '2026-08-10T12:03:00.000Z',
          },
        ]);

        await expect(harness.persistence.quickSort.countActivityByModeSince(
          '2026-08-10T00:00:00.000Z',
        )).resolves.toEqual([{ mode: 'quadrant', count: 1 }]);
        await expect(harness.persistence.quickSort.listActivityTimestampsSince(
          '2026-08-10T00:00:00.000Z',
        )).resolves.toEqual(['2026-08-10T12:00:00.000Z']);
      });
    });

    describe('collection, detail, and write transactions', () => {
      it('hydrates collection/detail data and treats search metacharacters literally', async () => {
        await harness.insertTasks([
          ...baseTasks(),
          { id: 'task-literal', title: 'Literal 100%_ complete', sourceId: 'local:literal' },
        ]);
        await harness.insertTags([
          { id: 'tag-api', name: 'API', slug: 'api' },
          { id: 'tag-selected', name: 'Selected', slug: 'selected' },
        ]);
        await harness.insertTaskTags([{ taskId: 'task-literal', tagId: 'tag-api' }]);
        await harness.insertProjects([{ id: 'project-1', name: 'Project One' }]);
        await harness.insertTaskProjects([{ taskId: 'task-literal', projectId: 'project-1' }]);
        await harness.insertTaskSchedules([{
          taskId: 'task-literal',
          scheduledDate: TODAY,
          estimatedDuration: 45,
        }]);
        await harness.insertMyDayItems([{ id: 'my-day-literal', taskId: 'task-literal', date: TODAY }]);

        const collection = await harness.persistence.collections.readTaskCollection({
          spec: makeSpec({ search: '100%_' }),
          page: { order: { field: 'createdAt', direction: 'asc' }, limit: 20, offset: 0 },
          includeTags: true,
          includeScoreInputs: false,
          countsOnly: false,
          smartScoreCandidateLimit: 100,
        });
        expect(collection.rows.map((row) => row.id)).toEqual(['task-literal']);
        expect(collection.rows[0]).toMatchObject({
          estimatedDuration: 45,
          projectIds: ['project-1'],
        });
        expect(collection.rows[0].tags.map((tag) => tag.id)).toEqual(['tag-api']);

        const detail = await harness.persistence.details.getTaskDetail('task-literal', TODAY);
        expect(detail).toMatchObject({
          tagIds: ['tag-api'],
          projectIds: ['project-1'],
          isInMyDay: true,
          schedule: { estimatedDuration: 45 },
        });
        expect(await harness.persistence.mutations.getTaskWriteContext(
          'task-literal',
          ['tag-selected'],
        )).toMatchObject({
          tagIds: ['tag-api'],
          tagNamesById: {
            'tag-api': 'API',
            'tag-selected': 'Selected',
          },
        });
      });

      it('creates once from triage and replays without duplicating the task or event', async () => {
        await harness.insertTriageItem({
          id: 'triage-create',
          title: 'Create me',
          url: 'https://example.test/create',
        });
        const task = writableTask('created-from-triage');
        const input = {
          task,
          tagIds: [],
          tagSlugs: ['Needs Review'],
          tagCreationMode: 'freeform' as const,
          projectIds: [],
          schedule: null,
          triageItemId: 'triage-create',
          triageClaimId: 'claim-create',
          requireConnectorEnabled: true,
          requireSelectedSourceList: true,
          event: {
            stableKey: 'task-created:created-from-triage',
            type: 'task.created' as const,
            timestamp: task.createdAt,
            payload: { taskId: task.id },
          },
        };

        expect(await harness.persistence.creates.createTask(input)).toMatchObject({
          kind: 'committed',
        });
        expect(await harness.persistence.creates.createTask(input)).toEqual({
          kind: 'triage-replay',
          taskId: task.id,
        });
        expect((await harness.listTaskIds()).filter((id) => id === task.id)).toHaveLength(1);
        expect(await harness.countOutboxEvents(input.event.stableKey)).toBe(1);
      });

      it('releases a triage claim when validation rejects the create', async () => {
        await harness.insertTriageItem({
          id: 'triage-retry',
          title: 'Retry me',
          url: 'https://example.test/retry',
        });
        const invalid = {
          ...writableTask('invalid-create'),
          connectorType: 'missing',
          connectorInstanceId: 'missing',
        };
        const event = {
          stableKey: 'task-created:triage-retry',
          type: 'task.created' as const,
          timestamp: invalid.createdAt,
          payload: { taskId: invalid.id },
        };
        const baseInput = {
          tagIds: [],
          tagSlugs: [],
          tagCreationMode: 'freeform' as const,
          projectIds: [],
          schedule: null,
          triageItemId: 'triage-retry',
          triageClaimId: 'claim-retry',
          requireConnectorEnabled: true,
          requireSelectedSourceList: true,
          event,
        };
        expect(await harness.persistence.creates.createTask({ ...baseInput, task: invalid }))
          .toEqual({ kind: 'connector-not-found' });

        const retry = writableTask('valid-create');
        expect(await harness.persistence.creates.createTask({
          ...baseInput,
          task: retry,
          event: { ...event, payload: { taskId: retry.id } },
        })).toMatchObject({ kind: 'committed' });
      });

      it('rolls back a triage claim when task insertion fails', async () => {
        await harness.insertTasks([{ id: 'duplicate-create' }]);
        await harness.insertTriageItem({
          id: 'triage-rollback',
          title: 'Retry after rollback',
          url: 'https://example.test/rollback',
        });
        const request = (task: TaskCoreTaskRow) => ({
          task,
          tagIds: [],
          tagSlugs: [],
          tagCreationMode: 'freeform' as const,
          projectIds: [],
          schedule: null,
          triageItemId: 'triage-rollback',
          triageClaimId: 'claim-rollback',
          requireConnectorEnabled: false,
          requireSelectedSourceList: false,
          event: {
            stableKey: `task-created:${task.id}`,
            type: 'task.created' as const,
            timestamp: task.createdAt,
            payload: { taskId: task.id },
          },
        });

        await expect(harness.persistence.creates.createTask(
          request(writableTask('duplicate-create')),
        )).rejects.toThrow();
        expect(await harness.persistence.creates.createTask(
          request(writableTask('create-after-rollback')),
        )).toMatchObject({ kind: 'committed' });
      });

      it('fences concurrent patches with updatedAt CAS and deduplicates outbox events', async () => {
        await harness.insertTasks([{ id: 'task-cas', title: 'Before', updatedAt: NOW }]);
        const event = {
          stableKey: 'task-updated:task-cas:one',
          type: 'task.updated' as const,
          timestamp: '2026-08-05T12:01:00.000Z',
          payload: { taskId: 'task-cas' },
        };
        const first = await harness.persistence.mutations.mutateTask({
          taskId: 'task-cas',
          expectedUpdatedAt: NOW,
          expectedStatusForTerminalTransition: null,
          now: event.timestamp,
          patch: { title: 'After' },
          events: [event, event],
        });
        expect(first).toMatchObject({ kind: 'committed', task: { title: 'After' } });
        expect(await harness.persistence.mutations.mutateTask({
          taskId: 'task-cas',
          expectedUpdatedAt: NOW,
          expectedStatusForTerminalTransition: null,
          now: '2026-08-05T12:02:00.000Z',
          patch: { title: 'Stale' },
        })).toEqual({
          kind: 'revision-conflict',
          currentUpdatedAt: event.timestamp,
        });
        expect(await harness.countOutboxEvents(event.stableKey)).toBe(1);
      });

      it('creates one recurrence successor and copies local relationships', async () => {
        await harness.insertTasks([{ id: 'task-recurring', updatedAt: NOW }]);
        await harness.insertTags([{ id: 'tag-recurring', name: 'Recurring', slug: 'recurring' }]);
        await harness.insertTaskTags([{ taskId: 'task-recurring', tagId: 'tag-recurring' }]);
        await harness.insertProjects([{ id: 'project-recurring', name: 'Recurring Project' }]);
        await harness.insertTaskProjects([{
          taskId: 'task-recurring',
          projectId: 'project-recurring',
        }]);
        await harness.insertProjectPhases([{
          id: 'phase-recurring',
          projectId: 'project-recurring',
          name: 'Recurring Phase',
          taskIds: ['task-recurring'],
        }]);
        await harness.insertTasks([{ id: 'task-prerequisite' }]);
        await harness.insertTaskDependencies([{
          id: 'dependency-recurring',
          taskId: 'task-recurring',
          dependsOnTaskId: 'task-prerequisite',
        }]);
        await harness.insertTaskSchedules([{
          taskId: 'task-recurring',
          scheduledDate: TODAY,
          estimatedDuration: 30,
          recurrence: 'FREQ=DAILY',
        }]);
        await harness.insertAttachments([{
          id: 'attachment-recurring',
          taskId: 'task-recurring',
          name: 'context.txt',
          size: 7,
        }]);
        const firstNow = '2026-08-05T12:01:00.000Z';
        const first = await harness.persistence.mutations.mutateTask({
          taskId: 'task-recurring',
          expectedUpdatedAt: NOW,
          expectedStatusForTerminalTransition: 'todo',
          now: firstNow,
          patch: { status: 'done', completedAt: firstNow },
          recurrenceSuccessor: {
            id: 'task-successor',
            dueDate: WEEK,
            scheduledDate: WEEK,
            scheduledTime: null,
            reminderAt: null,
            metadata: { recurrence: 'FREQ=DAILY' },
          },
        });
        expect(first).toMatchObject({
          kind: 'committed',
          recurrenceNextTaskId: 'task-successor',
        });
        expect(await harness.listTaskTagIds('task-successor')).toEqual(['tag-recurring']);
        expect(await harness.listTaskProjectIds('task-successor')).toEqual(['project-recurring']);
        expect(await harness.listProjectPhaseIds('task-successor')).toEqual(['phase-recurring']);
        expect(await harness.listTaskDependencyIds('task-successor')).toEqual(['task-prerequisite']);
        expect(await harness.listAttachmentTaskIds()).toContain('task-successor');

        const second = await harness.persistence.mutations.mutateTask({
          taskId: 'task-recurring',
          expectedUpdatedAt: firstNow,
          expectedStatusForTerminalTransition: null,
          now: '2026-08-05T12:02:00.000Z',
          patch: {},
          recurrenceSuccessor: {
            id: 'task-successor-duplicate',
            dueDate: WEEK,
            scheduledDate: WEEK,
            scheduledTime: null,
            reminderAt: null,
            metadata: {},
          },
        });
        expect(second).toMatchObject({
          kind: 'committed',
          recurrenceNextTaskId: 'task-successor',
        });
        expect(await harness.listTaskIds()).not.toContain('task-successor-duplicate');
      });

      it('deletes a local task atomically and rejects a stale deletion', async () => {
        await harness.insertTasks([{ id: 'task-delete', updatedAt: NOW }]);
        expect(await harness.persistence.removals.applyTaskRemoval({
          taskId: 'task-delete',
          expectedUpdatedAt: 'stale',
          mode: 'local-delete',
          now: NOW,
        })).toEqual({ kind: 'revision-conflict', currentUpdatedAt: NOW });
        expect(await harness.persistence.removals.applyTaskRemoval({
          taskId: 'task-delete',
          expectedUpdatedAt: NOW,
          mode: 'local-delete',
          now: NOW,
        })).toEqual({ kind: 'committed', action: 'deleted', taskVersion: null });
        expect(await harness.persistence.details.getTaskDetail('task-delete', TODAY)).toBeNull();
      });

      it('fences remote deletion finalization by both lease and task version', async () => {
        await harness.insertTasks([{
          id: 'task-remote-delete',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          syncStatus: 'pushing',
          lastSyncedAt: 'lease-token',
          updatedAt: NOW,
        }]);
        expect(await harness.persistence.removals.finalizeRemoteTaskRemoval({
          taskId: 'task-remote-delete',
          leaseToken: 'stale-token',
          expectedUpdatedAt: NOW,
        })).toEqual({ kind: 'revision-conflict', currentUpdatedAt: NOW });
        expect(await harness.persistence.removals.finalizeRemoteTaskRemoval({
          taskId: 'task-remote-delete',
          leaseToken: 'lease-token',
          expectedUpdatedAt: NOW,
        })).toEqual({ kind: 'committed', action: 'deleted', taskVersion: null });
      });
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

      it('treats the week quick filter as today through seven days from now', async () => {
        await harness.insertTasks([
          {
            ...writableTask('week-boundary'),
            dueDate: WEEK,
          },
          {
            ...writableTask('outside-week'),
            dueDate: '2026-08-18',
          },
        ]);

        expect(await harness.persistence.queries.countTasks(
          makeSpec({ quickFilter: 'week' }),
          { includeQuickFilter: true },
        )).toBe(2);
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

      it('preserves legacy COALESCE(effort, 0) ordering on both backends', async () => {
        expect(await page('effort', 'asc')).toEqual(['nul-a', 'nul-b', 'set-x', 'set-y']);
        expect(await page('effort', 'desc')).toEqual(['set-y', 'set-x', 'nul-a', 'nul-b']);
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
          copiedTo: {
            taskId: 'wt-successor',
            sourceId: 'remote-successor',
            connectorType: 'github-issues',
            connectorInstanceId: 'github-1',
            sourceListId: 'repo-1',
            copiedAt: MOVE_NOW,
          },
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

      it('merges copy provenance without erasing an active move claim', async () => {
        await moves().claimTaskMove(claim({
          claimToken: 'copy-race-claim',
          metadata: {
            origin: 'seed',
            taskMoveClaim: {
              token: 'copy-race-claim',
              claimedAt: MOVE_NOW,
              previousSyncStatus: 'synced',
            },
          },
        }));

        await moves().recordSourceCopyProvenance({
          taskId: 'wt-source',
          updatedAt: MOVE_NOW,
          copiedTo: {
            taskId: 'wt-successor',
            sourceId: 'remote-successor',
            connectorType: 'github-issues',
            connectorInstanceId: 'github-1',
            sourceListId: 'repo-1',
            copiedAt: MOVE_NOW,
          },
        });

        expect(await moves().getTask('wt-source')).toMatchObject({
          syncStatus: 'move_in_progress',
          metadata: {
            origin: 'seed',
            copiedTo: { taskId: 'wt-successor' },
            taskMoveClaim: { token: 'copy-race-claim' },
          },
        });
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

    describe('endpoint-oriented task reads', () => {
      it('loads task-scoped attachment and document-preview contexts', async () => {
        await harness.insertTasks([
          {
            id: 'read-task',
            sourceId: 'remote:read-task',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'owl-read',
            metadata: { documentId: 42 },
          },
          {
            id: 'disabled-task',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'owl-disabled',
            metadata: { documentId: 99 },
          },
          {
            id: 'deleted-task',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'owl-deleted',
            metadata: { documentId: 100 },
          },
          {
            id: 'wrong-connector-task',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'wrong-connector',
            metadata: { documentId: 101 },
          },
        ]);
        await harness.insertAttachments([{
          id: 'attachment-read',
          taskId: 'read-task',
          name: 'read.pdf',
          contentType: 'application/pdf',
          size: 8,
          contentBase64: 'JVBERi0=',
          sourceAttachmentId: 'remote-attachment',
        }]);
        await harness.insertConnectors([
          {
            id: 'owl-read',
            type: 'document-intelligence',
            credentials: { apiKey: 'key' },
            settings: { baseUrl: 'https://owl.example' },
          },
          {
            id: 'owl-disabled',
            type: 'document-intelligence',
            enabled: false,
          },
          {
            id: 'owl-deleted',
            type: 'document-intelligence',
            deletedAt: NOW,
          },
          {
            id: 'wrong-connector',
            type: 'github-issues',
          },
        ]);

        expect(await harness.persistence.taskReads.getAttachmentReadContext(
          'read-task',
          'attachment-read',
        )).toEqual({
          task: {
            sourceId: 'remote:read-task',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'owl-read',
          },
          attachment: {
            name: 'read.pdf',
            contentType: 'application/pdf',
            contentBase64: 'JVBERi0=',
            sourceAttachmentId: 'remote-attachment',
          },
        });
        expect(await harness.persistence.taskReads.getAttachmentReadContext(
          'disabled-task',
          'attachment-read',
        )).toMatchObject({ attachment: null });
        expect(await harness.persistence.taskReads.getAttachmentReadContext(
          'missing-task',
          'attachment-read',
        )).toEqual({ task: null, attachment: null });

        expect(await harness.persistence.taskReads.getDocumentPreviewContext('read-task'))
          .toEqual({
            task: {
              connectorType: 'document-intelligence',
              connectorInstanceId: 'owl-read',
              metadata: { documentId: 42 },
            },
            connector: {
              credentials: { apiKey: 'key' },
              settings: { baseUrl: 'https://owl.example' },
            },
          });
        expect(await harness.persistence.taskReads.getDocumentPreviewContext('disabled-task'))
          .toMatchObject({ connector: null });
        expect(await harness.persistence.taskReads.getDocumentPreviewContext('deleted-task'))
          .toMatchObject({ connector: null });
        expect(await harness.persistence.taskReads.getDocumentPreviewContext('wrong-connector-task'))
          .toMatchObject({ connector: null });
      });

      it('returns linked-source DTOs without requiring the task to exist', async () => {
        await harness.insertLinkedSources([{
          id: 'linked-1',
          taskId: 'not-present',
          connectorType: 'github-issues',
          connectorInstanceId: 'gh-1',
          sourceId: 'issue:1',
          title: 'Linked issue',
          linkedAt: NOW,
          matchConfidence: 0.8,
          metadata: { repository: 'owner/repo' },
        }]);

        expect(await harness.persistence.taskReads.listLinkedSources('not-present')).toEqual([{
          id: 'linked-1',
          taskId: 'not-present',
          connectorType: 'github-issues',
          connectorInstanceId: 'gh-1',
          sourceId: 'issue:1',
          title: 'Linked issue',
          linkedAt: NOW,
          matchConfidence: 0.8,
          metadata: { repository: 'owner/repo' },
        }]);
        expect(await harness.persistence.taskReads.listLinkedSources('missing')).toEqual([]);
      });

      it('searches relationship candidates with SQLite LIKE wildcard and binary ordering', async () => {
        await harness.insertTasks([
          { id: 'source', title: 'Source task' },
          { id: 'candidate-b', title: 'alpha task' },
          { id: 'candidate-a', title: 'Alpha task' },
          { id: 'candidate-other', title: 'Other' },
        ]);
        await harness.insertProjects([{ id: 'project-read', name: 'Read Project' }]);
        await harness.insertTaskProjects([
          { taskId: 'candidate-a', projectId: 'project-read' },
        ]);

        const candidates = await harness.persistence.taskReads.searchRelationshipCandidates({
          taskId: 'source',
          query: 'ALPHA',
          limit: 50,
        });
        expect(candidates?.map((candidate) => candidate.id))
          .toEqual(['candidate-a', 'candidate-b']);
        expect(candidates?.[0]).toMatchObject({
          projectIds: ['project-read'],
          projectNames: ['Read Project'],
        });
        expect(await harness.persistence.taskReads.searchRelationshipCandidates({
          taskId: 'source',
          query: '%',
          limit: 1,
        })).toHaveLength(1);
        expect(await harness.persistence.taskReads.searchRelationshipCandidates({
          taskId: 'missing',
          query: '',
          limit: 20,
        })).toBeNull();
      });

      it('preserves duplicate candidate visibility and binary assignee ordering', async () => {
        await harness.insertTasks([
          { id: 'open-a', status: 'todo', assignee: 'alice' },
          { id: 'open-b', status: 'in_progress', assignee: ' Bob ' },
          { id: 'closed', status: 'done', assignee: 'alice' },
          { id: 'blank', status: 'todo', assignee: '   ' },
        ]);

        expect((await harness.persistence.taskReads.listDuplicateDetectionTasks({
          includeClosedTasks: false,
        })).map((task) => task.id).sort()).toEqual(['blank', 'open-a', 'open-b']);
        expect(await harness.persistence.taskReads.listDuplicateDetectionTasks({
          includeClosedTasks: true,
        })).toHaveLength(4);
        expect(await harness.persistence.taskReads.listDistinctTaskAssignees())
          .toEqual(['   ', ' Bob ', 'alice']);
      });

      it('computes scalar and many-to-many groups with canonical visibility', async () => {
        await harness.insertTasks([
          {
            id: 'group-a',
            title: 'Group A',
            priority: 'high',
            planningHorizon: 'next',
            dueDate: TODAY,
            sourceListId: 'list-a',
            sourceListName: 'Raw List',
            effort: 2,
          },
          {
            id: 'group-b',
            title: 'Group B',
            status: 'in_progress',
            priority: '',
            connectorType: '',
            dueDate: null,
            effort: null,
          },
        ]);
        await harness.insertSourceLists([{
          id: 'source-list-a',
          connectorInstanceId: 'local',
          sourceId: 'list-a',
          name: 'List A',
          userDisplayName: 'Pretty List',
        }]);
        await harness.insertTags([{ id: 'group-tag', name: 'Grouped', slug: 'grouped' }]);
        await harness.insertTaskTags([{ taskId: 'group-a', tagId: 'group-tag' }]);
        await harness.insertProjects([{ id: 'group-project', name: 'Project' }]);
        await harness.insertTaskProjects([{ taskId: 'group-a', projectId: 'group-project' }]);
        await harness.insertProjectPhases([{
          id: 'group-phase',
          projectId: 'group-project',
          name: 'Phase',
          taskIds: ['group-a'],
        }]);

        const expected = {
          status: { 'To Do': 1, 'In Progress': 1 },
          priority: { high: 1, none: 1 },
          planningHorizon: { Next: 1, 'Not set': 1 },
          source: { local: 2 },
          list: { 'Pretty List': 1, 'No List': 1 },
          effort: { '2': 1, 'No Effort': 1 },
          dueDate: { Today: 1, 'No Due Date': 1 },
          tag: { Grouped: 1, Untagged: 1 },
          project: { 'Project › Phase': 1, 'No Project': 1 },
        } as const;
        for (const groupBy of Object.keys(expected) as Array<keyof typeof expected>) {
          expect(await harness.persistence.taskReads.getGroupCounts({
            spec: makeSpec(),
            groupBy,
          })).toEqual(expected[groupBy]);
        }
      });

      it('applies quick-sort scope, ordering, associations, and skip boundaries', async () => {
        const now = '2026-08-10T12:00:00.000Z';
        const skipCutoff = '2026-08-03T12:00:00.000Z';
        await harness.insertTasks([
          {
            id: 'queue-b',
            title: 'Queue B',
            priority: 'none',
            createdAt: '2026-08-09T00:00:00.000Z',
            sourceListId: 'list-a',
            sourceListName: 'Raw List',
          },
          {
            id: 'queue-a',
            title: 'Queue A',
            priority: 'none',
            createdAt: '2026-08-09T00:00:00.000Z',
            sourceListId: 'list-a',
            sourceListName: 'Raw List',
          },
          { id: 'queue-closed', status: 'done', priority: 'none' },
          { id: 'queue-child', parentId: 'queue-a', priority: 'none' },
          { id: 'queue-snoozed', snoozedUntil: '2026-08-11T00:00:00.000Z', priority: 'none' },
          { id: 'queue-skipped', priority: 'none' },
          { id: 'queue-boundary', priority: 'none' },
          {
            id: 'queue-notification',
            connectorType: 'outlook-email',
            connectorInstanceId: 'mail-1',
            priority: 'none',
          },
          {
            id: 'queue-deleted',
            connectorType: 'github-issues',
            connectorInstanceId: 'deleted-connector',
            priority: 'none',
          },
        ]);
        await harness.insertConnectors([{
          id: 'deleted-connector',
          type: 'github-issues',
          deletedAt: '2026-08-09T00:00:00.000Z',
        }]);
        await harness.insertQuickSortLogs([{
          id: 'skip-log',
          taskId: 'queue-skipped',
          action: 'skipped',
          triagedAt: '2026-08-09T00:00:00.000Z',
        }, {
          id: 'boundary-log',
          taskId: 'queue-boundary',
          action: 'skipped',
          triagedAt: skipCutoff,
        }]);
        await harness.insertTags([{ id: 'queue-tag', name: 'Queue', slug: 'queue' }]);
        await harness.insertTaskTags([{ taskId: 'queue-a', tagId: 'queue-tag' }]);
        await harness.insertProjects([{ id: 'queue-project', name: 'Queue Project' }]);
        await harness.insertTaskProjects([{ taskId: 'queue-a', projectId: 'queue-project' }]);
        await harness.insertProjectPhases([{
          id: 'queue-phase',
          projectId: 'queue-project',
          name: 'Queue Phase',
          taskIds: ['queue-a'],
        }]);
        await harness.insertSourceLists([{
          id: 'queue-list',
          connectorInstanceId: 'local',
          sourceId: 'list-a',
          name: 'Raw List',
          userDisplayName: 'Queue List',
          icon: 'list',
        }]);
        const scope = {
          now,
          skipCutoff,
          sourceTypes: [] as string[],
          sourceListId: null,
          sourceListName: null,
          connectorInstanceId: null,
        };

        expect(await harness.persistence.taskReads.getQuickSortCounts(scope)).toEqual({
          no_priority: 4,
          quadrant: 4,
          no_effort: 4,
          no_tags: 3,
          no_planning_horizon: 4,
        });
        const queue = await harness.persistence.taskReads.listQuickSortTasks({
          ...scope,
          mode: 'no_priority',
          order: 'newest',
          limit: 50,
        });
        expect(queue.map((task) => task.id))
          .toEqual(['queue-a', 'queue-b', 'queue-boundary', 'queue-notification']);
        expect(queue[0]).toMatchObject({
          tags: [{ id: 'queue-tag', name: 'Queue', slug: 'queue', color: null }],
          projects: [{ id: 'queue-project', name: 'Queue Project' }],
          phases: [{ id: 'queue-phase', name: 'Queue Phase', projectId: 'queue-project' }],
        });
        expect((await harness.persistence.taskReads.listQuickSortTasks({
          ...scope,
          mode: 'no_tags',
          order: 'smart',
          limit: 50,
        })).map((task) => task.id)).toEqual([
          'queue-boundary',
          'queue-notification',
          'queue-b',
        ]);

        const sources = await harness.persistence.taskReads.listQuickSortSources({ now, skipCutoff });
        expect(sources.rows.reduce((total, row) => total + row.count, 0)).toBe(4);
        expect(sources.definitions).toContainEqual(expect.objectContaining({
          sourceId: 'list-a',
          userDisplayName: 'Queue List',
          hidden: false,
        }));
      });

      it('returns deterministic quick-sort suggestion inputs', async () => {
        await harness.insertTasks([
          { id: 'suggestion-task', title: 'Fix bug', priority: 'none' },
          { id: 'other-task', title: 'Other task' },
        ]);
        await harness.insertTags([
          { id: 'tag-b', name: 'B', slug: 'b' },
          { id: 'tag-a', name: 'A', slug: 'a' },
        ]);
        await harness.insertTaskTags([
          { taskId: 'suggestion-task', tagId: 'tag-a' },
          { taskId: 'other-task', tagId: 'tag-b' },
        ]);
        await harness.insertSourceRankings([{
          id: 'local',
          connectorType: 'local',
          name: 'Local',
          rank: 1,
        }]);

        const inputs = await harness.persistence.taskReads
          .getQuickSortSuggestionInputs(['suggestion-task', 'missing']);
        expect(inputs.tasks.map((task) => task.id)).toEqual(['suggestion-task']);
        expect(inputs.sourceRankings).toEqual([{
          id: 'local',
          connectorType: 'local',
          name: 'Local',
          rank: 1,
          updatedAt: NOW,
        }]);
        expect(inputs.tags.map((tag) => tag.id)).toEqual(['tag-a', 'tag-b']);
        expect(inputs.taskTags).toHaveLength(2);
      });
    });

    describe('transfer-identity reconciliation', () => {
      const CONNECTOR_ID = 'conn-ti';
      const FOREIGN_CONNECTOR_ID = 'conn-mismatch';

      beforeEach(async () => {
        await harness.insertSourceLists([
          { id: 'sl-ti-x', connectorInstanceId: CONNECTOR_ID, sourceId: 'list-x', name: 'List X' },
          { id: 'sl-ti-y', connectorInstanceId: CONNECTOR_ID, sourceId: 'list-y', name: 'List Y' },
          // Same sourceId under a different connector: must never resolve for 'conn-ti'.
          {
            id: 'sl-other-x',
            connectorInstanceId: FOREIGN_CONNECTOR_ID,
            sourceId: 'list-only-other',
            name: 'Other List X',
          },
        ]);
        await harness.insertTasks([
          {
            id: 'ti-task',
            title: 'Transfer identity task',
            connectorType: 'github',
            connectorInstanceId: CONNECTOR_ID,
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
          expect(CONNECTOR_ID).not.toBe(FOREIGN_CONNECTOR_ID);
          const result = await harness.persistence.transferIdentity.resolveIdentityTargets({
            taskId: 'ti-task',
            connectorInstanceId: CONNECTOR_ID,
            sourceListIds: ['list-only-other'],
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
