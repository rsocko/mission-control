import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IConnector } from '@/lib/connectors';
import type { ExternalIdentityEvidence } from '@/lib/external-identities';
import type { TaskItem } from '@/types';

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type ManagerModule = typeof import('@/lib/sync/task-dependency-manager');
type HierarchyModule = typeof import('@/lib/sync/github-hierarchy-reconciliation');
type PullManagerModule = typeof import('@/lib/sync/pull-manager');

const dbPath = join(tmpdir(), `mc-dependency-stream-${process.pid}.db`);
let dbModule: DbModule;
let schema: SchemaModule;
let manager: ManagerModule;
let hierarchy: HierarchyModule;
let pullManager: PullManagerModule;
let identity: typeof import('@/lib/external-identities');

async function setupConnector(connectorId: string, includeTasks = true) {
  const now = '2026-08-09T00:00:00.000Z';
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
  if (!includeTasks) return;
  await dbModule.default.insert(schema.tasks).values([
    {
      id: `${connectorId}-task-1`,
      sourceId: 'acme/app:1',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Issue 1',
      isChecklistItem: false,
      metadata: { issueNumber: 1 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: `${connectorId}-task-2`,
      sourceId: 'acme/app:2',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Issue 2',
      isChecklistItem: false,
      metadata: { issueNumber: 2 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: `${connectorId}-task-3`,
      sourceId: 'acme/app:3',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Issue 3',
      isChecklistItem: false,
      metadata: { issueNumber: 3 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: `${connectorId}-draft`,
      sourceId: 'project:1:draft:PVTI_1',
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Draft',
      isChecklistItem: false,
      metadata: { isDraft: true, isProjectDraft: true },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  ]);
}

function streamedConnector(connectorId: string, dependencyFetch = vi.fn()): IConnector {
  return {
    id: connectorId,
    type: 'github-issues',
    displayName: connectorId,
    icon: 'github',
    dependencySnapshotStrategy: 'task-stream',
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
    fetchTaskDependencies: dependencyFetch,
  };
}

function issueEvidence(stableId: string, sourceId: string): ExternalIdentityEvidence {
  const [repository, rawNumber] = sourceId.split(':');
  const [owner, name] = repository.split('/');
  const issueNumber = Number(rawNumber);
  const observedAt = '2026-08-10T00:00:00.000Z';
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'repository',
        stableId: `R_${repository}`,
      },
      locator: { owner, repository: name },
      observationSource: 'graphql',
      observedAt,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'issue',
        stableId,
      },
      locator: { owner, repository: name, issueNumber },
      observationSource: 'graphql',
      observedAt,
    },
  };
}

function issueTask(
  connectorId: string,
  sourceId: string,
  stableId: string,
): TaskItem {
  return {
    id: `remote-${sourceId}`,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: `Issue ${sourceId}`,
    status: 'todo',
    priority: 'none',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    hubProjectIds: [],
    tags: [],
    metadata: { issueNumber: Number(sourceId.slice(sourceId.lastIndexOf(':') + 1)) },
    externalIdentity: issueEvidence(stableId, sourceId),
    syncStatus: 'synced',
    lastSyncedAt: '2026-08-10T00:00:00.000Z',
  };
}

async function enableComparison(connectorId: string, revision = 3) {
  const now = '2026-08-10T00:00:00.000Z';
  await dbModule.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: 'comparing',
    updatedAt: now,
  });
  await dbModule.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
    stablePrimaryEnabled: false,
    modeRevision: revision,
    updatedAt: now,
  });
}

function bindTask(
  connectorId: string,
  taskId: string,
  sourceId: string,
  stableId: string,
  evidenceSourceId = sourceId,
) {
  identity.persistExternalIdentityBatch([{
    target: {
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: taskId,
      legacyIdentity: sourceId,
    },
    evidence: issueEvidence(stableId, evidenceSourceId),
  }], 'comparing');
}

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath);
  process.env.MC_DB_PATH = dbPath;
  process.env.MC_DEPENDENCY_STREAM_BATCH_SIZE = '2';
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
  [dbModule, schema, manager, hierarchy, pullManager, identity] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/sync/task-dependency-manager'),
    import('@/lib/sync/github-hierarchy-reconciliation'),
    import('@/lib/sync/pull-manager'),
    import('@/lib/external-identities'),
  ]);
}, 30_000);

afterAll(() => {
  dbModule?.sqlite.close();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_DEPENDENCY_STREAM_BATCH_SIZE;
  if (existsSync(dbPath)) rmSync(dbPath);
});

describe('streamed dependency generations', () => {
  it('reconciles a completed generation locally without dependency network calls', async () => {
    const connectorId = 'github-streamed';
    await setupConnector(connectorId);
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
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    expect(writer).toBeDefined();
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:2'],
    }, 'graphql-bulk');
    await writer!.stagePage({
      dependencies: [{
        blockerSourceId: 'acme/app:2',
        blockedSourceId: 'acme/app:3',
      }],
      completeBlockedSourceIds: ['acme/app:3'],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const dependencyFetch = vi.fn(async () => {
      throw new Error('per-task network read must not run');
    });
    const connector = streamedConnector(connectorId, dependencyFetch);
    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    expect(completed.snapshot).toMatchObject({
      status: 'completed',
      phase: 'completed',
      readMode: 'graphql-bulk',
      processed: 3,
      total: 3,
    });

    expect(dependencyFetch).not.toHaveBeenCalled();
    expect(completed.snapshot).toMatchObject({
      status: 'completed',
      phase: 'completed',
      readMode: 'graphql-bulk',
    });
    const dependencies = await dbModule.default.select().from(schema.taskDependencies);
    expect(dependencies).toEqual([
      expect.objectContaining({
        taskId: `${connectorId}-task-3`,
        dependsOnTaskId: `${connectorId}-task-2`,
      }),
    ]);
    expect(completed.snapshot?.imported).toBe(1);
    expect(completed).toMatchObject({ imported: 1, removed: 1 });

    const streamedEdges = [];
    for await (const page of manager.streamCompletedDependencyGenerationEdges(
      completed.snapshot!.generationId,
      1,
    )) {
      streamedEdges.push(...page);
    }
    expect(streamedEdges).toEqual([{
      blockerSourceId: 'acme/app:2',
      blockedSourceId: 'acme/app:3',
    }]);
    expect(await manager.getLatestCompletedDependencyGeneration(connectorId))
      .toMatchObject({
        generationId: completed.snapshot!.generationId,
        readMode: 'graphql-bulk',
      });
  });

  it('leaves synchronized edges untouched when remote collection fails partially', async () => {
    const connectorId = 'github-stream-failed';
    await setupConnector(connectorId);
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-existing`,
      taskId: `${connectorId}-task-2`,
      dependsOnTaskId: `${connectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1'],
    }, 'graphql-bulk');
    await writer!.fail(new Error('repository page 2 failed'));

    const connector = streamedConnector(connectorId);
    const result = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );

    expect(result.snapshot).toBeUndefined();
    const { eq } = await import('drizzle-orm');
    expect(await dbModule.default.select().from(schema.taskDependencies).where(
      eq(schema.taskDependencies.connectorInstanceId, connectorId),
    ))
      .toEqual([expect.objectContaining({ id: `${connectorId}-existing` })]);
    const snapshots = await dbModule.default.select()
      .from(schema.dependencyReconciliationSnapshots);
    expect(snapshots.find(({ connectorInstanceId }) =>
      connectorInstanceId === connectorId)).toMatchObject({
      status: 'partial',
      phase: 'collecting',
      readMode: 'graphql-bulk',
      failureReason: 'repository page 2 failed',
    });
  });

  it('does not delete local edges when a staged blocker cannot be resolved locally', async () => {
    const connectorId = 'github-unresolved-blocker';
    await setupConnector(connectorId);
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-existing`,
      taskId: `${connectorId}-task-2`,
      dependsOnTaskId: `${connectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [{
        blockerSourceId: 'renamed/repository:99',
        blockedSourceId: 'acme/app:2',
      }],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:2', 'acme/app:3'],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const connector = streamedConnector(connectorId);

    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true },
    );
    const { eq } = await import('drizzle-orm');

    expect(completed.removed).toBe(0);
    expect(await dbModule.default.select().from(schema.taskDependencies).where(
      eq(schema.taskDependencies.id, `${connectorId}-existing`),
    )).toHaveLength(1);
  });

  it('completes an empty streamed generation instead of leaving it active', async () => {
    const connectorId = 'github-empty';
    await setupConnector(connectorId, false);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.complete('graphql-bulk');

    const completed = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );

    expect(completed.snapshot).toMatchObject({
      status: 'completed',
      phase: 'completed',
      total: 0,
      processed: 0,
      readMode: 'graphql-bulk',
    });
    const nextGeneration = await manager.beginDependencySnapshotGeneration(connectorId);
    expect(nextGeneration).toBeDefined();
    await nextGeneration!.fail(new Error('test cleanup'));
  });

  it('reconciles only incrementally observed issues without replacing the full generation', async () => {
    const connectorId = 'github-targeted';
    await setupConnector(connectorId);
    const fullWriter = await manager.beginDependencySnapshotGeneration(connectorId);
    await fullWriter.stagePage({
      dependencies: [{
        blockerSourceId: 'acme/app:1',
        blockedSourceId: 'acme/app:2',
      }],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:2', 'acme/app:3'],
    }, 'graphql-bulk');
    await fullWriter.complete('graphql-bulk');
    await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    const fullGeneration = await manager.getLatestCompletedDependencyGeneration(connectorId);

    const collection = manager.createTargetedDependencyCollection();
    await collection.writer.stagePage({
      dependencies: [{
        blockerSourceId: 'acme/app:2',
        blockedSourceId: 'acme/app:3',
      }],
      completeBlockedSourceIds: ['acme/app:3'],
      overflowFetchCount: 2,
    }, 'graphql-bulk');
    await collection.writer.complete('graphql-bulk');
    const targeted = collection.result();
    const result = await manager.reconcileTargetedTaskDependencies(
      connectorId,
      targeted.snapshot,
      new Set(['acme/app:3']),
    );

    expect(result).toEqual({ imported: 1, removed: 0 });
    expect(targeted.snapshot.overflowFetchCount).toBe(2);
    expect(await manager.getLatestCompletedDependencyGeneration(connectorId))
      .toEqual(fullGeneration);
    const dependencies = await dbModule.default.select().from(schema.taskDependencies);
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: `${connectorId}-task-2`,
        dependsOnTaskId: `${connectorId}-task-1`,
      }),
      expect.objectContaining({
        taskId: `${connectorId}-task-3`,
        dependsOnTaskId: `${connectorId}-task-2`,
      }),
    ]));
  });

  it('does not remove a targeted edge when its remote blocker is unresolved locally', async () => {
    const connectorId = 'github-targeted-unresolved';
    await setupConnector(connectorId);
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${connectorId}-existing`,
      taskId: `${connectorId}-task-3`,
      dependsOnTaskId: `${connectorId}-task-2`,
      type: 'blocks',
      connectorInstanceId: connectorId,
      syncStatus: 'synced',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await manager.reconcileTargetedTaskDependencies(
      connectorId,
      {
        dependencies: [{
          blockerSourceId: 'acme/other:99',
          blockedSourceId: 'acme/app:3',
        }],
        completeBlockedSourceIds: ['acme/app:3'],
      },
      new Set(['acme/app:3']),
    );

    expect(result).toEqual({ imported: 0, removed: 0 });
    const { eq } = await import('drizzle-orm');
    expect(await dbModule.default.select().from(schema.taskDependencies).where(
      eq(schema.taskDependencies.id, `${connectorId}-existing`),
    )).toHaveLength(1);
  });

  it('records agreement for all dependency endpoints and removes only with eligible evidence', async () => {
    const connectorId = 'github-identity-agreement';
    await setupConnector(connectorId);
    await enableComparison(connectorId);
    for (let number = 1; number <= 3; number++) {
      bindTask(
        connectorId,
        `${connectorId}-task-${number}`,
        `acme/app:${number}`,
        `I_${number}`,
      );
    }
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
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:2', 'acme/app:3'],
      blockedIdentityEvidence: [1, 2, 3].map((number) => ({
        sourceId: `acme/app:${number}`,
        state: 'verified' as const,
        evidence: issueEvidence(`I_${number}`, `acme/app:${number}`),
      })),
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    expect(result).toMatchObject({
      removed: 1,
      snapshot: {
        status: 'completed',
        identityMode: 'comparison',
        identityModeRevision: 3,
        identityEvidenceSource: 'graphql-node',
        identityEvidenceEligible: true,
        identityEvidenceFailureReason: null,
      },
    });
    const snapshot = await manager.getLatestCompletedDependencyGeneration(connectorId);
    const records = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords);
    expect(records.filter(({ runId }) =>
      runId === snapshot?.identityComparisonRunId)).toHaveLength(3);
    expect(records.filter(({ runId }) =>
      runId === snapshot?.identityComparisonRunId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surface: 'dependency', outcome: 'agreement' }),
      ]),
    );
    const persistedTasks = await dbModule.default.select().from(schema.tasks);
    expect(persistedTasks.find(({ id }) => id === `${connectorId}-task-2`)?.sourceId)
      .toBe('acme/app:2');
  });

  it('treats orphaned shadow bindings as no applicable local task', async () => {
    const connectorId = 'github-identity-no-local-task';
    const sourceId = 'octo-org/homelab-config:314';
    const taskId = `${connectorId}-deleted-task`;
    const stableId = 'I_no_local_task';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 1);
    await dbModule.default.insert(schema.tasks).values({
      id: taskId,
      sourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Historical issue',
      isChecklistItem: false,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    });
    bindTask(connectorId, taskId, sourceId, stableId);
    await dbModule.default.delete(schema.tasks).where(
      (await import('drizzle-orm')).eq(schema.tasks.id, taskId),
    );
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [sourceId],
      blockedIdentityEvidence: [{
        sourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, sourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true, identityComparison: runtime },
    );
    runtime.complete('succeeded');

    expect(result.snapshot).toMatchObject({
      total: 1,
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
      identityComparisonRunId: runtime.runId,
    });
    const records = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        runtime.runId,
      ));
    expect(records).toEqual([expect.objectContaining({
      candidateKey: `dependency:endpoint:${sourceId}`,
      localTaskId: null,
      legacySelectedLocalId: null,
      stableSelectedLocalId: null,
      legacyAction: 'none',
      stableAction: 'none',
      outcome: 'agreement',
      reason: 'exact_match',
    })]);
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRuns.id,
        runtime.runId,
      ))
      .get()).toMatchObject({
        state: 'succeeded',
        evidenceEligible: true,
        outcomeCounts: { agreement: 1 },
      });
    expect(identity.getGitHubIdentityComparisonStatus(connectorId).coverage)
      .toMatchObject({
        dependencyIdentity: {
          covered: true,
          endpointCount: 1,
          comparisonRecordCount: 1,
          blockingRecordCount: 0,
        },
      });

    await dbModule.default.update(schema.externalEntityBindings).set({
      state: 'collision',
    }).where((await import('drizzle-orm')).eq(
      schema.externalEntityBindings.localId,
      taskId,
    ));
    const ambiguousWriter = await manager.beginDependencySnapshotGeneration(connectorId);
    await ambiguousWriter!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [sourceId],
      blockedIdentityEvidence: [{
        sourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, sourceId),
      }],
    }, 'graphql-bulk');
    await ambiguousWriter!.complete('graphql-bulk');
    const ambiguousRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const ambiguousResult = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true, identityComparison: ambiguousRuntime },
    );
    ambiguousRuntime.complete('succeeded');

    expect(ambiguousResult.snapshot).toMatchObject({
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_comparison_blocked',
    });
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        ambiguousRuntime.runId,
      ))).toEqual([expect.objectContaining({
      localTaskId: null,
      legacySelectedLocalId: null,
      stableSelectedLocalId: null,
      outcome: 'collision',
      reason: 'multiple_stable_bindings',
    })]);
  });

  it('agrees across a configured repository alias without rewriting the local source ID', async () => {
    const connectorId = 'github-identity-alias';
    const legacySourceId = 'legacy/ideation:984';
    const canonicalSourceId = 'octo-org/ideation:984';
    const taskId = `${connectorId}-task`;
    const stableId = 'I_alias_task';
    await setupConnector(connectorId, false);
    await enableComparison(connectorId, 1);
    await dbModule.default.insert(schema.tasks).values({
      id: taskId,
      sourceId: legacySourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Renamed repository issue',
      isChecklistItem: false,
      metadata: { issueNumber: 984 },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    });
    bindTask(connectorId, taskId, legacySourceId, stableId, canonicalSourceId);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [legacySourceId],
      blockedIdentityEvidence: [{
        sourceId: legacySourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, canonicalSourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );

    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
    });
    const records = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
      candidateKey: `dependency:endpoint:${legacySourceId}`,
      localTaskId: taskId,
      legacySelectedLocalId: taskId,
      stableSelectedLocalId: taskId,
      outcome: 'agreement',
    })]));
    expect((await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, taskId))
      .get())?.sourceId).toBe(legacySourceId);
  });

  it('selects a native task inserted by streamed full-sync ingestion', async () => {
    const connectorId = 'github-identity-full-sync-ingestion';
    const sourceId = 'octo-org/mission-control:2426';
    const stableId = 'I_full_sync_ingestion';
    await setupConnector(connectorId, false);
    await enableComparison(connectorId, 1);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const connector = streamedConnector(connectorId);
    async function* pages() {
      await writer!.stagePage({
        dependencies: [],
        completeBlockedSourceIds: [sourceId],
        blockedIdentityEvidence: [{
          sourceId,
          state: 'verified' as const,
          evidence: issueEvidence(stableId, sourceId),
        }],
      }, 'graphql-bulk');
      yield [issueTask(connectorId, sourceId, stableId)];
      await writer!.complete('graphql-bulk');
    }

    const upsert = await pullManager.upsertTasks(
      connectorId,
      connector,
      pages(),
      true,
      [],
      [],
      'comparing',
      runtime,
    );
    const result = await manager.reconcileTaskDependencies(
      connectorId,
      connector,
      { full: true, identityComparison: runtime },
    );
    runtime.complete('succeeded');

    expect(upsert.added).toBe(1);
    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
      identityComparisonRunId: runtime.runId,
    });
    const localTask = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.sourceId, sourceId))
      .get();
    expect(localTask).toMatchObject({
      connectorInstanceId: connectorId,
      isChecklistItem: false,
      sourceId,
    });
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        runtime.runId,
      ))).toEqual(expect.arrayContaining([expect.objectContaining({
      surface: 'dependency',
      candidateKey: `dependency:endpoint:${sourceId}`,
      localTaskId: localTask!.id,
      legacySelectedLocalId: localTask!.id,
      stableSelectedLocalId: localTask!.id,
      outcome: 'agreement',
      reason: 'exact_match',
    })]));
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRuns.id,
        runtime.runId,
      ))
      .get()).toMatchObject({
      state: 'succeeded',
    });
  }, 30_000);

  it('selects an existing native task during relationship-only polling', async () => {
    const connectorId = 'github-identity-relationship-poll';
    const sourceId = 'octo-org/mission-control:2407';
    const taskId = `${connectorId}-task`;
    const stableId = 'I_relationship_poll';
    await setupConnector(connectorId, false);
    await enableComparison(connectorId, 1);
    await dbModule.default.insert(schema.tasks).values({
      id: taskId,
      sourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Existing native task',
      isChecklistItem: false,
      metadata: { issueNumber: 2407 },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    });
    bindTask(connectorId, taskId, sourceId, stableId);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [sourceId],
      blockedIdentityEvidence: [{
        sourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, sourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'incremental',
    });

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true, identityComparison: runtime },
    );
    runtime.complete('succeeded');

    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
      identityComparisonRunId: runtime.runId,
    });
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        runtime.runId,
      ))).toEqual([expect.objectContaining({
      surface: 'dependency',
      candidateKey: `dependency:endpoint:${sourceId}`,
      localTaskId: taskId,
      legacySelectedLocalId: taskId,
      stableSelectedLocalId: taskId,
      outcome: 'agreement',
      reason: 'exact_match',
    })]);
    expect(await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, taskId))
      .get()).toMatchObject({
      id: taskId,
      sourceId,
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRuns.id,
        runtime.runId,
      ))
      .get()).toMatchObject({
      state: 'succeeded',
      evidenceEligible: false,
    });
  });

  it('does not treat a project draft binding as an applicable dependency task', async () => {
    const connectorId = 'github-identity-draft-endpoint';
    const sourceId = 'octo-org/mission-control:2424';
    const taskId = `${connectorId}-draft`;
    const draftSourceId = 'project:1:draft:PVTI_1';
    const stableId = 'I_draft_endpoint';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 1);
    bindTask(connectorId, taskId, draftSourceId, stableId, sourceId);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [sourceId],
      blockedIdentityEvidence: [{
        sourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, sourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );

    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        result.snapshot!.identityComparisonRunId!,
      ))).toEqual([expect.objectContaining({
      candidateKey: `dependency:endpoint:${sourceId}`,
      localTaskId: null,
      legacySelectedLocalId: null,
      stableSelectedLocalId: null,
      outcome: 'agreement',
      reason: 'exact_match',
    })]);
    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
    });
  });

  it('does not treat a checklist-only binding as an applicable dependency task', async () => {
    const connectorId = 'github-identity-checklist-endpoint';
    const sourceId = 'octo-org/mission-control:1106';
    const taskId = `${connectorId}-checklist`;
    const stableId = 'I_checklist_endpoint';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 1);
    await dbModule.default.insert(schema.tasks).values({
      id: taskId,
      sourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Checklist-only row',
      isChecklistItem: true,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    });
    bindTask(connectorId, taskId, sourceId, stableId);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [sourceId],
      blockedIdentityEvidence: [{
        sourceId,
        state: 'verified',
        evidence: issueEvidence(stableId, sourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );

    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityEvidenceFailureReason: null,
    });
    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRecords.runId,
        result.snapshot!.identityComparisonRunId!,
      ))).toEqual([expect.objectContaining({
      candidateKey: `dependency:endpoint:${sourceId}`,
      localTaskId: null,
      legacySelectedLocalId: null,
      stableSelectedLocalId: null,
      legacyAction: 'none',
      stableAction: 'none',
      outcome: 'agreement',
    })]);
  });

  it('keeps true selected-task disagreements blocking', async () => {
    const connectorId = 'github-identity-selected-id-disagreement';
    const legacySourceId = 'acme/disagreement:41';
    const otherSourceId = 'acme/disagreement:42';
    await setupConnector(connectorId, false);
    await enableComparison(connectorId, 1);
    await dbModule.default.insert(schema.tasks).values([{
      id: `${connectorId}-task-1`,
      sourceId: legacySourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Legacy-selected task',
      isChecklistItem: false,
      metadata: { issueNumber: 41 },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    }, {
      id: `${connectorId}-task-2`,
      sourceId: otherSourceId,
      connectorType: 'github-issues',
      connectorInstanceId: connectorId,
      title: 'Stable-selected task',
      isChecklistItem: false,
      metadata: { issueNumber: 42 },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      lastSyncedAt: '2026-08-09T00:00:00.000Z',
    }]);
    bindTask(
      connectorId,
      `${connectorId}-task-2`,
      legacySourceId,
      'I_selected_id_disagreement',
      legacySourceId,
    );
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [legacySourceId],
      blockedIdentityEvidence: [{
        sourceId: legacySourceId,
        state: 'verified',
        evidence: issueEvidence('I_selected_id_disagreement', legacySourceId),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );

    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_comparison_blocked',
    });
    const records = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
      candidateKey: `dependency:endpoint:${legacySourceId}`,
      legacySelectedLocalId: `${connectorId}-task-1`,
      stableSelectedLocalId: `${connectorId}-task-2`,
      legacyAction: 'present',
      stableAction: 'present',
      outcome: 'stable_legacy_disagree',
      reason: 'selected_ids_differ',
    })]));
  });

  it('reports dependency and sub-issue coverage independently from one clean full run', async () => {
    const connectorId = 'github-identity-clean-surfaces';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 1);
    bindTask(connectorId, `${connectorId}-task-1`, 'acme/app:1', 'I_1');
    bindTask(connectorId, `${connectorId}-task-2`, 'acme/app:2', 'I_2');
    bindTask(connectorId, `${connectorId}-task-3`, 'acme/app:3', 'I_3');
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:2'],
      blockedIdentityEvidence: [{
        sourceId: 'acme/app:1',
        state: 'verified',
        evidence: issueEvidence('I_1', 'acme/app:1'),
      }, {
        sourceId: 'acme/app:2',
        state: 'verified',
        evidence: issueEvidence('I_2', 'acme/app:2'),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const dependencyResult = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true, identityComparison: runtime },
    );
    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        ['acme/app:1', {
          childSourceId: 'acme/app:1',
          childIdentityEvidence: issueEvidence('I_1', 'acme/app:1'),
          parent: null,
        }],
        ['acme/app:2', {
          childSourceId: 'acme/app:2',
          childIdentityEvidence: issueEvidence('I_2', 'acme/app:2'),
          parent: {
            sourceId: 'acme/app:1',
            repository: 'acme/app',
            issueNumber: 1,
            nodeId: 'I_1',
            title: 'Parent',
            url: 'https://github.com/acme/app/issues/1',
          },
          parentIdentityEvidence: issueEvidence('I_1', 'acme/app:1'),
        }],
        ['acme/app:3', {
          childSourceId: 'acme/app:3',
          childIdentityEvidence: issueEvidence('I_3', 'acme/app:3'),
          parent: null,
        }],
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    );
    runtime.complete('succeeded');

    expect(dependencyResult.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      identityComparisonRunId: runtime.runId,
    });
    const status = identity.getGitHubIdentityComparisonStatus(connectorId);
    expect(status.coverage).toMatchObject({
      dependencyIdentity: {
        covered: true,
        endpointCount: 2,
        comparisonRecordCount: 2,
      },
      subIssueIdentity: {
        covered: true,
        endpointCount: 4,
        childEndpointCount: 3,
        parentEndpointCount: 1,
      },
    });
    expect((status.stageTwo as { blockers: string[] }).blockers).toEqual(
      expect.not.arrayContaining([
        'dependency_identity_evidence_required',
        'sub_issue_identity_evidence_required',
        'unexplained_stable_legacy_disagreement',
      ]),
    );
  });

  it('keeps deletions fenced for path reuse, collisions, and missing REST evidence', async () => {
    const connectorId = 'github-identity-blocked';
    await setupConnector(connectorId);
    await enableComparison(connectorId);
    bindTask(connectorId, `${connectorId}-task-1`, 'acme/app:1', 'I_1');
    bindTask(connectorId, `${connectorId}-task-2`, 'acme/app:2', 'I_2');
    bindTask(connectorId, `${connectorId}-task-3`, 'acme/app:3', 'I_3');
    const { eq } = await import('drizzle-orm');
    await dbModule.default.update(schema.externalEntityBindings).set({
      state: 'collision',
    }).where(eq(schema.externalEntityBindings.localId, `${connectorId}-task-3`));
    await dbModule.default.insert(schema.taskDependencies).values([
      {
        id: `${connectorId}-path-reuse`,
        taskId: `${connectorId}-task-1`,
        dependsOnTaskId: `${connectorId}-task-2`,
        type: 'blocks',
        connectorInstanceId: connectorId,
        syncStatus: 'synced',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: `${connectorId}-collision`,
        taskId: `${connectorId}-task-3`,
        dependsOnTaskId: `${connectorId}-task-2`,
        type: 'blocks',
        connectorInstanceId: connectorId,
        syncStatus: 'synced',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1', 'acme/app:3'],
      blockedIdentityEvidence: [{
        sourceId: 'acme/app:1',
        state: 'verified',
        evidence: issueEvidence('I_2', 'acme/app:1'),
      }, {
        sourceId: 'acme/app:3',
        state: 'verified',
        evidence: issueEvidence('I_3', 'acme/app:3'),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const blocked = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    expect(blocked.removed).toBe(0);
    expect(blocked.snapshot).toMatchObject({
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_comparison_blocked',
    });
    const records = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords);
    const outcomes = records
      .filter(({ runId }) => runId === blocked.snapshot?.identityComparisonRunId)
      .map(({ outcome }) => outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['path_reuse', 'collision']));

    const restConnectorId = 'github-identity-rest-missing';
    await setupConnector(restConnectorId);
    await enableComparison(restConnectorId);
    bindTask(restConnectorId, `${restConnectorId}-task-1`, 'acme/app:1', 'I_rest_1');
    bindTask(restConnectorId, `${restConnectorId}-task-2`, 'acme/app:2', 'I_rest_2');
    await dbModule.default.insert(schema.taskDependencies).values({
      id: `${restConnectorId}-stale`,
      taskId: `${restConnectorId}-task-2`,
      dependsOnTaskId: `${restConnectorId}-task-1`,
      type: 'blocks',
      connectorInstanceId: restConnectorId,
      syncStatus: 'synced',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const restWriter = await manager.beginDependencySnapshotGeneration(restConnectorId);
    await restWriter!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:2'],
      blockedIdentityEvidence: [{
        sourceId: 'acme/app:2',
        state: 'missing',
      }],
    }, 'rest-fallback');
    await restWriter!.complete('rest-fallback');
    const restResult = await manager.reconcileTaskDependencies(
      restConnectorId,
      streamedConnector(restConnectorId),
      { full: true },
    );
    expect(restResult.removed).toBe(0);
    expect(restResult.snapshot).toMatchObject({
      identityEvidenceSource: 'rest-unavailable',
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_stable_evidence_unavailable',
    });
  });

  it('fences restart reconciliation after an identity mode revision change', async () => {
    const connectorId = 'github-identity-fence';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 4);
    bindTask(connectorId, `${connectorId}-task-1`, 'acme/app:1', 'I_fence_1');
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: ['acme/app:1'],
      blockedIdentityEvidence: [{
        sourceId: 'acme/app:1',
        state: 'verified',
        evidence: issueEvidence('I_fence_1', 'acme/app:1'),
      }],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const { eq } = await import('drizzle-orm');
    await dbModule.default.update(schema.githubIdentityControls).set({
      modeRevision: 5,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, connectorId));

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    expect(result).toMatchObject({
      resumeSkippedReason: 'identity-context-changed',
      snapshot: {
        status: 'partial',
        identityEvidenceEligible: false,
        identityEvidenceFailureReason: 'dependency_identity_context_changed',
      },
    });

    expect(await dbModule.default.select()
      .from(schema.githubIdentityComparisonRecords)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localTaskId: `${connectorId}-task-1` }),
      ]),
    );
  });

  it('atomically fences page staging when mode changes before the staging transaction', async () => {
    const connectorId = 'github-stage-page-fence';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 6);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    const { eq } = await import('drizzle-orm');
    await dbModule.default.update(schema.githubIdentityControls).set({
      modeRevision: 7,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, connectorId));

    await expect(writer!.stagePage({
      dependencies: [{
        blockedSourceId: 'acme/app:1',
        blockerSourceId: 'acme/app:2',
      }],
      completeBlockedSourceIds: ['acme/app:1'],
    }, 'graphql-bulk')).rejects.toThrow('fenced before page staging');
    const [snapshot] = await dbModule.default.select()
      .from(schema.dependencyReconciliationSnapshots)
      .where(eq(schema.dependencyReconciliationSnapshots.connectorInstanceId, connectorId));
    expect(snapshot).toMatchObject({
      status: 'partial',
      phase: 'completed',
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_identity_context_changed',
    });
    expect(await dbModule.default.select().from(schema.dependencyReconciliationItems)
      .where(eq(schema.dependencyReconciliationItems.snapshotId, snapshot.id))).toEqual([]);
    expect(await dbModule.default.select().from(schema.dependencyReconciliationEdges)
      .where(eq(schema.dependencyReconciliationEdges.snapshotId, snapshot.id))).toEqual([]);
  });

  it('keeps an empty comparison generation evidence-ineligible', async () => {
    const connectorId = 'github-identity-empty';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 6);
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: [],
      blockedIdentityEvidence: [],
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');

    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    expect(result.snapshot).toMatchObject({
      status: 'completed',
      total: 0,
      removed: 0,
      identityEvidenceEligible: false,
      identityEvidenceFailureReason: 'dependency_endpoint_evidence_empty',
    });
    const status = identity.getGitHubIdentityComparisonStatus(connectorId);
    expect(status.coverage).toMatchObject({
      dependencyIdentity: {
        covered: false,
        endpointCount: 0,
        comparisonRecordCount: 0,
        reasons: expect.arrayContaining(['dependency_endpoint_evidence_empty']),
      },
    });
    expect((status.stageTwo as { blockers: string[] }).blockers)
      .toContain('dependency_identity_evidence_required');
  });

  it('bounds stable endpoint lookups and exposes real dependency coverage', async () => {
    const connectorId = 'github-identity-bounded';
    await setupConnector(connectorId);
    await enableComparison(connectorId, 8);
    const sourceIds = Array.from({ length: 501 }, (_, index) =>
      `acme/overflow:${index + 1}`);
    const previousBatchSize = process.env.MC_DEPENDENCY_STREAM_BATCH_SIZE;
    process.env.MC_DEPENDENCY_STREAM_BATCH_SIZE = '1000';
    const writer = await manager.beginDependencySnapshotGeneration(connectorId);
    process.env.MC_DEPENDENCY_STREAM_BATCH_SIZE = previousBatchSize;
    await writer!.stagePage({
      dependencies: [],
      completeBlockedSourceIds: sourceIds,
      blockedIdentityEvidence: sourceIds.map((sourceId, index) => ({
        sourceId,
        state: 'verified' as const,
        evidence: issueEvidence(`I_overflow_${index + 1}`, sourceId),
      })),
    }, 'graphql-bulk');
    await writer!.complete('graphql-bulk');
    const result = await manager.reconcileTaskDependencies(
      connectorId,
      streamedConnector(connectorId),
      { full: true },
    );
    const run = await dbModule.default.select()
      .from(schema.githubIdentityComparisonRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubIdentityComparisonRuns.id,
        result.snapshot!.identityComparisonRunId!,
      ))
      .get();
    expect(run).toMatchObject({ queryCount: 2, state: 'succeeded' });
    expect(result.snapshot).toMatchObject({
      identityEvidenceEligible: true,
      total: 501,
    });
    const status = identity.getGitHubIdentityComparisonStatus(connectorId);
    expect(status.coverage).toMatchObject({
      implementedSurfaces: expect.arrayContaining(['dependency']),
      uncoveredGates: expect.not.arrayContaining(['dependency_identity']),
      dependencyIdentity: {
        covered: true,
        endpointCount: 501,
        comparisonRecordCount: 501,
        missingOrPartialEndpointCount: 0,
        lookup: { queryCount: 2, maxBatchSize: 500 },
      },
    });
    expect((status.stageTwo as { blockers: string[] }).blockers)
      .not.toContain('dependency_identity_evidence_required');
  });
});
