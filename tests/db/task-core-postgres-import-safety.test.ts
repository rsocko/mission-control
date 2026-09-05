import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';

/**
 * Poisoned-SQLite proof for the L04/L05 task-core surface.
 *
 * `@/db` (the module that opens better-sqlite3) is replaced with a module that
 * throws the moment anything imports it, and the backend is switched to
 * PostgreSQL. Every migrated task-core consumer must still *import* and
 * *execute*, which is exactly the property the web-persistence ratchet claims
 * when it moves these files out of the Tier A taint set. A regression that
 * reintroduces a static `@/db` import into any of them fails here loudly
 * instead of only failing in production under PostgreSQL.
 */

const poisonState = vi.hoisted(() => ({ triggered: false }));

vi.mock('@/db', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: @/db must not be imported by migrated task-core consumers');
});
vi.mock('@/db/index', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: src/db/index.ts must not be imported');
});
vi.mock('@/db/bootstrap/connection', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: SQLite bootstrap must not be imported');
});
vi.mock('@/db/persistence/sqlite-task-core-repositories', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: SQLite task-core adapter must not be imported');
});
vi.mock('better-sqlite3', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: better-sqlite3 must not be imported');
});
vi.mock('drizzle-orm/better-sqlite3', () => {
  poisonState.triggered = true;
  throw new Error('POISONED: the SQLite Drizzle driver must not be imported');
});

/**
 * `@/lib/connectors/transfer-identity` is the single L06-owned module that
 * still reaches `@/db`, and it is the *only* reason
 * `src/lib/tasks/task-move-write-through.ts` is still counted in the Tier A
 * taint set. Stubbing exactly that one edge here proves the write-through
 * move's own code has no SQLite coupling left: if a `@/db` import were
 * reintroduced anywhere in the move itself, the poison above would fire.
 */
vi.mock('@/lib/connectors/transfer-identity', () => ({
  persistCreatedTaskIdentity: vi.fn(async () => undefined),
  reconcileTransferIdentity: vi.fn(async () => undefined),
}));

const originalBackend = process.env.MC_DATABASE_BACKEND;

let runtime: typeof import('@/lib/tasks/core/runtime');
let corePersistenceRuntime: typeof import('@/lib/persistence/runtime');
let createPostgresTaskCorePersistence:
  typeof import('@/db/postgres/repositories/task-core-repositories')
    .createPostgresTaskCorePersistence;
let modules: {
  scoutHardDelete: typeof import('@/lib/tasks/scout-hard-delete');
  lifecycle: typeof import('@/lib/tasks/local-task-lifecycle');
  listNames: typeof import('@/lib/utils/resolve-task-list-names');
  priorityEntities: typeof import('@/lib/priority-entities');
  editPolicy: typeof import('@/lib/tasks/edit-policy');
  mutationPolicy: typeof import('@/lib/tasks/mutation-policy');
  canonicalFilter: typeof import('@/app/api/tasks/canonical-filter');
  queryBuilder: typeof import('@/app/api/tasks/query-builder');
  filterFactory: typeof import('@/app/api/tasks/filter-factory');
  filterQuery: typeof import('@/app/api/tasks/filter-query');
  statsComputer: typeof import('@/app/api/tasks/stats-computer');
  pendingSyncMove: typeof import('@/lib/tasks/task-move-pending-sync');
  writeThroughMove: typeof import('@/lib/tasks/task-move-write-through');
  attachmentContent: typeof import('@/app/api/tasks/[id]/attachments/[attachmentId]/route');
  documentPreview: typeof import('@/app/api/tasks/[id]/document-preview/route');
  linkedSources: typeof import('@/app/api/tasks/[id]/linked-sources/route');
  relationshipCandidates: typeof import('@/app/api/tasks/[id]/relationship-candidates/route');
  duplicateDetection: typeof import('@/app/api/tasks/detect-duplicates/route');
  filterOptions: typeof import('@/app/api/tasks/filter-options/route');
  groupCounts: typeof import('@/app/api/tasks/group-counts/route');
  quickSort: typeof import('@/app/api/tasks/quick-sort/route');
  quickSortSuggestions: typeof import('@/app/api/tasks/quick-sort/suggestions/route');
  quickSortStats: typeof import('@/app/api/tasks/quick-sort-stats/route');
  quickSortOperations: typeof import('@/app/api/tasks/quick-sort/operations/route');
  quickSortUndo: typeof import('@/app/api/tasks/quick-sort/operations/[id]/undo/route');
};

const calls: string[] = [];

function createPostgresReadDatabaseDouble() {
  const select = vi.fn((selection: Record<string, unknown> = {}) => {
    const keys = Object.keys(selection);
    const terminal = keys.includes('attachmentId')
      ? [{
          sourceId: 'local:task-1',
          connectorType: 'local',
          connectorInstanceId: 'local',
          attachmentId: 'attachment-1',
          attachmentName: 'proof.txt',
          attachmentContentType: 'text/plain',
          attachmentContentBase64: 'cHJvb2Y=',
          sourceAttachmentId: null,
        }]
      : keys.includes('documentConnectorId')
        ? [{
            connectorType: 'local',
            connectorInstanceId: 'local',
            metadata: {},
            documentConnectorId: null,
            credentials: null,
            settings: null,
          }]
        : keys.includes('linkedAt')
          ? []
          : keys.length === 1 && keys[0] === 'id'
            ? [{ id: 'task-1' }]
            : keys.includes('sourceListName') && !keys.includes('createdAt')
              ? []
              : keys.includes('snoozedUntil')
                ? []
                : keys.includes('createdAt')
                  ? []
                  : keys.includes('assignee')
                    ? []
                    : keys.includes('group')
                      ? [{ group: 'To Do', count: 1 }]
                      : keys.length === 1 && keys[0] === 'count'
                        ? [{ count: 0 }]
                        : [];
    const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve(terminal);
        }
        return () => chain;
      },
    });
    return chain;
  });
  return { select };
}

function fakePersistence(): TaskCorePersistence {
  const record = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };

  return {
    collections: {
      readTaskCollection: () => record('readTaskCollection', {
        rows: [],
        total: 0,
        stats: {
          totalOpen: 0, overdue: 0, dueToday: 0, dueThisWeek: 0,
          noDate: 0, highPriority: 0, assignedToMe: 0, myDay: 0,
          recentlyCreated: 0, recentlyClosed: 0, waiting: 0, inbox: 0,
        },
        sourceCounts: {},
        availableTags: [],
        connectorContexts: [],
        smartScore: null,
      }),
    },
    details: {
      getTaskDetail: () => record('getTaskDetail', null),
    },
    creates: {
      resolveTaskCreateTarget: () => record(
        'resolveTaskCreateTarget',
        { kind: 'connector-not-found' as const },
      ),
      createTask: () => record('createTask', { kind: 'connector-not-found' as const }),
    },
    mutations: {
      getTaskWriteContext: () => record('getTaskWriteContext', null),
      mutateTask: () => record('mutateTask', { kind: 'not-found' as const }),
    },
    removals: {
      getTaskRemovalContext: () => record('getTaskRemovalContext', null),
      applyTaskRemoval: () => record('applyTaskRemoval', { kind: 'not-found' as const }),
      finalizeRemoteTaskRemoval: () => record(
        'finalizeRemoteTaskRemoval',
        { kind: 'not-found' as const },
      ),
    },
    ancillary: {
      getTask: () => record('ancillaryGetTask', null),
      getAttachmentListContext: () => record(
        'getAttachmentListContext',
        { task: null, attachments: [] },
      ),
      getAttachmentDeleteContext: () => record(
        'getAttachmentDeleteContext',
        { task: null, attachment: null },
      ),
      insertAttachment: () => record('insertAttachment', { kind: 'task-not-found' as const }),
      deleteAttachment: () => record('deleteAttachment', false),
      copyTask: () => record('copyTask', { kind: 'task-not-found' as const }),
      promoteSubtask: () => record('promoteSubtask', { kind: 'not-found' as const }),
      listSubtasks: () => record('listSubtasks', []),
      getSubtaskProposalSnapshot: () => record('getSubtaskProposalSnapshot', null),
      createSubtask: () => record('createSubtask', { kind: 'parent-not-found' as const }),
      acceptSubtaskProposal: () => record('acceptSubtaskProposal', { kind: 'stale' as const }),
      completeSubtaskWriteThrough: () => record('completeSubtaskWriteThrough', false),
      failSubtaskWriteThrough: () => record('failSubtaskWriteThrough', false),
      getTagMutationContext: () => record(
        'getTagMutationContext',
        { task: null, storedCapabilities: {} },
      ),
      addTaskTags: () => record('addTaskTags', { addedTags: [], rejectedTags: [] }),
      removeTaskTag: () => record('removeTaskTag', { removed: false, tagName: null }),
    },
    taskReads: {
      getAttachmentReadContext: () => record('getAttachmentReadContext', {
        task: {
          sourceId: 'local:task-1',
          connectorType: 'local',
          connectorInstanceId: 'local',
        },
        attachment: {
          name: 'proof.txt',
          contentType: 'text/plain',
          contentBase64: 'cHJvb2Y=',
          sourceAttachmentId: null,
        },
      }),
      getDocumentPreviewContext: () => record('getDocumentPreviewContext', {
        task: {
          connectorType: 'local',
          connectorInstanceId: 'local',
          metadata: {},
        },
        connector: null,
      }),
      listLinkedSources: () => record('listLinkedSources', []),
      searchRelationshipCandidates: () => record('searchRelationshipCandidates', []),
      listDuplicateDetectionTasks: () => record('listDuplicateDetectionTasks', []),
      listDistinctTaskAssignees: () => record('listDistinctTaskAssignees', []),
      getGroupCounts: () => record('getGroupCounts', { 'To Do': 1 }),
      listQuickSortSources: () => record('listQuickSortSources', {
        rows: [],
        definitions: [],
      }),
      getQuickSortCounts: () => record('getQuickSortCounts', {
        no_priority: 0,
        quadrant: 0,
        no_effort: 0,
        no_tags: 0,
        no_planning_horizon: 0,
      }),
      listQuickSortTasks: () => record('listQuickSortTasks', []),
      getQuickSortSuggestionInputs: () => record('getQuickSortSuggestionInputs', {
        tasks: [],
        sourceRankings: [],
        tags: [],
        taskTags: [],
      }),
    },
    filterInputs: {
      listMyDayTaskIds: () => record('listMyDayTaskIds', ['task-1']),
      listAssignedGitHubUsernames: () => record('listAssignedGitHubUsernames', ['octocat']),
      listInboxListEntries: () => record('listInboxListEntries', [
        { connectorType: 'microsoft-todo', sourceListName: 'Tasks' },
      ]),
    },
    queries: {
      countTasks: () => record('countTasks', 0),
      listTaskIds: () => record('listTaskIds', []),
      getStats: () => record('getStats', {
        totalOpen: 0,
        overdue: 0,
        dueToday: 0,
        dueThisWeek: 0,
        noDate: 0,
        highPriority: 0,
        assignedToMe: 0,
        myDay: 0,
        recentlyCreated: 0,
        recentlyClosed: 0,
        waiting: 0,
        inbox: 0,
      }),
      getSourceCounts: () => record('getSourceCounts', {}),
      getAvailableTags: () => record('getAvailableTags', []),
    },
    policyIdentities: {
      listTaskSourceIdentities: () => record('listTaskSourceIdentities', [{
        id: 'task-1',
        sourceId: 'local:task-1',
        connectorType: 'local',
        connectorInstanceId: 'local',
      }]),
      getTaskSourceIdentity: () => record('getTaskSourceIdentity', {
        id: 'task-1',
        sourceId: 'local:task-1',
        connectorType: 'local',
        connectorInstanceId: 'local',
      }),
      getDependencyEndpoints: () => record('getDependencyEndpoints', null),
    },
    lifecycle: {
      deleteTaskLocally: () => record('deleteTaskLocally', undefined),
      convertTaskTreeToLocal: () => record('convertTaskTreeToLocal', undefined),
      findTaskByRetentionIdentity: () => record('findTaskByRetentionIdentity', null),
    },
    scoutDeletion: {
      hardDeleteScoutTask: () => record('hardDeleteScoutTask', { kind: 'not-found' as const }),
    },
    moves: {
      getMoveSource: () => record('getMoveSource', null),
      listTaskAttachments: () => record('listTaskAttachments', []),
      findTargetList: () => record('findTargetList', null),
      executePendingSyncMove: () => record('executePendingSyncMove', { kind: 'not-found' as const }),
      taskExists: () => record('taskExists', false),
    },
    writeThroughMoves: {
      getTask: () => record('getTask', null),
      listChildTasks: () => record('listChildTasks', []),
      listTaskTagRefs: () => record('listTaskTagRefs', []),
      listAttachmentMetadata: () => record('listAttachmentMetadata', []),
      listAttachmentContents: () => record('listAttachmentContents', []),
      getTaskSchedule: () => record('getTaskSchedule', null),
      findTargetListBySourceId: () => record('findTargetListBySourceId', null),
      claimTaskMove: () => record('claimTaskMove', false),
      releaseTaskMoveClaim: () => record('releaseTaskMoveClaim', undefined),
      discardMaterializedDestination: () => record('discardMaterializedDestination', undefined),
      materializeDestination: () => record('materializeDestination', undefined),
      finalizeMove: () => record('finalizeMove', { kind: 'source-changed' as const }),
      recordSourceSyncIntent: () => record('recordSourceSyncIntent', undefined),
      recordSourceCopyProvenance: () => record('recordSourceCopyProvenance', undefined),
    },
    priorityEntities: {
      listPriorityEntitiesByRank: () => record('listPriorityEntitiesByRank', [{
        id: 'pe-1',
        name: 'Person',
        type: 'person',
        referenceId: null,
        description: null,
        tier: 'standard',
        color: '#64748b',
        rank: 1,
        activeTaskCount: 0,
        lastTouchedAt: null,
        createdAt: '2026-08-05T12:00:00.000Z',
        updatedAt: '2026-08-05T12:00:00.000Z',
      }]),
      getProjectReference: () => record('getProjectReference', null),
      getTagReference: () => record('getTagReference', null),
      getSourceListReference: () => record('getSourceListReference', null),
      listProjectReferences: () => record('listProjectReferences', []),
      listTagReferences: () => record('listTagReferences', []),
      listSourceListReferences: () => record('listSourceListReferences', []),
    },
    sourceListNames: {
      listSourceListDisplayNames: () => record('listSourceListDisplayNames', [{
        connectorInstanceId: 'conn-1',
        sourceId: 'list-1',
        name: 'Raw',
        userDisplayName: 'Pretty',
      }]),
    },
    transferIdentity: {
      resolveIdentityTargets: () => record('resolveIdentityTargets', {
        taskExists: false,
        taskMetadata: {},
        sourceLists: [],
      }),
      reconcileTaskRefresh: () => record('reconcileTaskRefresh', false),
    },
    quickSort: {
      captureTask: () => record('captureQuickSortTask', null),
      getOperation: () => record('getQuickSortOperation', null),
      reserveOperation: () => {
        throw new Error('reserveQuickSortOperation is not used by this proof');
      },
      discardApplyingOperation: () => record('discardQuickSortOperation', false),
      finalizeOperation: () => record('finalizeQuickSortOperation', null),
      claimUndo: () => record('claimQuickSortUndo', false),
      releaseUndo: () => record('releaseQuickSortUndo', false),
      finalizeUndo: () => record('finalizeQuickSortUndo', false),
      countActivityByModeSince: () => record('countQuickSortActivity', []),
      listActivityTimestampsSince: () => record('listQuickSortActivity', []),
      recordActivity: () => record('recordQuickSortActivity', undefined),
    },
  };
}

beforeAll(async () => {
  process.env.MC_DATABASE_BACKEND = 'postgres';
  vi.doUnmock('drizzle-orm');
  vi.resetModules();

  runtime = await import('@/lib/tasks/core/runtime');
  runtime.registerTaskCorePersistence(fakePersistence());
  ({ createPostgresTaskCorePersistence } = await import(
    '@/db/postgres/repositories/task-core-repositories'
  ));

  // The move resolves connector configuration through the L01 core
  // repositories, which are backend-selected the same way.
  corePersistenceRuntime = await import('@/lib/persistence/runtime');
  corePersistenceRuntime.registerCorePersistenceRepositories({
    connectors: {
      get: async () => {
        calls.push('connectors.get');
        return null;
      },
    },
  } as unknown as Parameters<
    typeof corePersistenceRuntime.registerCorePersistenceRepositories
  >[0]);

  modules = {
    scoutHardDelete: await import('@/lib/tasks/scout-hard-delete'),
    lifecycle: await import('@/lib/tasks/local-task-lifecycle'),
    listNames: await import('@/lib/utils/resolve-task-list-names'),
    priorityEntities: await import('@/lib/priority-entities'),
    editPolicy: await import('@/lib/tasks/edit-policy'),
    mutationPolicy: await import('@/lib/tasks/mutation-policy'),
    canonicalFilter: await import('@/app/api/tasks/canonical-filter'),
    queryBuilder: await import('@/app/api/tasks/query-builder'),
    filterFactory: await import('@/app/api/tasks/filter-factory'),
    filterQuery: await import('@/app/api/tasks/filter-query'),
    statsComputer: await import('@/app/api/tasks/stats-computer'),
    pendingSyncMove: await import('@/lib/tasks/task-move-pending-sync'),
    writeThroughMove: await import('@/lib/tasks/task-move-write-through'),
    attachmentContent: await import('@/app/api/tasks/[id]/attachments/[attachmentId]/route'),
    documentPreview: await import('@/app/api/tasks/[id]/document-preview/route'),
    linkedSources: await import('@/app/api/tasks/[id]/linked-sources/route'),
    relationshipCandidates: await import('@/app/api/tasks/[id]/relationship-candidates/route'),
    duplicateDetection: await import('@/app/api/tasks/detect-duplicates/route'),
    filterOptions: await import('@/app/api/tasks/filter-options/route'),
    groupCounts: await import('@/app/api/tasks/group-counts/route'),
    quickSort: await import('@/app/api/tasks/quick-sort/route'),
    quickSortSuggestions: await import('@/app/api/tasks/quick-sort/suggestions/route'),
    quickSortStats: await import('@/app/api/tasks/quick-sort-stats/route'),
    quickSortOperations: await import('@/app/api/tasks/quick-sort/operations/route'),
    quickSortUndo: await import('@/app/api/tasks/quick-sort/operations/[id]/undo/route'),
  };
});

afterAll(() => {
  runtime?.clearTaskCorePersistence();
  if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = originalBackend;
});

describe('task-core under PostgreSQL with a poisoned SQLite module', () => {
  it('proves the poison actually fires when @/db is imported', async () => {
    await expect(import('@/db')).rejects.toThrow();
    expect(poisonState.triggered).toBe(true);
  });

  it('hard-deletes a Scout task through the registered composition', async () => {
    await expect(modules.scoutHardDelete.hardDeleteScoutTask('task-1'))
      .resolves.toEqual({ kind: 'not-found' });
    expect(calls).toContain('hardDeleteScoutTask');
  });

  it('runs local lifecycle operations', async () => {
    await modules.lifecycle.deleteTaskLocally('task-1');
    await modules.lifecycle.deleteTaskTreeLocally('task-1');
    await modules.lifecycle.convertTaskTreeToLocal('task-1', 'keep_local');
    await modules.lifecycle.getTaskByRetentionIdentity({
      connectorId: 'conn-1',
      taskSourceId: 'local:task-1',
    });
    expect(calls).toContain('deleteTaskLocally');
    expect(calls).toContain('convertTaskTreeToLocal');
    expect(calls).toContain('findTaskByRetentionIdentity');
  });

  it('resolves source-list display names', async () => {
    const map = await modules.listNames.buildSourceListNameMap([
      { sourceListId: 'list-1', connectorInstanceId: 'conn-1' },
    ]);
    expect(map.get('conn-1:list-1')).toBe('Pretty');
  });

  it('resolves priority entities', async () => {
    const entities = await modules.priorityEntities.getResolvedPriorityEntities();
    expect(entities.map((entity) => entity.id)).toEqual(['pe-1']);
  });

  it('resolves edit and mutation policies for a local task', async () => {
    const policies = await modules.editPolicy.resolveTaskEditPoliciesByIds(['task-1']);
    expect(policies.has('task-1')).toBe(true);

    const mutation = await modules.mutationPolicy.getStoredTaskMutationPolicy('task-1', 'title');
    expect(mutation?.task.id).toBe('task-1');
  });

  it('compiles the canonical filter without touching SQLite', async () => {
    const canonical = await modules.canonicalFilter.buildCanonicalTaskFilterConditions(
      new URLSearchParams('quickFilter=myDay&statuses=todo&tagSlugs=a,b&filterQuery=priority:high'),
    );
    expect(canonical.conditions.length).toBeGreaterThan(0);
    expect(canonical.myDayTaskIds).toEqual(['task-1']);
    expect(canonical.quickFilterCondition).toBeDefined();
    expect(canonical.spec.statuses).toEqual(['todo']);

    const where = await modules.canonicalFilter.getCanonicalTaskFilterWhere(
      new URLSearchParams(''),
    );
    expect(where.baseWhere).toBeDefined();
    expect(modules.canonicalFilter.getTaskSourceVisibilityConditions()).toHaveLength(2);
  });

  it('builds identity-aware quick filters from the registered composition', async () => {
    expect(await modules.queryBuilder.getAssignedFilterCondition()).toBeDefined();
    expect(await modules.queryBuilder.getInboxFilterCondition()).toBeDefined();
    expect(calls).toContain('listAssignedGitHubUsernames');
    expect(calls).toContain('listInboxListEntries');
  });

  it('builds relation and filter-query predicates with no database handle at all', async () => {
    expect(modules.filterFactory.getTagSlugFilterCondition('x')).toBeDefined();
    expect(modules.filterFactory.getMultiTagFilterCondition(['x', 'y'])).toBeDefined();
    expect(modules.filterFactory.getTagIdsFilterCondition(['x'])).toBeDefined();
    expect(modules.filterFactory.getProjectFilterCondition('p')).toBeDefined();
    expect(modules.filterFactory.createEmptyResponse().total).toBe(0);
    expect(await modules.filterQuery.getFilterQueryConditions('priority:high', 'a', 'b'))
      .toHaveLength(1);
    expect(modules.filterQuery.getSourceListIdsCondition(['a:b'])).toBeDefined();
    expect(modules.filterQuery.getSourceListGroupCondition('g')).toBeDefined();
  });

  it('computes every task statistic through the registered composition', async () => {
    const spec = modules.canonicalFilter.buildCanonicalTaskFilterSpec(new URLSearchParams(''));
    expect(await modules.statsComputer.countTasksForSpec(spec)).toBe(0);
    expect(await modules.statsComputer.getStatsForSpec(spec)).toMatchObject({ totalOpen: 0 });
    expect(await modules.statsComputer.getSourceCountsForSpec(spec)).toEqual({});
    expect(await modules.statsComputer.getAvailableTagsForSpec(spec)).toEqual([]);
    expect(calls).toContain('countTasks');
    expect(calls).toContain('getStats');
    expect(calls).toContain('getSourceCounts');
    expect(calls).toContain('getAvailableTags');
  });

  it('executes task-read and quick-sort routes through the genuine PostgreSQL adapter', async () => {
    const database = createPostgresReadDatabaseDouble();
    runtime.registerTaskCorePersistence(createPostgresTaskCorePersistence(database as never));
    try {
      const routeContext = { params: Promise.resolve({ id: 'task-1' }) };
      const attachmentResponse = await modules.attachmentContent.GET(
        new Request('http://localhost/api/tasks/task-1/attachments/attachment-1'),
        { params: Promise.resolve({ id: 'task-1', attachmentId: 'attachment-1' }) },
      );
      expect(await attachmentResponse.text()).toBe('proof');
      expect((await modules.documentPreview.GET(
        new Request('http://localhost/api/tasks/task-1/document-preview'),
        routeContext,
      )).status).toBe(400);
      expect((await modules.linkedSources.GET(
        new Request('http://localhost/api/tasks/task-1/linked-sources'),
        routeContext,
      )).status).toBe(200);
      expect((await modules.relationshipCandidates.GET(
        new Request('http://localhost/api/tasks/task-1/relationship-candidates'),
        routeContext,
      )).status).toBe(200);
      expect((await modules.duplicateDetection.GET(
        new Request('http://localhost/api/tasks/detect-duplicates'),
      )).status).toBe(200);
      expect((await modules.filterOptions.GET()).status).toBe(200);
      expect((await modules.groupCounts.GET(
        new Request('http://localhost/api/tasks/group-counts?groupBy=status'),
      )).status).toBe(200);
      expect((await modules.quickSort.GET(
        new Request('http://localhost/api/tasks/quick-sort?counts=true'),
      )).status).toBe(200);
      expect((await modules.quickSortSuggestions.GET(
        new Request('http://localhost/api/tasks/quick-sort/suggestions?taskIds=task-1'),
      )).status).toBe(200);
      expect((await modules.quickSortStats.GET()).status).toBe(200);
      expect((await modules.quickSortOperations.POST(new Request(
        'http://localhost/api/tasks/quick-sort/operations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: 'operation-1',
            taskId: 'missing',
            mode: 'no_priority',
            action: 'skipped',
            label: 'Skip',
            contextKey: 'queue:no-priority',
            queueIndex: 0,
            patch: {},
          }),
        },
      ))).status).toBe(404);
      expect((await modules.quickSortUndo.POST(
        new Request('http://localhost/api/tasks/quick-sort/operations/missing/undo', {
          method: 'POST',
        }),
        { params: Promise.resolve({ id: 'missing' }) },
      )).status).toBe(404);
      expect(database.select).toHaveBeenCalled();
    } finally {
      runtime.registerTaskCorePersistence(fakePersistence());
    }
  });

  it('executes the quick-sort workflow routes through the registered composition', async () => {
    const stats = await modules.quickSortStats.GET();
    expect(stats.status).toBe(200);
    expect(calls).toContain('countQuickSortActivity');
    expect(calls).toContain('listQuickSortActivity');

    const logged = await modules.quickSortStats.POST(new Request(
      'http://localhost/api/tasks/quick-sort-stats',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'task-1', mode: 'no_priority', action: 'applied' }),
      },
    ));
    expect(logged.status).toBe(200);
    expect(calls).toContain('recordQuickSortActivity');

    const applied = await modules.quickSortOperations.POST(new Request(
      'http://localhost/api/tasks/quick-sort/operations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: 'operation-1',
          taskId: 'missing',
          mode: 'no_priority',
          action: 'skipped',
          label: 'Skip',
          contextKey: 'queue:no-priority',
          queueIndex: 0,
          patch: {},
        }),
      },
    ));
    expect(applied.status).toBe(404);
    expect(calls).toContain('captureQuickSortTask');

    const undone = await modules.quickSortUndo.POST(
      new Request('http://localhost/api/tasks/quick-sort/operations/missing/undo', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    );
    expect(undone.status).toBe(404);
    expect(calls).toContain('getQuickSortOperation');
  });

  it('runs both task-move strategies without a SQLite handle', async () => {
    await expect(modules.pendingSyncMove.executePendingSyncTaskMove('task-1', {
      targetConnectorInstanceId: 'conn-1',
    })).resolves.toMatchObject({ status: 404 });
    expect(calls).toContain('connectors.get');

    await expect(modules.writeThroughMove.executeWriteThroughTaskMove({
      taskId: 'task-1',
      targetConnectorInstanceId: 'conn-1',
      targetSourceListId: 'list-1',
      sourceAction: 'move',
    })).resolves.toMatchObject({
      status: 404,
      body: { error: 'Task not found' },
    });
    expect(calls).toContain('getTask');
  });
});
