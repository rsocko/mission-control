import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TaskCorePersistence } from '@/lib/tasks/core/contracts';

/**
 * Poisoned-SQLite proof for the L04 task-core surface.
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
};

const calls: string[] = [];

function fakePersistence(): TaskCorePersistence {
  const record = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };

  return {
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
  };
}

beforeAll(async () => {
  process.env.MC_DATABASE_BACKEND = 'postgres';
  vi.doUnmock('drizzle-orm');
  vi.resetModules();

  runtime = await import('@/lib/tasks/core/runtime');
  runtime.registerTaskCorePersistence(fakePersistence());

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
