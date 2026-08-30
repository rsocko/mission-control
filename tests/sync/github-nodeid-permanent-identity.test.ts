import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  bindGitHubTaskIdentities,
  githubIssueEvidence,
} from '../fixtures/github-node-identity';

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type IdentityModule = typeof import('@/lib/external-identities');
type PullManagerModule = typeof import('@/lib/sync/pull-manager');

const dbPath = join(tmpdir(), `mc-nodeid-permanent-${process.pid}.db`);
const now = '2026-08-16T00:00:00.000Z';
let database: DbModule;
let schema: SchemaModule;
let identity: IdentityModule;
let pullManager: PullManagerModule;

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath);
  process.env.MC_DB_PATH = dbPath;
  process.env.LOG_LEVEL = 'silent';
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
  [database, schema, identity, pullManager] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
    import('@/lib/sync/pull-manager'),
  ]);
  database.default.insert(schema.connectorConfigs).values({
    id: 'github-permanent',
    type: 'github-issues',
    name: 'GitHub',
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: {},
    settings: { repos: ['acme/app'] },
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: 'github-permanent',
    phase: 'complete',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: 'github-permanent',
    modeRevision: 3,
    updatedAt: now,
  }).run();
  database.default.insert(schema.tasks).values([
    {
      id: 'task-parent',
      sourceId: 'acme/app:1',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-permanent',
      title: 'Parent',
      metadata: { issueNumber: 1 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: 'task-child',
      sourceId: 'acme/app:2',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-permanent',
      title: 'Child',
      parentId: 'task-parent',
      depth: 1,
      metadata: { issueNumber: 2 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: 'task-unbound',
      sourceId: 'acme/app:3',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-permanent',
      title: 'Unbound',
      metadata: { issueNumber: 3 },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  ]).run();
  bindGitHubTaskIdentities(database.sqlite, 'github-permanent', [
    {
      taskId: 'task-parent',
      owner: 'acme',
      repository: 'app',
      issueNumber: 1,
      issueStableId: 'I_parent',
      repositoryStableId: 'R_app',
    },
    {
      taskId: 'task-child',
      owner: 'acme',
      repository: 'app',
      issueNumber: 2,
      issueStableId: 'I_child',
      repositoryStableId: 'R_app',
    },
  ], now);
}, 30_000);

afterAll(() => {
  database?.sqlite.close();
  delete process.env.MC_DB_PATH;
  if (existsSync(dbPath)) rmSync(dbPath);
});

function runtime() {
  return new identity.GitHubStableIdentityRuntime({
    connectorInstanceId: 'github-permanent',
    modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-permanent'),
    syncKind: 'full',
  });
}

describe('permanent GitHub NodeID identity', () => {
  it('is always stable with no mode or rollback surface', () => {
    const snapshot = identity.getGitHubIdentityModeSnapshot('github-permanent');
    expect(snapshot).toEqual({
      connectorInstanceId: 'github-permanent',
      effectiveMode: 'stable',
      modeRevision: 3,
      capturedAt: expect.any(String),
    });
    expect(identity.GITHUB_IDENTITY_MODE).toBe('stable');
    // Rollback, comparison, and mode-transition APIs no longer exist.
    for (const removed of [
      'rollbackGitHubStablePrimary',
      'enableGitHubStablePrimary',
      'transitionGitHubIdentityMode',
      'startGitHubIdentityComparisonRun',
      'appendGitHubIdentityComparisonRecords',
      'reconcileGitHubComparisonCycle',
      'canWriteShadowIdentity',
    ]) {
      expect(identity as Record<string, unknown>).not.toHaveProperty(removed);
    }
    // An unprovisioned connector is stable too — it can never be locator-primary.
    expect(identity.getGitHubIdentityModeSnapshot('missing-connector'))
      .toMatchObject({ effectiveMode: 'stable', modeRevision: 0 });
  });

  it('produces no comparison evidence while resolving a normal sync batch', async () => {
    const scope = runtime();
    const decisions = await scope.resolveBatch('task', 'task', [{
      candidateKey: 'acme/app:2',
      locatorMatchedLocalIds: ['task-child'],
      boundAction: 'update',
      unboundAction: 'create',
      localTaskId: 'task-child',
      evidence: githubIssueEvidence({
        issueStableId: 'I_child',
        repositoryStableId: 'R_app',
        owner: 'acme',
        repository: 'app',
        issueNumber: 2,
      }),
    }]);
    scope.complete('succeeded');

    expect(decisions).toEqual([expect.objectContaining({
      appliedSource: 'stable',
      outcome: 'resolved',
      selectedLocalId: 'task-child',
      selectedAction: 'update',
    })]);
    for (const table of [
      'github_identity_comparison_records',
      'github_identity_comparison_runs',
      'github_identity_sub_issue_population_members',
    ]) {
      expect(database.sqlite.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table)).toBeUndefined();
    }
  });

  it('resolves a renamed locator by NodeID instead of the mutable source_id', async () => {
    const scope = runtime();
    const [decision] = await scope.resolveBatch('task', 'task', [{
      candidateKey: 'new-owner/renamed:9',
      // The remote locator moved; no local row matches it any more.
      locatorMatchedLocalIds: [],
      boundAction: 'update',
      unboundAction: 'create',
      evidence: githubIssueEvidence({
        issueStableId: 'I_child',
        repositoryStableId: 'R_app',
        owner: 'new-owner',
        repository: 'renamed',
        issueNumber: 9,
      }),
    }]);
    scope.complete('succeeded');

    expect(decision).toMatchObject({
      appliedSource: 'stable',
      outcome: 'locator_change',
      selectedLocalId: 'task-child',
    });
  });

  it('blocks instead of falling back when NodeID evidence is missing', async () => {
    const scope = runtime();
    const decisions = await scope.resolveBatch('task', 'task', [
      {
        // No evidence at all: the caller only has the mutable locator.
        candidateKey: 'acme/app:1',
        locatorMatchedLocalIds: ['task-parent'],
        localTaskId: 'task-parent',
      },
      {
        // Evidence exists but the local row has no active binding.
        candidateKey: 'acme/app:3',
        locatorMatchedLocalIds: ['task-unbound'],
        localTaskId: 'task-unbound',
        evidence: githubIssueEvidence({
          issueStableId: 'I_unbound',
          repositoryStableId: 'R_app',
          owner: 'acme',
          repository: 'app',
          issueNumber: 3,
        }),
      },
    ]);
    scope.markBlocked('test_probe');
    scope.complete('failed', 'test_probe');

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateKey: 'acme/app:1',
        appliedSource: 'blocked',
        outcome: 'missing_stable_id',
        selectedLocalId: null,
      }),
      expect.objectContaining({
        candidateKey: 'acme/app:3',
        appliedSource: 'blocked',
        outcome: 'unbound_local_row',
        selectedLocalId: null,
      }),
    ]));
  });

  it('ignores retired path locators but blocks active path reuse', async () => {
    const insertEntity = database.sqlite.prepare(`
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id, identity_version,
        next_locator_revision, first_seen_at, last_seen_at
      ) VALUES (?, 'github', 'github.com', 'issue', ?, 1, 2, ?, ?)
    `);
    const insertLocator = database.sqlite.prepare(`
      INSERT INTO external_entity_locators (
        id, external_entity_id, repository_entity_id, provider, host_key, owner, repository,
        owner_key, repository_key, issue_number, valid_from, valid_to, last_seen_at,
        observation_source, locator_revision
      ) VALUES (?, ?, 'entity-R_app', 'github', 'github.com', 'acme', 'app',
        'acme', 'app', ?, ?, ?, ?, 'graphql', 1)
    `);
    insertEntity.run('entity-I_retired_owner', 'I_retired_owner', now, now);
    insertLocator.run(
      'locator-I_retired_owner',
      'entity-I_retired_owner',
      90,
      now,
      '2026-08-16T01:00:00.000Z',
      '2026-08-16T01:00:00.000Z',
    );
    insertEntity.run('entity-I_active_owner', 'I_active_owner', now, now);
    insertLocator.run('locator-I_active_owner', 'entity-I_active_owner', 91, now, null, now);

    const scope = runtime();
    const decisions = await scope.resolveBatch('task', 'task', [
      {
        candidateKey: 'acme/app:90',
        unboundAction: 'create',
        evidence: githubIssueEvidence({
          issueStableId: 'I_replacement_after_retired',
          repositoryStableId: 'R_app',
          owner: 'acme',
          repository: 'app',
          issueNumber: 90,
        }),
      },
      {
        candidateKey: 'acme/app:91',
        unboundAction: 'create',
        evidence: githubIssueEvidence({
          issueStableId: 'I_replacement_while_active',
          repositoryStableId: 'R_app',
          owner: 'acme',
          repository: 'app',
          issueNumber: 91,
        }),
      },
    ]);
    scope.complete('failed', 'test_probe');

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateKey: 'acme/app:90',
        appliedSource: 'stable',
        outcome: 'resolved',
        selectedAction: 'create',
      }),
      expect.objectContaining({
        candidateKey: 'acme/app:91',
        appliedSource: 'blocked',
        outcome: 'path_reuse',
        selectedAction: 'none',
      }),
    ]));
  });

  it('reports blocked task identity decisions with bounded non-sensitive audit entries', async () => {
    const scope = runtime();
    const [decision] = await scope.resolveBatch('task', 'task', [{
      candidateKey: 'acme/app:1',
      locatorMatchedLocalIds: ['task-parent'],
      localTaskId: 'task-parent',
    }]);
    scope.complete('failed', 'test_probe');
    const audit: import('@/lib/sync').SyncAuditEntry[] = [];
    const summary: import('@/lib/sync/pull-manager').GitHubTaskIdentityBlockSummary = {
      count: 0,
      outcomes: {},
    };

    for (let index = 0; index < 25; index++) {
      pullManager.recordBlockedTaskIdentityDecision(
        { ...decision, candidateKey: `acme/app:${index + 100}` },
        audit,
        summary,
      );
    }

    expect(summary).toEqual({
      count: 25,
      outcomes: { missing_stable_id: 25 },
    });
    expect(audit).toHaveLength(20);
    expect(audit[0]).toEqual({
      action: 'protected',
      taskTitle: 'GitHub task identity blocked',
      taskSourceId: 'acme/app:100',
      reason: 'Stable identity decision blocked: missing_stable_id',
    });
    expect(JSON.stringify(audit)).not.toContain('stableIdDigest');
    expect(JSON.stringify(audit)).not.toContain('externalEntityId');
  });

  it('blocks a write when the task has no NodeID binding', async () => {
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-permanent',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-permanent'),
      pendingCandidateCount: 1,
    });
    const scope = runtime();
    await expect(identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-permanent',
      taskId: 'task-unbound',
      operation: 'update',
      identityRuntime: scope,
      writeCycleId: cycleId,
    })).rejects.toThrow('missing_or_inaccessible_identity');
    await expect(identity.authorizeGitHubWrite({
      connectorInstanceId: 'github-permanent',
      taskId: 'task-parent',
      operation: 'update',
      identityRuntime: undefined,
      writeCycleId: cycleId,
    })).rejects.toThrow('missing_identity_runtime');
    await identity.finishGitHubWriteCycle(cycleId, {
      observed: 0,
      applied: 0,
      blocked: 1,
      failed: 0,
      unknown: 0,
    });
    scope.complete('failed', 'unbound_write');

    expect(database.default.select().from(schema.taskSourceWriteLeases).all())
      .toEqual([expect.objectContaining({ state: 'blocked', taskId: 'task-parent' })]);
  });

  it('keeps task hierarchy authoritative in tasks, not in identity evidence', () => {
    expect(database.sqlite.prepare(`
      SELECT parent_id AS parentId, depth FROM tasks WHERE id = 'task-child'
    `).get()).toEqual({ parentId: 'task-parent', depth: 1 });
    // Rebinding a child to a new NodeID locator must not disturb the hierarchy.
    database.sqlite.prepare(`
      UPDATE tasks SET source_id = 'new-owner/renamed:9' WHERE id = 'task-child'
    `).run();
    expect(database.sqlite.prepare(`
      SELECT parent_id AS parentId, depth FROM tasks WHERE id = 'task-child'
    `).get()).toEqual({ parentId: 'task-parent', depth: 1 });
    database.sqlite.prepare(`
      UPDATE tasks SET source_id = 'acme/app:2' WHERE id = 'task-child'
    `).run();
  });

  it('keeps the identity epoch as the only durable write fence', async () => {
    const cycleId = await identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-permanent',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-permanent'),
      pendingCandidateCount: 1,
    });
    database.sqlite.prepare(`
      UPDATE github_identity_controls SET mode_revision = 4 WHERE connector_instance_id = ?
    `).run('github-permanent');
    await expect(identity.beginGitHubWriteCycle({
      connectorInstanceId: 'github-permanent',
      modeSnapshot: { modeRevision: 3 },
      pendingCandidateCount: 1,
    })).rejects.toThrow('stale_write_cycle_mode');
    expect(await identity.finishGitHubWriteCycle(cycleId, {
      observed: 0,
      applied: 0,
      blocked: 0,
      failed: 0,
      unknown: 0,
    })).toBe(false);
    database.sqlite.prepare(`
      UPDATE github_identity_controls SET mode_revision = 3 WHERE connector_instance_id = ?
    `).run('github-permanent');
  });
});
