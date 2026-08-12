import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { IConnector } from '@/lib/connectors';
import type { SourceList, TaskItem } from '@/types';

vi.unmock('drizzle-orm');
vi.unmock('crypto');
vi.mock('@/lib/sync/search-indexer', () => ({
  indexTasksForSearchBatch: vi.fn(async () => undefined),
}));

const directory = mkdtempSync(join(tmpdir(), 'mc-github-shadow-sync-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let upsertSourceLists: typeof import('@/lib/sync/list-manager').upsertSourceLists;
let upsertTasks: typeof import('@/lib/sync/pull-manager').upsertTasks;
let detectDeletions: typeof import('@/lib/sync/deletion-detector').detectDeletions;
let persistExternalIdentityBatch: typeof import('@/lib/external-identities').persistExternalIdentityBatch;
let GitHubIdentityComparisonRuntime: typeof import('@/lib/external-identities').GitHubIdentityComparisonRuntime;
let getGitHubIdentityModeSnapshot: typeof import('@/lib/external-identities').getGitHubIdentityModeSnapshot;

const now = '2026-08-08T12:00:00.000Z';

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  ({ upsertSourceLists } = await import('@/lib/sync/list-manager'));
  ({ upsertTasks } = await import('@/lib/sync/pull-manager'));
  ({ detectDeletions } = await import('@/lib/sync/deletion-detector'));
  ({
    persistExternalIdentityBatch,
    GitHubIdentityComparisonRuntime,
    getGitHubIdentityModeSnapshot,
  } = await import('@/lib/external-identities'));
  createConnector('shadow-sync', 'shadow_write');
  createConnector('disabled-sync', 'disabled');
  createConnector('deletion-sync', 'shadow_write');
  createConnector('comparison-sync', 'comparing');
  createConnector('comparison-deletion-sync', 'comparing');
  createConnector('comparison-partial-sync', 'comparing');
  createConnector('comparison-inaccessible-sync', 'comparing');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub shadow identity sync integration', () => {
  it('binds source lists and tasks only after legacy IDs are resolved', async () => {
    const listIds = await upsertSourceLists(
      'shadow-sync',
      [sourceList('shadow-sync', 'Owner/Repo', 'R_shadow')],
      'shadow_write',
    );
    expect(listIds.get('Owner/Repo')).toBe('shadow-sync:repo:Owner/Repo');

    const existingTaskId = 'pending-task';
    database.default.insert(schema.tasks).values({
      id: existingTaskId,
      sourceId: 'Owner/Repo:42',
      connectorType: 'github-issues',
      connectorInstanceId: 'shadow-sync',
      title: 'Keep local edits',
      status: 'todo',
      syncStatus: 'pending_push',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      metadata: {},
    }).run();
    await upsertTasks(
      'shadow-sync',
      connector('shadow-sync'),
      [task('shadow-sync', 'Owner/Repo', 42, 'I_shadow', 'R_shadow')],
      false,
      [{ id: 'Owner/Repo', name: 'Owner/Repo' }],
      [],
      'shadow_write',
    );

    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, existingTaskId)).get()).toMatchObject({
      id: existingTaskId,
      sourceId: 'Owner/Repo:42',
      syncStatus: 'pending_push',
    });
    expect(database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.connectorInstanceId, 'shadow-sync'))
      .all()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        bindingType: 'source_list',
        localId: 'shadow-sync:repo:Owner/Repo',
        state: 'shadow',
      }),
      expect.objectContaining({
        bindingType: 'task',
        localId: existingTaskId,
        state: 'shadow',
      }),
    ]));
  });

  it('performs no identity-table writes while disabled', async () => {
    const countsBefore = identityCounts();
    await upsertSourceLists(
      'disabled-sync',
      [sourceList('disabled-sync', 'Disabled/Repo', 'R_disabled')],
      'disabled',
    );
    await upsertTasks(
      'disabled-sync',
      connector('disabled-sync'),
      [task('disabled-sync', 'Disabled/Repo', 1, 'I_disabled', 'R_disabled')],
      false,
      [{ id: 'Disabled/Repo', name: 'Disabled/Repo' }],
      [],
      'disabled',
    );

    expect(identityCounts()).toEqual(countsBefore);
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, 'disabled-sync')).get()).toMatchObject({
      sourceId: 'Disabled/Repo:1',
    });
  });

  it('keeps legacy deletion outcomes independent of partial bindings', async () => {
    database.default.insert(schema.tasks).values([
      taskRow('bound-missing', 'Deletion/Repo:1'),
      taskRow('legacy-missing', 'Deletion/Repo:2'),
    ]).run();
    persistExternalIdentityBatch([
      identityWrite('deletion-sync', 'bound-missing', 'Deletion/Repo', 1, 'I_delete_1', 'R_delete'),
    ], 'shadow_write');

    const remote = new Set(['Deletion/Repo:999']);
    expect(await detectDeletions('deletion-sync', remote, true, [])).toMatchObject({ removed: 0 });
    expect(await detectDeletions('deletion-sync', remote, true, [])).toMatchObject({ removed: 2 });
    expect(database.default.select().from(schema.tasks).where(
      eq(schema.tasks.connectorInstanceId, 'deletion-sync'),
    ).all()).toEqual([]);
  });

  it('observes lists and tasks without changing legacy-selected local IDs', async () => {
    const listId = 'comparison-sync:repo:Compare/Repo';
    const localTaskId = 'comparison-local-task';
    const linkedTaskId = 'comparison-linked-task';
    database.default.insert(schema.sourceLists).values({
      id: listId,
      connectorInstanceId: 'comparison-sync',
      sourceId: 'Compare/Repo',
      name: 'Compare/Repo',
      type: 'repo',
    }).run();
    database.default.insert(schema.tasks).values({
      id: localTaskId,
      sourceId: 'Compare/Repo:1',
      connectorType: 'github-issues',
      connectorInstanceId: 'comparison-sync',
      title: 'Legacy task',
      status: 'todo',
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      metadata: {},
    }).run();
    database.default.insert(schema.tasks).values({
      id: linkedTaskId,
      sourceId: `local:${linkedTaskId}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Cross-connector task',
      status: 'todo',
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      metadata: {},
    }).run();
    database.default.insert(schema.taskLinkedSources).values({
      id: 'comparison-linked-source',
      taskId: linkedTaskId,
      connectorType: 'github-issues',
      connectorInstanceId: 'comparison-sync',
      sourceId: 'Compare/Repo:1',
      title: 'Legacy linked source',
      linkedAt: now,
      metadata: {},
    }).run();
    persistExternalIdentityBatch([
      identityWrite('comparison-sync', localTaskId, 'Compare/Repo', 1, 'I_compare', 'R_compare'),
    ], 'comparing');
    const runtime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'comparison-sync',
      modeSnapshot: getGitHubIdentityModeSnapshot('comparison-sync'),
      syncKind: 'full',
    });

    await upsertSourceLists(
      'comparison-sync',
      [sourceList('comparison-sync', 'Compare/Repo', 'R_compare')],
      'comparing',
      runtime,
    );
    await upsertTasks(
      'comparison-sync',
      connector('comparison-sync'),
      [task('comparison-sync', 'Compare/Repo', 1, 'I_compare', 'R_compare')],
      false,
      [{ id: 'Compare/Repo', name: 'Compare/Repo' }],
      [],
      'comparing',
      runtime,
    );
    runtime.complete('succeeded');

    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, localTaskId)).get()).toMatchObject({
      id: localTaskId,
      sourceId: 'Compare/Repo:1',
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.runId, runtime.runId)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          surface: 'source_list',
          outcome: 'stable_legacy_disagree',
        }),
        expect.objectContaining({
          surface: 'task',
          legacySelectedLocalId: localTaskId,
          stableSelectedLocalId: localTaskId,
          outcome: 'agreement',
        }),
        expect.objectContaining({
          surface: 'linked_source',
          legacySelectedLocalId: linkedTaskId,
          stableSelectedLocalId: linkedTaskId,
          outcome: 'agreement',
        }),
      ]));
    expect(database.default.select().from(schema.taskLinkedSourceEntities)
      .where(eq(
        schema.taskLinkedSourceEntities.linkedSourceId,
        'comparison-linked-source',
      )).get()).toMatchObject({
      connectorInstanceId: 'comparison-sync',
    });

    const secondRuntime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'comparison-sync',
      modeSnapshot: getGitHubIdentityModeSnapshot('comparison-sync'),
      syncKind: 'full',
    });
    await upsertTasks(
      'comparison-sync',
      connector('comparison-sync'),
      [task('comparison-sync', 'Compare/Repo', 1, 'I_compare', 'R_compare')],
      false,
      [{ id: 'Compare/Repo', name: 'Compare/Repo' }],
      [],
      'comparing',
      secondRuntime,
    );
    secondRuntime.complete('succeeded');
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(and(
        eq(schema.githubIdentityComparisonRecords.runId, secondRuntime.runId),
        eq(schema.githubIdentityComparisonRecords.surface, 'linked_source'),
      )).get()).toMatchObject({
      legacySelectedLocalId: linkedTaskId,
      stableSelectedLocalId: linkedTaskId,
      outcome: 'agreement',
    });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, linkedTaskId)).get()).toMatchObject({
      id: linkedTaskId,
    });
    expect(database.default.select().from(schema.taskLinkedSources)
      .where(eq(schema.taskLinkedSources.id, 'comparison-linked-source')).get())
      .toMatchObject({
        taskId: linkedTaskId,
        sourceId: 'Compare/Repo:1',
      });

    const linkedEntityId = database.default.select().from(schema.taskLinkedSourceEntities)
      .where(eq(
        schema.taskLinkedSourceEntities.linkedSourceId,
        'comparison-linked-source',
      )).get()!.externalEntityId;
    const renamedRuntime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'comparison-sync',
      modeSnapshot: getGitHubIdentityModeSnapshot('comparison-sync'),
      syncKind: 'full',
    });
    await upsertTasks(
      'comparison-sync',
      connector('comparison-sync'),
      [task('comparison-sync', 'Renamed/Repo', 1, 'I_compare', 'R_compare')],
      true,
      [{ id: 'Renamed/Repo', name: 'Renamed/Repo' }],
      [],
      'comparing',
      renamedRuntime,
    );
    renamedRuntime.complete('succeeded');

    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(and(
        eq(schema.githubIdentityComparisonRecords.runId, renamedRuntime.runId),
        eq(schema.githubIdentityComparisonRecords.surface, 'linked_source'),
      )).get()).toMatchObject({
      legacySelectedLocalId: linkedTaskId,
      stableSelectedLocalId: linkedTaskId,
      outcome: 'locator_change',
    });
    expect(database.default.select().from(schema.taskLinkedSources)
      .where(eq(schema.taskLinkedSources.id, 'comparison-linked-source')).get())
      .toMatchObject({
        id: 'comparison-linked-source',
        taskId: linkedTaskId,
        sourceId: 'Compare/Repo:1',
      });
    expect(database.default.select().from(schema.taskLinkedSourceEntities)
      .where(eq(
        schema.taskLinkedSourceEntities.linkedSourceId,
        'comparison-linked-source',
      )).get()).toMatchObject({
      linkedSourceId: 'comparison-linked-source',
      externalEntityId: linkedEntityId,
    });
  });

  it('protects deletion when final repository evidence is inaccessible', async () => {
    const localTaskId = 'comparison-inaccessible-task';
    database.default.insert(schema.tasks).values({
      ...taskRow(localTaskId, 'Protected/Repo:5'),
      connectorInstanceId: 'comparison-deletion-sync',
      sourceListId: 'comparison-sync:repo:Protected/Repo',
    }).run();
    const runtime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'comparison-deletion-sync',
      modeSnapshot: getGitHubIdentityModeSnapshot('comparison-deletion-sync'),
      syncKind: 'full',
    });
    const audit: import('@/lib/sync').SyncAuditEntry[] = [];
    const result = await detectDeletions(
      'comparison-deletion-sync',
      new Set(['Other/Repo:1']),
      true,
      audit,
      undefined,
      {
        identityComparison: runtime,
        inaccessibleSourceListIds: new Set(['Protected/Repo']),
      },
    );
    runtime.complete('succeeded');

    expect(result).toMatchObject({ removed: 0, localOnlyProtected: 1 });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, localTaskId)).get()).toBeDefined();
    expect(audit).toContainEqual(expect.objectContaining({
      action: 'protected',
      taskId: localTaskId,
      reason: 'Identity evidence is inaccessible or ambiguous; remote absence is not authoritative',
    }));
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(and(
        eq(schema.githubIdentityComparisonRecords.runId, runtime.runId),
        eq(schema.githubIdentityComparisonRecords.localTaskId, localTaskId),
      )).get())
      .toMatchObject({ surface: 'deletion', outcome: 'inaccessible' });
  });

  it.each([
    ['comparison-partial-sync', 'partial', 'partial_fetch'],
    ['comparison-inaccessible-sync', 'inaccessible', 'inaccessible'],
  ] as const)(
    'observes unreturned linked sources as %s evidence without deleting relationships',
    async (connectorId, state, outcome) => {
      const linkedTaskId = `${connectorId}-local-task`;
      const linkedSourceId = `${connectorId}-linked-source`;
      database.default.insert(schema.tasks).values({
        id: linkedTaskId,
        sourceId: `local:${linkedTaskId}`,
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: linkedTaskId,
        status: 'todo',
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
        metadata: {},
      }).run();
      database.default.insert(schema.taskLinkedSources).values({
        id: linkedSourceId,
        taskId: linkedTaskId,
        connectorType: 'github-issues',
        connectorInstanceId: connectorId,
        sourceId: 'Protected/Repo:7',
        title: 'Protected linked source',
        linkedAt: now,
        metadata: {},
      }).run();
      const runtime = new GitHubIdentityComparisonRuntime({
        connectorInstanceId: connectorId,
        modeSnapshot: getGitHubIdentityModeSnapshot(connectorId),
        syncKind: 'full',
      });
      const statefulConnector = {
        ...connector(connectorId),
        getIdentityObservationState: () => [{
          sourceId: 'Protected/Repo',
          state,
        }],
      };

      await upsertTasks(
        connectorId,
        statefulConnector,
        [],
        true,
        [],
        [],
        'comparing',
        runtime,
      );
      runtime.complete('succeeded');

      expect(database.default.select().from(schema.githubIdentityComparisonRecords)
        .where(and(
          eq(schema.githubIdentityComparisonRecords.runId, runtime.runId),
          eq(schema.githubIdentityComparisonRecords.surface, 'linked_source'),
        )).get()).toMatchObject({
        outcome,
        legacySelectedLocalId: linkedTaskId,
      });
      expect(database.default.select().from(schema.githubIdentityComparisonRuns)
        .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get())
        .toMatchObject({ evidenceEligible: false });
      expect(database.default.select().from(schema.taskLinkedSources)
        .where(eq(schema.taskLinkedSources.id, linkedSourceId)).get()).toMatchObject({
        taskId: linkedTaskId,
      });
    },
  );

  it('uses stable bindings across rename and blocks historical path reuse without duplicate IDs', async () => {
    const connectorId = 'stable-routing-sync';
    createConnector(connectorId, 'comparing');
    database.default.insert(schema.githubIdentityControls).values({
      connectorInstanceId: connectorId,
      stablePrimaryEnabled: false,
      modeRevision: 1,
      updatedAt: now,
    }).run();
    const originalListId = `${connectorId}:repo:Old/Repo`;
    await upsertSourceLists(
      connectorId,
      [sourceList(connectorId, 'Old/Repo', 'R_stable_route')],
      'comparing',
    );
    await upsertTasks(
      connectorId,
      connector(connectorId),
      [task(connectorId, 'Old/Repo', 9, 'I_stable_route', 'R_stable_route')],
      false,
      [{ id: 'Old/Repo', name: 'Old/Repo' }],
      [],
      'comparing',
    );
    const originalTask = database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, connectorId)).get()!;
    database.default.update(schema.externalEntityBindings).set({
      state: 'active',
    }).where(eq(schema.externalEntityBindings.connectorInstanceId, connectorId)).run();
    database.default.update(schema.githubIdentityMigrations).set({
      phase: 'stable_primary',
      updatedAt: now,
    }).where(eq(schema.githubIdentityMigrations.connectorInstanceId, connectorId)).run();
    database.default.update(schema.githubIdentityControls).set({
      stablePrimaryEnabled: true,
      modeRevision: 2,
      updatedAt: now,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, connectorId)).run();

    const runtime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const listIds = await upsertSourceLists(
      connectorId,
      [sourceList(connectorId, 'Moved/StableRepo', 'R_stable_route')],
      'stable_primary',
      runtime,
    );
    await upsertTasks(
      connectorId,
      connector(connectorId),
      [task(connectorId, 'Moved/StableRepo', 9, 'I_stable_route', 'R_stable_route')],
      true,
      [{ id: 'Moved/StableRepo', name: 'Moved/StableRepo' }],
      [],
      'stable_primary',
      runtime,
    );
    runtime.complete('succeeded');

    expect(listIds.get('Moved/StableRepo')).toBe(originalListId);
    expect(database.default.select().from(schema.sourceLists)
      .where(eq(schema.sourceLists.connectorInstanceId, connectorId)).all())
      .toEqual([
        expect.objectContaining({ id: originalListId, sourceId: 'Moved/StableRepo' }),
      ]);
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, connectorId)).all())
      .toEqual([
        expect.objectContaining({
          id: originalTask.id,
          sourceId: 'Moved/StableRepo:9',
        }),
      ]);

    const reuseRuntime = new GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'incremental',
    });
    await upsertSourceLists(
      connectorId,
      [sourceList(connectorId, 'Old/Repo', 'R_replacement')],
      'stable_primary',
      reuseRuntime,
    );
    await upsertTasks(
      connectorId,
      connector(connectorId),
      [task(connectorId, 'Old/Repo', 9, 'I_replacement', 'R_replacement')],
      false,
      [{ id: 'Old/Repo', name: 'Old/Repo' }],
      [],
      'stable_primary',
      reuseRuntime,
    );
    reuseRuntime.complete('succeeded');
    expect(database.default.select().from(schema.sourceLists)
      .where(eq(schema.sourceLists.connectorInstanceId, connectorId)).all()).toHaveLength(1);
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, connectorId)).all()).toHaveLength(1);
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.runId, reuseRuntime.runId)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: 'source_list', outcome: 'path_reuse' }),
        expect.objectContaining({ surface: 'task', outcome: 'path_reuse' }),
      ]));
  });
});

function createConnector(
  id: string,
  phase: 'disabled' | 'shadow_write' | 'comparing' | 'stable_primary',
): void {
  database.default.insert(schema.connectorConfigs).values({
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: { read: true, write: true, sync: true },
    credentials: { token: 'test-token' },
    settings: { repos: [] },
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: id,
    phase,
    updatedAt: now,
  }).run();
}

function sourceList(connectorInstanceId: string, sourceId: string, stableId: string): SourceList {
  const [owner, repository] = sourceId.split('/');
  return {
    id: `${connectorInstanceId}:repo:${sourceId}`,
    connectorInstanceId,
    sourceId,
    name: sourceId,
    type: 'repo',
    taskCount: 0,
    lastSyncedAt: now,
    externalIdentity: {
      entity: repositoryObservation(owner, repository, stableId),
    },
  };
}

function task(
  connectorInstanceId: string,
  repositoryName: string,
  issueNumber: number,
  issueStableId: string,
  repositoryStableId: string,
): TaskItem {
  const [owner, repository] = repositoryName.split('/');
  return {
    id: `remote-${issueNumber}`,
    sourceId: `${repositoryName}:${issueNumber}`,
    connectorType: 'github-issues',
    connectorInstanceId,
    title: `Issue ${issueNumber}`,
    status: 'todo',
    priority: 'none',
    createdAt: now,
    updatedAt: now,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: repositoryName,
    sourceListName: repositoryName,
    hubProjectIds: [],
    tags: [],
    metadata: { nodeId: issueStableId, issueNumber },
    externalIdentity: {
      repository: repositoryObservation(owner, repository, repositoryStableId),
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue',
          stableId: issueStableId,
        },
        locator: { owner, repository, issueNumber },
        observationSource: 'graphql',
        observedAt: now,
      },
    },
    syncStatus: 'synced',
    lastSyncedAt: now,
  };
}

function repositoryObservation(owner: string, repository: string, stableId: string) {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository' as const,
      stableId,
    },
    locator: { owner, repository },
    observationSource: 'graphql' as const,
    observedAt: now,
  };
}

function connector(id: string): IConnector {
  return {
    id,
    type: 'github-issues',
    displayName: id,
  } as IConnector;
}

function taskRow(id: string, sourceId: string) {
  return {
    id,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: 'deletion-sync',
    title: id,
    status: 'todo' as const,
    isChecklistItem: false,
    syncStatus: 'synced' as const,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    metadata: {},
  };
}

function identityWrite(
  connectorInstanceId: string,
  localId: string,
  repositoryName: string,
  issueNumber: number,
  issueStableId: string,
  repositoryStableId: string,
) {
  const [owner, repository] = repositoryName.split('/');
  return {
    target: {
      connectorInstanceId,
      bindingType: 'task' as const,
      localId,
      legacyIdentity: `${repositoryName}:${issueNumber}`,
    },
    evidence: {
      repository: repositoryObservation(owner, repository, repositoryStableId),
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue' as const,
          stableId: issueStableId,
        },
        locator: { owner, repository, issueNumber },
        observationSource: 'backfill' as const,
        observedAt: now,
      },
    },
  };
}

function identityCounts() {
  return {
    entities: database.default.select().from(schema.externalEntities).all().length,
    bindings: database.default.select().from(schema.externalEntityBindings).all().length,
    locators: database.default.select().from(schema.externalEntityLocators).all().length,
    collisions: database.default.select().from(schema.githubIdentityCollisions).all().length,
  };
}
