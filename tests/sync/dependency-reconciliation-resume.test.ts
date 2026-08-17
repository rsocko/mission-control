import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IConnector } from '@/lib/connectors';
import type { SourceTaskDependency } from '@/types';
import {
  bindGitHubTaskIdentities,
  githubIssueEvidence,
} from '../fixtures/github-node-identity';

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type ManagerModule = typeof import('@/lib/sync/task-dependency-manager');

const dbPath = join(tmpdir(), `mc-dependency-reconciliation-${process.pid}.db`);
let dbModule: DbModule;
let schema: SchemaModule;
let manager: ManagerModule;

function sourceId(connectorId: string, number: number): string {
  return `acme/${connectorId}:${number.toString().padStart(2, '0')}`;
}

async function setupConnector(connectorId: string, taskCount: number) {
  const now = '2026-08-03T00:00:00.000Z';
  await dbModule.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: connectorId,
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: true,
      dependencyRead: true,
      dependencyWrite: true,
    },
    credentials: {},
    settings: {},
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  });
  await dbModule.default.insert(schema.tasks).values(
    Array.from({ length: taskCount }, (_, index) => ({
      id: `${connectorId}-task-${index + 1}`,
      sourceId: sourceId(connectorId, index + 1),
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: `${connectorId} task ${index + 1}`,
      isChecklistItem: false,
      metadata: { issueNumber: index + 1 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    })),
  );
  bindGitHubTaskIdentities(
    dbModule.sqlite,
    connectorId,
    Array.from({ length: taskCount }, (_, index) => ({
      taskId: `${connectorId}-task-${index + 1}`,
      owner: 'acme',
      repository: connectorId,
      issueNumber: index + 1,
      issueStableId: `I_${connectorId}_${index + 1}`,
      repositoryStableId: `R_${connectorId}`,
    })),
    now,
  );
}

function evidenceForSourceId(connectorId: string, source: string) {
  const issueNumber = Number(source.slice(source.lastIndexOf(':') + 1));
  return githubIssueEvidence({
    issueStableId: `I_${connectorId}_${issueNumber}`,
    repositoryStableId: `R_${connectorId}`,
    owner: 'acme',
    repository: connectorId,
    issueNumber,
  });
}

function createConnector(
  connectorId: string,
  state: { edges: SourceTaskDependency[]; fail?: boolean },
): IConnector {
  return {
    id: connectorId,
    type: 'github-issues',
    displayName: connectorId,
    icon: 'github',
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: true,
      dependencyRead: true,
      dependencyWrite: true,
    },
    initialize: async () => undefined,
    testConnection: async () => ({ success: true, message: 'ok' }),
    dispose: async () => undefined,
    fetchTasks: async function* () { yield []; },
    fetchNotifications: async () => [],
    fetchSourceLists: async () => [],
    getLastSyncToken: async () => null,
    fetchTaskDependencies: async (sourceIds) => {
      if (state.fail) throw new Error('interrupted');
      return {
        dependencies: state.edges.filter((edge) =>
          sourceIds.includes(edge.blockedSourceId)).map((edge) => ({
            ...edge,
            blockerIdentityEvidence: evidenceForSourceId(connectorId, edge.blockerSourceId),
            blockerIdentityEvidenceState: 'verified' as const,
          })),
        completeBlockedSourceIds: [...sourceIds],
        blockedIdentityEvidence: sourceIds.map((blockedSourceId) => ({
          sourceId: blockedSourceId,
          evidence: evidenceForSourceId(connectorId, blockedSourceId),
          state: 'verified' as const,
        })),
      };
    },
    preflightWriteRoute: async (route: { targets: ReadonlyArray<{ role: string; issueNumber: number | null }> }) => ({
      targets: Object.fromEntries(route.targets.map((target) => [
        target.role,
        target.issueNumber === null
          ? { repositoryStableId: `R_${connectorId}` }
          : {
              repositoryStableId: `R_${connectorId}`,
              issueStableId: `I_${connectorId}_${target.issueNumber}`,
            },
      ])),
    }),
    runAuthorizedWrite: async <T>(_route: unknown, write: () => Promise<T>) => write(),
    addTaskDependency: async (blockerSourceId, blockedSourceId) => {
      if (!state.edges.some((edge) =>
        edge.blockerSourceId === blockerSourceId
        && edge.blockedSourceId === blockedSourceId)) {
        state.edges.push({ blockerSourceId, blockedSourceId });
      }
    },
    removeTaskDependency: async (blockerSourceId, blockedSourceId) => {
      state.edges = state.edges.filter((edge) =>
        edge.blockerSourceId !== blockerSourceId
        || edge.blockedSourceId !== blockedSourceId);
    },
  };
}

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath);
  process.env.MC_DB_PATH = dbPath;
  process.env.MC_DEPENDENCY_RECONCILIATION_BATCH_SIZE = '2';
  process.env.MC_DEPENDENCY_RECONCILIATION_RETRY_BASE_MS = '10';
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
  [dbModule, schema, manager] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/sync/task-dependency-manager'),
  ]);
});

afterAll(() => {
  dbModule.sqlite.close();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_DEPENDENCY_RECONCILIATION_BATCH_SIZE;
  delete process.env.MC_DEPENDENCY_RECONCILIATION_RETRY_BASE_MS;
  if (existsSync(dbPath)) rmSync(dbPath);
});

describe('checkpointed dependency reconciliation', () => {
  it('persists interruption progress and deletes only after the resumed generation completes', async () => {
    const connectorId = 'github-resume';
    await setupConnector(connectorId, 5);
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-stale`,
      taskId: `${connectorId}-task-2`,
      dependsOnTaskId: `${connectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const state = {
      edges: [{
        blockerSourceId: sourceId(connectorId, 3),
        blockedSourceId: sourceId(connectorId, 4),
      }],
      fail: false,
    };
    const connector = createConnector(connectorId, state);

    const first = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(first.snapshot).toMatchObject({ status: 'running', processed: 2, total: 5 });
    expect(await dbModule.default.select().from(schema.taskDependencies)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `${connectorId}-stale` })]),
    );

    const second = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(second.snapshot).toMatchObject({
      generationId: first.snapshot?.generationId,
      status: 'running',
      processed: 4,
    });
    // Edges are only applied once the whole generation resolves through NodeID
    // bindings, so a mid-generation batch imports nothing.
    expect(second.imported).toBe(0);

    state.fail = true;
    await expect(manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    )).rejects.toThrow('interrupted');
    const [failed] = await dbModule.default.select()
      .from(schema.dependencyReconciliationSnapshots)
      .where((await import('drizzle-orm')).eq(
        schema.dependencyReconciliationSnapshots.id,
        first.snapshot!.generationId,
      ));
    expect(failed).toMatchObject({
      status: 'failed',
      cursor: 4,
      failureReason: 'interrupted',
    });
    expect(failed.nextAttemptAt).not.toBeNull();
    expect(await dbModule.default.select().from(schema.taskDependencies)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `${connectorId}-stale` })]),
    );

    const { eq } = await import('drizzle-orm');
    await dbModule.default.update(schema.dependencyReconciliationSnapshots).set({
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
    }).where(eq(schema.dependencyReconciliationSnapshots.id, failed.id));
    state.fail = false;
    const resumed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );

    expect(resumed.snapshot).toMatchObject({
      generationId: first.snapshot?.generationId,
      status: 'completed',
      processed: 5,
    });
    expect(resumed.removed).toBe(1);
    expect(await dbModule.default.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.id, `${connectorId}-stale`))).toHaveLength(0);
    await manager.recordDependencyReconciliationResumeOutcome(
      resumed.snapshot!.generationId,
      'advanced',
      'snapshot-completed',
      '2026-08-03T00:15:00.000Z',
    );
    expect((await manager.getDependencyReconciliationHealth()).get(connectorId))
      .toMatchObject({
        generationId: first.snapshot?.generationId,
        status: 'completed',
        processed: 5,
        total: 5,
        lastCompletedAt: resumed.snapshot?.completedAt,
        failureReason: null,
        lastResumeAttemptAt: '2026-08-03T00:15:00.000Z',
        lastResumeOutcome: 'advanced',
        lastResumeReason: 'snapshot-completed',
      });
  });

  it('replays generations idempotently without duplicating imported edges', async () => {
    const connectorId = 'github-idempotent';
    await setupConnector(connectorId, 3);
    const state = {
      edges: [{
        blockerSourceId: sourceId(connectorId, 1),
        blockedSourceId: sourceId(connectorId, 3),
      }],
    };
    const connector = createConnector(connectorId, state);
    const { eq } = await import('drizzle-orm');

    await manager.reconcileTaskDependencies(connectorId, connector, { full: true });
    await manager.reconcileTaskDependencies(connectorId, connector, { full: true });
    await manager.reconcileTaskDependencies(connectorId, connector, { full: true });
    await manager.reconcileTaskDependencies(connectorId, connector, { full: true });

    const imported = await dbModule.default.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.connectorInstanceId, connectorId));
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      taskId: `${connectorId}-task-3`,
      dependsOnTaskId: `${connectorId}-task-1`,
      syncStatus: 'synced',
    });
  });

  it('does not create a replacement generation for a stale resume candidate', async () => {
    const connectorId = 'github-stale-candidate';
    await setupConnector(connectorId, 1);
    const connector = createConnector(connectorId, { edges: [] });
    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(completed.snapshot?.status).toBe('completed');

    const staleResume = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      {
        full: true,
        resumeGenerationId: completed.snapshot!.generationId,
      },
    );
    const { eq } = await import('drizzle-orm');
    const snapshots = await dbModule.default.select()
      .from(schema.dependencyReconciliationSnapshots)
      .where(eq(
        schema.dependencyReconciliationSnapshots.connectorInstanceId,
        connectorId,
      ));

    expect(staleResume).toMatchObject({
      resumeSkippedReason: 'snapshot-no-longer-active',
    });
    expect(snapshots).toHaveLength(1);
  });

  it('treats any unverified source as partial and skips every removal', async () => {
    const connectorId = 'github-partial';
    await setupConnector(connectorId, 3);
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-stale`,
      taskId: `${connectorId}-task-2`,
      dependsOnTaskId: `${connectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const connector = createConnector(connectorId, { edges: [] });
    connector.fetchTaskDependencies = async (sourceIds) => ({
      dependencies: [],
      completeBlockedSourceIds: sourceIds.filter(
        (id) => id !== sourceId(connectorId, 1),
      ),
    });
    const { eq } = await import('drizzle-orm');

    await manager.reconcileTaskDependencies(connectorId, connector, { full: true });
    const partial = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );

    expect(partial.snapshot).toMatchObject({
      status: 'partial',
      processed: 3,
      total: 3,
      removed: 0,
    });
    expect(partial.snapshot?.failureReason).toContain('removals skipped');
    expect(await dbModule.default.select().from(schema.taskDependencies)
      .where(eq(
        schema.taskDependencies.id,
        `${connectorId}-stale`,
      ))).toHaveLength(1);
  });

  it('preserves and promptly retries a local write made after its source batch was scanned', async () => {
    const connectorId = 'github-concurrent-write';
    await setupConnector(connectorId, 3);
    const state: { edges: SourceTaskDependency[] } = { edges: [] };
    const connector = createConnector(connectorId, state);
    const { eq } = await import('drizzle-orm');

    const first = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-local-write`,
      taskId: `${connectorId}-task-2`,
      dependsOnTaskId: `${connectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'failed',
      syncAction: 'create',
      syncError: 'temporary failure',
      createdAt: first.snapshot!.startedAt,
    });

    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );

    expect(completed.pushed).toBe(1);
    expect(completed.snapshot?.status).toBe('completed');
    expect(state.edges).toContainEqual({
      blockerSourceId: sourceId(connectorId, 1),
      blockedSourceId: sourceId(connectorId, 2),
    });
    expect(await dbModule.default.select().from(schema.taskDependencies)
      .where(eq(
        schema.taskDependencies.id,
        `${connectorId}-local-write`,
      ))).toEqual([
      expect.objectContaining({ syncStatus: 'synced', syncAction: null }),
    ]);
  });

  it('resumes the same generation after closing and reopening the database', async () => {
    const connectorId = 'github-restart';
    await setupConnector(connectorId, 3);
    const state = {
      edges: [{
        blockerSourceId: sourceId(connectorId, 1),
        blockedSourceId: sourceId(connectorId, 3),
      }],
    };
    const connector = createConnector(connectorId, state);
    const first = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(first.snapshot?.processed).toBe(2);

    dbModule.sqlite.close();
    vi.resetModules();
    [dbModule, schema, manager] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/sync/task-dependency-manager'),
    ]);

    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(completed.snapshot).toMatchObject({
      generationId: first.snapshot?.generationId,
      status: 'completed',
      processed: 3,
    });
    expect(completed.imported).toBe(1);
  });

  it('retains a bounded terminal generation history and prunes child rows', async () => {
    const connectorId = 'github-retention';
    await setupConnector(connectorId, 1);
    const connector = createConnector(connectorId, { edges: [] });
    const { eq } = await import('drizzle-orm');

    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(completed.snapshot?.status).toBe('completed');
    connector.fetchTaskDependencies = async () => ({
      dependencies: [],
      completeBlockedSourceIds: [],
    });
    const partialGenerationIds: string[] = [];
    for (let generation = 0; generation < 11; generation++) {
      const result = await manager.reconcileTaskDependencies(
        connectorId,
        connector,
        { full: true },
      );
      expect(result.snapshot?.status).toBe('partial');
      partialGenerationIds.push(result.snapshot!.generationId);
    }

    const snapshots = await dbModule.default.select()
      .from(schema.dependencyReconciliationSnapshots)
      .where(eq(
        schema.dependencyReconciliationSnapshots.connectorInstanceId,
        connectorId,
      ));
    const retainedItems = await dbModule.default.select({
      snapshotId: schema.dependencyReconciliationItems.snapshotId,
    }).from(schema.dependencyReconciliationItems)
      .innerJoin(
        schema.dependencyReconciliationSnapshots,
        eq(
          schema.dependencyReconciliationItems.snapshotId,
          schema.dependencyReconciliationSnapshots.id,
        ),
      )
      .where(eq(
        schema.dependencyReconciliationSnapshots.connectorInstanceId,
        connectorId,
      ));

    expect(snapshots).toHaveLength(10);
    expect(snapshots.map(({ id }) => id)).toEqual(expect.arrayContaining([
      completed.snapshot!.generationId,
      partialGenerationIds.at(-1),
    ]));
    expect(retainedItems).toHaveLength(10);
    expect((await manager.getDependencyReconciliationHealth()).get(connectorId))
      .toMatchObject({
        generationId: partialGenerationIds.at(-1),
        status: 'partial',
        lastCompletedAt: completed.snapshot!.completedAt,
      });
  });
});
