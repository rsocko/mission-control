import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ExternalIdentityEvidence } from '@/lib/external-identities';
import type {
  GitHubHierarchyObservation,
} from '@/lib/sync/github-hierarchy-reconciliation';

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type IdentityModule = typeof import('@/lib/external-identities');
type HierarchyModule = typeof import('@/lib/sync/github-hierarchy-reconciliation');

const dbPath = join(tmpdir(), `mc-github-hierarchy-identity-${process.pid}.db`);
const now = '2026-08-10T00:00:00.000Z';
let dbModule: DbModule;
let schema: SchemaModule;
let identity: IdentityModule;
let hierarchy: HierarchyModule;

function evidence(
  stableId: string,
  sourceId: string,
  hostKey = 'github.com',
): ExternalIdentityEvidence {
  const separator = sourceId.lastIndexOf(':');
  const repository = sourceId.slice(0, separator);
  const issueNumber = Number(sourceId.slice(separator + 1));
  const [owner, name] = repository.split('/');
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'repository',
        stableId: `R_${repository.toLowerCase()}`,
      },
      locator: { owner, repository: name },
      observationSource: 'graphql',
      observedAt: now,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'issue',
        stableId,
      },
      locator: { owner, repository: name, issueNumber },
      observationSource: 'graphql',
      observedAt: now,
    },
  };
}

async function setupConnector(
  connectorId: string,
  revision = 3,
  mode: 'comparison' | 'stable' = 'comparison',
) {
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
    },
    credentials: {},
    settings: { repos: ['acme/app', 'legacy/parent'] },
    syncedLists: ['acme/app', 'legacy/parent'],
    createdAt: now,
    updatedAt: now,
  });
  await dbModule.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: mode === 'stable' ? 'stable_primary' : 'comparing',
    updatedAt: now,
  });
  await dbModule.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
    stablePrimaryEnabled: mode === 'stable',
    modeRevision: revision,
    updatedAt: now,
  });
}

async function insertTask(
  connectorId: string,
  id: string,
  sourceId: string,
  parentId?: string,
  options: {
    connectorType?: string;
    isChecklistItem?: boolean;
    metadata?: Record<string, unknown>;
    status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
  } = {},
) {
  const issueNumber = Number(sourceId.slice(sourceId.lastIndexOf(':') + 1));
  await dbModule.default.insert(schema.tasks).values({
    id,
    sourceId,
    connectorType: options.connectorType ?? 'github-issues',
    connectorInstanceId: connectorId,
    title: sourceId,
    status: options.status ?? 'todo',
    parentId,
    depth: parentId ? 1 : 0,
    isChecklistItem: options.isChecklistItem ?? false,
    metadata: options.metadata ?? { issueNumber, isDraft: false, isProjectDraft: false },
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  });
}

function bindTasks(
  connectorId: string,
  bindings: Array<{ taskId: string; legacySourceId: string; stableId: string; evidenceSourceId?: string }>,
) {
  identity.persistExternalIdentityBatch(bindings.map((binding) => ({
    target: {
      connectorInstanceId: connectorId,
      bindingType: 'task' as const,
      localId: binding.taskId,
      legacyIdentity: binding.legacySourceId,
    },
    evidence: evidence(
      binding.stableId,
      binding.evidenceSourceId ?? binding.legacySourceId,
      `${connectorId}.github.test`,
    ),
  })), 'comparing');
}

function recordHistoricalTransfer(
  connectorInstanceId: string,
  sourceTaskId: string,
  successorTaskId: string,
  idempotencyKey: string,
  successorStableId = 'I_kwDOTWhjas8AAAABMFO0qg',
): void {
  const successorEvidence = evidence(
    successorStableId,
    'octo-org/mission-control:2402',
    `${connectorInstanceId}.github.test`,
  );
  identity.recordGitHubTaskTransferReconciliation({
    connectorInstanceId,
    sourceTaskId,
    successorTaskId,
    expectedRevision: 4,
    requestedSourceId: 'octo-org/tyrion:135',
    observation: {
      evidence: {
        repository: {
          ...successorEvidence.repository,
          observationSource: 'rest',
        },
        entity: {
          ...successorEvidence.entity,
          observationSource: 'rest',
        },
      },
      title: 'Quick sort seems to re-show P3 items',
      state: 'closed',
      stateReason: 'not_planned',
    },
    actor: 'test-operator',
    reason: 'Historical REST endpoint resolved to the exact successor binding',
    idempotencyKey,
    now: new Date(now),
  });
}

function relationship(
  connectorId: string,
  childSourceId: string,
  childStableId: string,
  parentSourceId: string,
  parentStableId: string,
): GitHubHierarchyObservation {
  const separator = parentSourceId.lastIndexOf(':');
  const repository = parentSourceId.slice(0, separator);
  const issueNumber = Number(parentSourceId.slice(separator + 1));
  return {
    childSourceId,
    childIdentityEvidence: evidence(
      childStableId,
      childSourceId,
      `${connectorId}.github.test`,
    ),
    parent: {
      sourceId: parentSourceId,
      repository,
      issueNumber,
      nodeId: parentStableId,
      title: parentSourceId,
      url: `https://github.com/${repository}/issues/${issueNumber}`,
    },
    parentIdentityEvidence: evidence(
      parentStableId,
      parentSourceId,
      `${connectorId}.github.test`,
    ),
  };
}

function noParent(
  connectorId: string,
  childSourceId: string,
  childStableId: string,
): GitHubHierarchyObservation {
  return {
    childSourceId,
    childIdentityEvidence: evidence(
      childStableId,
      childSourceId,
      `${connectorId}.github.test`,
    ),
    parent: null,
  };
}

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath);
  process.env.MC_DB_PATH = dbPath;
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
  [dbModule, schema, identity, hierarchy] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
    import('@/lib/sync/github-hierarchy-reconciliation'),
  ]);
}, 30_000);

afterAll(() => {
  dbModule?.sqlite.close();
  delete process.env.MC_DB_PATH;
  if (existsSync(dbPath)) rmSync(dbPath);
});

describe('GitHub sub-issue relationship identity comparison', () => {
  it('applies stable child and parent IDs across a repository rename', async () => {
    const connectorId = 'hierarchy-stable-rename';
    await setupConnector(connectorId, 5, 'stable');
    await insertTask(connectorId, 'stable-parent', 'legacy/parent:1');
    await insertTask(connectorId, 'stable-child', 'acme/app:2');
    bindTasks(connectorId, [
      {
        taskId: 'stable-parent',
        legacySourceId: 'legacy/parent:1',
        stableId: 'I_stable_parent',
      },
      {
        taskId: 'stable-child',
        legacySourceId: 'acme/app:2',
        stableId: 'I_stable_child',
      },
    ]);
    await dbModule.default.update(schema.externalEntityBindings).set({
      state: 'active',
    }).where((await import('drizzle-orm')).eq(
      schema.externalEntityBindings.connectorInstanceId,
      connectorId,
    ));
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'renamed/app:2',
      'I_stable_child',
      'renamed/parent:1',
      'I_stable_parent',
    );
    const parentObservation = noParent(
      connectorId,
      'renamed/parent:1',
      'I_stable_parent',
    );
    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        [observation.childSourceId, observation],
        [parentObservation.childSourceId, parentObservation],
      ]),
      new Set(['renamed/app', 'renamed/parent']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: true, updated: 2 });
    runtime.complete('succeeded');
    expect(await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'stable-child')))
      .toEqual([expect.objectContaining({
        id: 'stable-child',
        parentId: 'stable-parent',
      })]);
  });

  it('compares same-repo and aliased cross-repo endpoints with one deduplicated lookup', async () => {
    const connectorId = 'hierarchy-agreement';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'parent', 'legacy/parent:1');
    const children = Array.from({ length: 55 }, (_, index) => ({
      id: `child-${index + 1}`,
      sourceId: `acme/app:${index + 10}`,
      stableId: `I_child_${index + 1}`,
    }));
    for (const child of children) {
      await insertTask(connectorId, child.id, child.sourceId);
    }
    bindTasks(connectorId, [
      {
        taskId: 'parent',
        legacySourceId: 'legacy/parent:1',
        stableId: 'I_parent',
        evidenceSourceId: 'renamed/parent:1',
      },
      ...children.map((child) => ({
        taskId: child.id,
        legacySourceId: child.sourceId,
        stableId: child.stableId,
      })),
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observations = new Map(children.map((child) => [
      child.sourceId,
      relationship(
        connectorId,
        child.sourceId,
        child.stableId,
        'renamed/parent:1',
        'I_parent',
      ),
    ]));
    const parentObservation = noParent(
      connectorId,
      'renamed/parent:1',
      'I_parent',
    );
    observations.set(parentObservation.childSourceId, parentObservation);

    const result = await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      observations,
      new Set(['acme/app', 'legacy/parent']),
      true,
      new Map([['legacy/parent', 'renamed/parent']]),
      { identityComparison: runtime },
    );
    runtime.complete('succeeded');

    expect(result).toEqual({ applied: true, updated: 56 });
    const records = dbModule.sqlite.prepare(`
      SELECT candidate_key AS candidateKey, outcome
      FROM github_identity_comparison_records
      WHERE run_id = ? AND surface = 'sub_issue'
    `).all(runtime.runId) as Array<{ candidateKey: string; outcome: string }>;
    expect(records).toHaveLength(111);
    expect(records.every((record) =>
      record.outcome === 'agreement' || record.outcome === 'locator_change')).toBe(true);
    const run = dbModule.sqlite.prepare(`
      SELECT query_count AS queryCount, evidence_eligible AS evidenceEligible
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId) as { queryCount: number; evidenceEligible: number };
    expect(run).toEqual({ queryCount: 1, evidenceEligible: 1 });

    const status = identity.getGitHubIdentityComparisonStatus(connectorId) as {
      coverage: {
        uncoveredGates: string[];
        subIssueIdentity: {
          covered: boolean;
          endpointCount: number;
          childEndpointCount: number;
          parentEndpointCount: number;
        };
      };
    };
    expect(status.coverage.uncoveredGates).toEqual([]);
    expect(status.coverage.subIssueIdentity).toMatchObject({
      covered: true,
      endpointCount: 111,
      childEndpointCount: 56,
      parentEndpointCount: 55,
    });
  });

  it('proves every synchronized child while requiring parent evidence only for actual relationships', async () => {
    const connectorId = 'hierarchy-asymmetric-cardinality';
    await setupConnector(connectorId);
    const issues = [
      { id: 'shared-parent', sourceId: 'acme/app:1', stableId: 'I_shared_parent' },
      { id: 'parented-one', sourceId: 'acme/app:2', stableId: 'I_parented_one' },
      { id: 'parented-two', sourceId: 'acme/app:3', stableId: 'I_parented_two' },
      { id: 'ordinary', sourceId: 'acme/app:4', stableId: 'I_ordinary' },
      { id: 'removed-parent', sourceId: 'acme/app:5', stableId: 'I_removed_parent' },
    ];
    for (const issue of issues) {
      await insertTask(
        connectorId,
        issue.id,
        issue.sourceId,
        issue.id === 'removed-parent' ? 'shared-parent' : undefined,
      );
    }
    bindTasks(connectorId, issues.map((issue) => ({
      taskId: issue.id,
      legacySourceId: issue.sourceId,
      stableId: issue.stableId,
    })));
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observations = new Map<string, GitHubHierarchyObservation>([
      ['acme/app:1', noParent(connectorId, 'acme/app:1', 'I_shared_parent')],
      ['acme/app:2', relationship(
        connectorId,
        'acme/app:2',
        'I_parented_one',
        'acme/app:1',
        'I_shared_parent',
      )],
      ['acme/app:3', relationship(
        connectorId,
        'acme/app:3',
        'I_parented_two',
        'acme/app:1',
        'I_shared_parent',
      )],
      ['acme/app:4', noParent(connectorId, 'acme/app:4', 'I_ordinary')],
      ['acme/app:5', noParent(connectorId, 'acme/app:5', 'I_removed_parent')],
    ]);

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      observations,
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: true, updated: 5 });
    runtime.complete('succeeded');

    const run = dbModule.sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_expected_child_count AS expectedChildCount,
        sub_issue_expected_parent_count AS expectedParentCount
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId);
    expect(run).toEqual({
      generationComplete: 1,
      expectedChildCount: 5,
      expectedParentCount: 2,
    });
    expect(dbModule.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM github_identity_comparison_records
      WHERE run_id = ? AND surface = 'sub_issue'
    `).get(runtime.runId)).toEqual({ count: 7 });
    const status = identity.getGitHubIdentityComparisonStatus(connectorId) as {
      coverage: {
        subIssueIdentity: {
          covered: boolean;
          endpointCount: number;
          childEndpointCount: number;
          parentEndpointCount: number;
          expectedChildCount: number;
          expectedParentCount: number;
        };
      };
    };
    expect(status.coverage.subIssueIdentity).toMatchObject({
      covered: true,
      endpointCount: 7,
      childEndpointCount: 5,
      parentEndpointCount: 2,
      expectedChildCount: 5,
      expectedParentCount: 2,
    });
    const [removed] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'removed-parent'));
    expect(removed.parentId).toBeNull();
  });

  it('freezes only authoritative connector-native tasks across drafts, checklists, and recreation', async () => {
    const connectorId = 'hierarchy-authoritative-population';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'deleted-task', 'acme/app:1');
    await dbModule.default.delete(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'deleted-task'));
    await insertTask(connectorId, 'recreated-task', 'acme/app:1');
    await insertTask(connectorId, 'project-draft', 'acme/app:2', undefined, {
      metadata: { issueNumber: 2, isProjectDraft: true },
    });
    await insertTask(connectorId, 'draft', 'acme/app:3', undefined, {
      metadata: { issueNumber: 3, isDraft: true },
    });
    await insertTask(connectorId, 'checklist', 'acme/app:5', undefined, {
      isChecklistItem: true,
      metadata: {},
    });
    await insertTask(connectorId, 'non-native', 'opaque-source', undefined, {
      metadata: {},
    });
    await insertTask(connectorId, 'partial-identity', 'acme/app:4', undefined, {
      metadata: {},
    });
    bindTasks(connectorId, [
      {
        taskId: 'recreated-task',
        legacySourceId: 'acme/app:1',
        stableId: 'I_recreated',
      },
      {
        taskId: 'partial-identity',
        legacySourceId: 'acme/app:4',
        stableId: 'I_partial',
      },
      {
        taskId: 'checklist',
        legacySourceId: 'acme/app:5',
        stableId: 'I_checklist',
      },
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'acme/app:1',
      'I_recreated',
      'acme/app:4',
      'I_partial',
    );
    delete observation.parentIdentityEvidence;
    const excludedObservations = [
      noParent(connectorId, 'acme/app:4', 'I_partial'),
      noParent(connectorId, 'acme/app:5', 'I_checklist'),
    ];

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        [observation.childSourceId, observation],
        ...excludedObservations.map((excluded) =>
          [excluded.childSourceId, excluded] as const),
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: true, updated: 1 });
    runtime.complete('succeeded');

    expect(dbModule.sqlite.prepare(`
      SELECT local_task_id AS localTaskId, observed
      FROM github_identity_sub_issue_population_members
      WHERE run_id = ?
    `).all(runtime.runId)).toEqual([{
      localTaskId: 'recreated-task',
      observed: 1,
    }]);
    expect(dbModule.sqlite.prepare(`
      SELECT
        sub_issue_population_count AS populationCount,
        sub_issue_observed_child_count AS observedCount,
        sub_issue_expected_parent_count AS expectedParentCount,
        sub_issue_population_digest = sub_issue_observed_child_digest AS digestsMatch
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({
      populationCount: 1,
      observedCount: 1,
      expectedParentCount: 0,
      digestsMatch: 1,
    });
    expect(dbModule.sqlite.prepare(`
      SELECT candidate_key AS candidateKey, outcome
      FROM github_identity_comparison_records
      WHERE run_id = ? AND surface = 'sub_issue'
    `).all(runtime.runId)).toEqual([{
      candidateKey: 'sub_issue:acme/app:1:child',
      outcome: 'agreement',
    }]);
    expect(dbModule.sqlite.prepare(`
      SELECT evidence_eligible AS evidenceEligible, error_code AS errorCode
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({
      evidenceEligible: 1,
      errorCode: null,
    });
  });

  it('freezes hierarchy population only for configured repositories', async () => {
    const connectorId = 'hierarchy-configured-scope';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'configured-task', 'acme/app:1');
    await insertTask(connectorId, 'deselected-task', 'retired/repo:2');
    bindTasks(connectorId, [
      {
        taskId: 'configured-task',
        legacySourceId: 'acme/app:1',
        stableId: 'I_configured',
      },
      {
        taskId: 'deselected-task',
        legacySourceId: 'retired/repo:2',
        stableId: 'I_deselected',
      },
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const configuredObservation = noParent(
      connectorId,
      'acme/app:1',
      'I_configured',
    );

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([[configuredObservation.childSourceId, configuredObservation]]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: true, updated: 1 });
    runtime.complete('succeeded');

    expect(dbModule.sqlite.prepare(`
      SELECT local_task_id AS localTaskId, observed
      FROM github_identity_sub_issue_population_members
      WHERE run_id = ?
    `).all(runtime.runId)).toEqual([{
      localTaskId: 'configured-task',
      observed: 1,
    }]);
    expect(dbModule.sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_population_count AS populationCount,
        sub_issue_observed_child_count AS observedCount
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({
      generationComplete: 1,
      populationCount: 1,
      observedCount: 1,
    });
  });

  it('excludes an unobserved accepted terminal task but keeps other selected tasks fail-closed', async () => {
    const connectorId = 'hierarchy-terminal-inaccessible';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'observed-task', 'acme/app:1');
    await insertTask(connectorId, 'accepted-terminal', 'acme/app:2', undefined, {
      status: 'cancelled',
    });
    await insertTask(connectorId, 'missing-task', 'acme/app:3');
    bindTasks(connectorId, [
      {
        taskId: 'observed-task',
        legacySourceId: 'acme/app:1',
        stableId: 'I_observed',
      },
      {
        taskId: 'missing-task',
        legacySourceId: 'acme/app:3',
        stableId: 'I_missing',
      },
    ]);
    await dbModule.default.insert(schema.githubIdentityBackfillItems).values({
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: 'accepted-terminal',
      state: 'inaccessible',
      attemptCount: 1,
      observedAt: now,
      updatedAt: now,
    });
    identity.recordGitHubIdentityException({
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: 'accepted-terminal',
      category: 'terminal_inaccessible',
      action: 'accept',
      actor: 'test-operator',
      reason: 'Authoritative inaccessible terminal record',
      idempotencyKey: 'hierarchy-terminal-acceptance',
      now,
    });
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observed = noParent(connectorId, 'acme/app:1', 'I_observed');

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([[observed.childSourceId, observed]]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: false, updated: 0 });
    runtime.complete('succeeded');

    expect(dbModule.sqlite.prepare(`
      SELECT local_task_id AS localTaskId, observed
      FROM github_identity_sub_issue_population_members
      WHERE run_id = ?
      ORDER BY local_task_id
    `).all(runtime.runId)).toEqual([
      { localTaskId: 'missing-task', observed: 0 },
      { localTaskId: 'observed-task', observed: 1 },
    ]);
    expect(dbModule.sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_population_count AS populationCount,
        sub_issue_observed_child_count AS observedCount,
        evidence_eligible AS evidenceEligible,
        error_code AS errorCode
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({
      generationComplete: 0,
      populationCount: 2,
      observedCount: 1,
      evidenceEligible: 0,
      errorCode: 'sub_issue_generation_incomplete',
    });
  });

  it('attests a proven historical transfer only while its exact successor is bound and observed', async () => {
    const connectorId = 'hierarchy-historical-transfer';
    await setupConnector(connectorId, 4);
    await insertTask(connectorId, 'historical-source', 'octo-org/tyrion:135', undefined, {
      status: 'cancelled',
    });
    await insertTask(connectorId, 'historical-successor', 'octo-org/mission-control:2402', undefined, {
      status: 'done',
    });
    bindTasks(connectorId, [
      {
        taskId: 'historical-source',
        legacySourceId: 'octo-org/tyrion:135',
        stableId: 'I_kwDOTx0z_s8AAAABMEm6Ww',
      },
      {
        taskId: 'historical-successor',
        legacySourceId: 'octo-org/mission-control:2402',
        stableId: 'I_kwDOTWhjas8AAAABMFO0qg',
      },
    ]);
    recordHistoricalTransfer(
      connectorId,
      'historical-source',
      'historical-successor',
      'hierarchy-historical-transfer-proof',
    );
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const successor = noParent(
      connectorId,
      'octo-org/mission-control:2402',
      'I_kwDOTWhjas8AAAABMFO0qg',
    );

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([[successor.childSourceId, successor]]),
      new Set(['octo-org/tyrion', 'octo-org/mission-control']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: true, updated: 1 });
    runtime.complete('succeeded');

    expect(dbModule.sqlite.prepare(`
      SELECT local_task_id AS localTaskId, observed
      FROM github_identity_sub_issue_population_members
      WHERE run_id = ?
    `).all(runtime.runId)).toEqual([{
      localTaskId: 'historical-successor',
      observed: 1,
    }]);
    expect(dbModule.sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_population_count AS populationCount,
        sub_issue_observed_child_count AS observedCount
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({
      generationComplete: 1,
      populationCount: 1,
      observedCount: 1,
    });
  });

  it('keeps a reconciled historical task fail-closed when the successor binding collides', async () => {
    const connectorId = 'hierarchy-historical-transfer-collision';
    await setupConnector(connectorId, 4);
    await insertTask(connectorId, 'collision-source', 'octo-org/tyrion:135', undefined, {
      status: 'cancelled',
    });
    await insertTask(connectorId, 'collision-successor', 'octo-org/mission-control:2402', undefined, {
      status: 'done',
    });
    bindTasks(connectorId, [
      {
        taskId: 'collision-source',
        legacySourceId: 'octo-org/tyrion:135',
        stableId: 'I_old_collision',
      },
      {
        taskId: 'collision-successor',
        legacySourceId: 'octo-org/mission-control:2402',
        stableId: 'I_successor_collision',
      },
    ]);
    recordHistoricalTransfer(
      connectorId,
      'collision-source',
      'collision-successor',
      'hierarchy-historical-collision-proof',
      'I_successor_collision',
    );
    const successorBinding = await dbModule.default.select()
      .from(schema.externalEntityBindings)
      .where((await import('drizzle-orm')).and(
        (await import('drizzle-orm')).eq(
          schema.externalEntityBindings.connectorInstanceId,
          connectorId,
        ),
        (await import('drizzle-orm')).eq(
          schema.externalEntityBindings.localId,
          'collision-successor',
        ),
      )).get();
    await dbModule.default.update(schema.externalEntityBindings).set({
      state: 'collision',
      updatedAt: '2026-08-10T00:01:00.000Z',
    }).where((await import('drizzle-orm')).eq(
      schema.externalEntityBindings.id,
      successorBinding!.id,
    ));
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const successor = noParent(
      connectorId,
      'octo-org/mission-control:2402',
      'I_successor_collision',
    );

    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([[successor.childSourceId, successor]]),
      new Set(['octo-org/tyrion', 'octo-org/mission-control']),
      true,
      new Map(),
      { identityComparison: runtime },
    )).toEqual({ applied: false, updated: 0 });
    runtime.complete('succeeded');

    expect(dbModule.sqlite.prepare(`
      SELECT local_task_id AS localTaskId, observed
      FROM github_identity_sub_issue_population_members
      WHERE run_id = ?
      ORDER BY local_task_id
    `).all(runtime.runId)).toEqual([
      { localTaskId: 'collision-source', observed: 0 },
      { localTaskId: 'collision-successor', observed: 1 },
    ]);
  });

  it('keeps legacy hierarchy authoritative while missing parent evidence makes the run ineligible', async () => {
    const connectorId = 'hierarchy-missing-evidence';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'missing-parent', 'acme/app:1');
    await insertTask(connectorId, 'missing-child', 'acme/app:2');
    bindTasks(connectorId, [
      { taskId: 'missing-parent', legacySourceId: 'acme/app:1', stableId: 'I_missing_parent' },
      { taskId: 'missing-child', legacySourceId: 'acme/app:2', stableId: 'I_missing_child' },
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'acme/app:2',
      'I_missing_child',
      'acme/app:1',
      'I_missing_parent',
    );
    delete observation.parentIdentityEvidence;
    const parentObservation = noParent(
      connectorId,
      'acme/app:1',
      'I_missing_parent',
    );

    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        [observation.childSourceId, observation],
        [parentObservation.childSourceId, parentObservation],
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    );
    runtime.complete('succeeded');

    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'missing-child'));
    expect(child.parentId).toBe('missing-parent');
    const run = dbModule.sqlite.prepare(`
      SELECT evidence_eligible AS evidenceEligible, error_code AS errorCode
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId) as { evidenceEligible: number; errorCode: string };
    expect(run).toEqual({
      evidenceEligible: 0,
      errorCode: 'sub_issue_parent_identity_missing',
    });
  });

  it('does not detach a known-good parent for an unresolved unconfigured parent', async () => {
    const connectorId = 'hierarchy-unconfigured';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'known-parent', 'acme/app:1');
    await insertTask(connectorId, 'known-child', 'acme/app:2', 'known-parent');
    bindTasks(connectorId, [
      { taskId: 'known-parent', legacySourceId: 'acme/app:1', stableId: 'I_known_parent' },
      { taskId: 'known-child', legacySourceId: 'acme/app:2', stableId: 'I_known_child' },
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'acme/app:2',
      'I_known_child',
      'private/repo:9',
      'I_private_parent',
    );
    const knownParentObservation = noParent(
      connectorId,
      'acme/app:1',
      'I_known_parent',
    );

    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        [observation.childSourceId, observation],
        [knownParentObservation.childSourceId, knownParentObservation],
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    );
    runtime.complete('succeeded');

    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'known-child'));
    expect(child.parentId).toBe('known-parent');
    const run = dbModule.sqlite.prepare(`
      SELECT evidence_eligible AS evidenceEligible, error_code AS errorCode
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId) as { evidenceEligible: number; errorCode: string };
    expect(run).toEqual({
      evidenceEligible: 1,
      errorCode: null,
    });
  });

  it('fences partial generations and mode-revision drift without applying stale observations', async () => {
    const partialConnector = 'hierarchy-partial';
    await setupConnector(partialConnector);
    await insertTask(partialConnector, 'partial-parent', 'acme/app:1');
    await insertTask(partialConnector, 'partial-child', 'acme/app:2');
    bindTasks(partialConnector, [
      { taskId: 'partial-parent', legacySourceId: 'acme/app:1', stableId: 'I_partial_parent' },
      { taskId: 'partial-child', legacySourceId: 'acme/app:2', stableId: 'I_partial_child' },
    ]);
    const partialRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: partialConnector,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(partialConnector),
      syncKind: 'full',
    });
    const partialObservation = relationship(
      partialConnector,
      'acme/app:2',
      'I_partial_child',
      'acme/app:1',
      'I_partial_parent',
    );
    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      partialConnector,
      new Map([[partialObservation.childSourceId, partialObservation]]),
      new Set(['acme/app']),
      false,
      new Map(),
      { identityComparison: partialRuntime },
    )).toEqual({ applied: false, updated: 0 });
    partialRuntime.complete('succeeded');
    expect(dbModule.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM github_identity_comparison_records
      WHERE run_id = ? AND surface = 'sub_issue'
    `).get(partialRuntime.runId)).toEqual({ count: 0 });
    expect(dbModule.sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_expected_child_count AS expectedChildCount,
        sub_issue_expected_parent_count AS expectedParentCount
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(partialRuntime.runId)).toEqual({
      generationComplete: 0,
      expectedChildCount: 2,
      expectedParentCount: 1,
    });

    const driftConnector = 'hierarchy-drift';
    await setupConnector(driftConnector);
    await insertTask(driftConnector, 'drift-parent', 'acme/app:1');
    await insertTask(driftConnector, 'drift-child', 'acme/app:2');
    bindTasks(driftConnector, [
      { taskId: 'drift-parent', legacySourceId: 'acme/app:1', stableId: 'I_drift_parent' },
      { taskId: 'drift-child', legacySourceId: 'acme/app:2', stableId: 'I_drift_child' },
    ]);
    const driftRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: driftConnector,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(driftConnector),
      syncKind: 'full',
    });
    await dbModule.default.update(schema.githubIdentityControls).set({
      modeRevision: 4,
      updatedAt: '2026-08-10T00:01:00.000Z',
    }).where((await import('drizzle-orm')).eq(
      schema.githubIdentityControls.connectorInstanceId,
      driftConnector,
    ));
    const driftObservation = relationship(
      driftConnector,
      'acme/app:2',
      'I_drift_child',
      'acme/app:1',
      'I_drift_parent',
    );
    expect(await hierarchy.reconcileGitHubTaskHierarchy(
      driftConnector,
      new Map([[driftObservation.childSourceId, driftObservation]]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: driftRuntime },
    )).toEqual({ applied: false, updated: 0 });
    driftRuntime.complete('succeeded');
    const [driftChild] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'drift-child'));
    expect(driftChild.parentId).toBeNull();
  });

  it('prevents an interrupted comparison runtime from applying after restart overlap', async () => {
    const connectorId = 'hierarchy-overlap';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'overlap-parent', 'acme/app:1');
    await insertTask(connectorId, 'overlap-child', 'acme/app:2');
    bindTasks(connectorId, [
      { taskId: 'overlap-parent', legacySourceId: 'acme/app:1', stableId: 'I_overlap_parent' },
      { taskId: 'overlap-child', legacySourceId: 'acme/app:2', stableId: 'I_overlap_child' },
    ]);
    const modeSnapshot = identity.getGitHubIdentityModeSnapshot(connectorId);
    const interrupted = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot,
      syncKind: 'full',
    });
    await dbModule.default.update(schema.githubIdentityComparisonRuns).set({
      ownerLeaseExpiresAt: '2026-08-09T23:59:59.000Z',
    }).where((await import('drizzle-orm')).eq(
      schema.githubIdentityComparisonRuns.id,
      interrupted.runId,
    ));
    const replacement = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot,
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'acme/app:2',
      'I_overlap_child',
      'acme/app:1',
      'I_overlap_parent',
    );

    await expect(hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([[observation.childSourceId, observation]]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: interrupted },
    )).rejects.toThrow('is not running');
    replacement.complete('cancelled', 'test_overlap');
    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'overlap-child'));
    expect(child.parentId).toBeNull();
  });

  it('marks complete-population collisions blocking without changing the legacy relationship decision', async () => {
    const connectorId = 'hierarchy-disagreement';
    await setupConnector(connectorId);
    await insertTask(connectorId, 'disagree-parent', 'acme/app:1');
    await insertTask(connectorId, 'disagree-child', 'acme/app:2');
    await insertTask(connectorId, 'stable-other', 'acme/app:3');
    bindTasks(connectorId, [
      { taskId: 'disagree-parent', legacySourceId: 'acme/app:1', stableId: 'I_disagree_parent' },
      { taskId: 'disagree-child', legacySourceId: 'acme/app:2', stableId: 'I_real_child' },
      { taskId: 'stable-other', legacySourceId: 'acme/app:3', stableId: 'I_wrong_child' },
    ]);
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const observation = relationship(
      connectorId,
      'acme/app:2',
      'I_wrong_child',
      'acme/app:1',
      'I_disagree_parent',
    );
    const disagreementRoots = [
      noParent(connectorId, 'acme/app:1', 'I_disagree_parent'),
      noParent(connectorId, 'acme/app:3', 'I_wrong_child'),
    ];

    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      new Map([
        [observation.childSourceId, observation],
        ...disagreementRoots.map((root) => [root.childSourceId, root] as const),
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: runtime },
    );
    runtime.complete('succeeded');

    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'disagree-child'));
    expect(child.parentId).toBe('disagree-parent');
    expect(dbModule.sqlite.prepare(`
      SELECT outcome
      FROM github_identity_comparison_records
      WHERE run_id = ? AND candidate_key = 'sub_issue:acme/app:2:child'
    `).get(runtime.runId)).toEqual({ outcome: 'collision' });
    expect(dbModule.sqlite.prepare(`
      SELECT evidence_eligible AS evidenceEligible
      FROM github_identity_comparison_runs
      WHERE id = ?
    `).get(runtime.runId)).toEqual({ evidenceEligible: 0 });
  });

  it('records stable disagreement and collision evidence without selecting a stable parent', async () => {
    const disagreementConnector = 'hierarchy-disagreement-only';
    await setupConnector(disagreementConnector);
    await insertTask(disagreementConnector, 'only-parent', 'acme/app:1');
    await insertTask(disagreementConnector, 'only-child', 'acme/app:2');
    await insertTask(disagreementConnector, 'only-other', 'acme/app:3');
    bindTasks(disagreementConnector, [
      { taskId: 'only-parent', legacySourceId: 'acme/app:1', stableId: 'I_only_parent' },
      { taskId: 'only-other', legacySourceId: 'acme/app:3', stableId: 'I_only_other' },
    ]);
    const disagreementRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: disagreementConnector,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(disagreementConnector),
      syncKind: 'full',
    });
    const disagreementObservation = relationship(
      disagreementConnector,
      'acme/app:2',
      'I_only_other',
      'acme/app:1',
      'I_only_parent',
    );
    disagreementObservation.childIdentityEvidence = evidence(
      'I_only_other',
      'acme/app:3',
      `${disagreementConnector}.github.test`,
    );
    const disagreementRootObservations = [
      noParent(disagreementConnector, 'acme/app:1', 'I_only_parent'),
      noParent(disagreementConnector, 'acme/app:3', 'I_only_other'),
    ];
    await hierarchy.reconcileGitHubTaskHierarchy(
      disagreementConnector,
      new Map([
        [disagreementObservation.childSourceId, disagreementObservation],
        ...disagreementRootObservations.map((root) =>
          [root.childSourceId, root] as const),
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: disagreementRuntime },
    );
    disagreementRuntime.complete('succeeded');
    expect(dbModule.sqlite.prepare(`
      SELECT outcome
      FROM github_identity_comparison_records
      WHERE run_id = ? AND candidate_key = 'sub_issue:acme/app:2:child'
    `).get(disagreementRuntime.runId)).toEqual({
      outcome: 'stable_legacy_disagree',
    });

    const collisionConnector = 'hierarchy-collision';
    await setupConnector(collisionConnector);
    await insertTask(collisionConnector, 'collision-parent', 'acme/app:1');
    await insertTask(collisionConnector, 'collision-child', 'acme/app:2');
    await insertTask(collisionConnector, 'collision-other', 'acme/app:3');
    bindTasks(collisionConnector, [
      { taskId: 'collision-parent', legacySourceId: 'acme/app:1', stableId: 'I_collision_parent' },
      { taskId: 'collision-child', legacySourceId: 'acme/app:2', stableId: 'I_collision_child' },
      { taskId: 'collision-other', legacySourceId: 'acme/app:3', stableId: 'I_collision_child' },
    ]);
    const collisionRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: collisionConnector,
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(collisionConnector),
      syncKind: 'full',
    });
    const collisionObservation = relationship(
      collisionConnector,
      'acme/app:2',
      'I_collision_child',
      'acme/app:1',
      'I_collision_parent',
    );
    const collisionRootObservations = [
      noParent(collisionConnector, 'acme/app:1', 'I_collision_parent'),
      noParent(collisionConnector, 'acme/app:3', 'I_collision_child'),
    ];
    await hierarchy.reconcileGitHubTaskHierarchy(
      collisionConnector,
      new Map([
        [collisionObservation.childSourceId, collisionObservation],
        ...collisionRootObservations.map((root) => [root.childSourceId, root] as const),
      ]),
      new Set(['acme/app']),
      true,
      new Map(),
      { identityComparison: collisionRuntime },
    );
    collisionRuntime.complete('succeeded');
    expect(dbModule.sqlite.prepare(`
      SELECT outcome
      FROM github_identity_comparison_records
      WHERE run_id = ? AND candidate_key = 'sub_issue:acme/app:2:child'
    `).get(collisionRuntime.runId)).toEqual({ outcome: 'collision' });
    const [collisionChild] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'collision-child'));
    expect(collisionChild.parentId).toBe('collision-parent');
  });
});
