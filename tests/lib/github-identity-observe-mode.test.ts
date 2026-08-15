import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assertCompleteGitHubProjectAssociations,
  compareGitHubProjectAssociations,
  resolveGitHubProjectIdentityDigest,
} from '@/lib/sync/github-project-association-identity';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-identity-observe-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

const now = '2026-08-10T08:00:00.000Z';
let nextBoundIssueNumber = 1000;

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  identity = await import('@/lib/external-identities');
  database.default.insert(schema.connectorConfigs).values([
    connector('observe-a', ['owner/repo']),
    connector('observe-b', ['owner/repo']),
  ]).run();
  database.default.insert(schema.githubIdentityMigrations).values([
    { connectorInstanceId: 'observe-a', phase: 'comparing', updatedAt: now },
    { connectorInstanceId: 'observe-b', phase: 'comparing', updatedAt: now },
  ]).run();
  database.default.insert(schema.githubIdentityControls).values([
    {
      connectorInstanceId: 'observe-a',
      stablePrimaryEnabled: false,
      modeRevision: 3,
      updatedAt: now,
    },
    {
      connectorInstanceId: 'observe-b',
      stablePrimaryEnabled: false,
      modeRevision: 1,
      updatedAt: now,
    },
  ]).run();
  database.default.insert(schema.sourceLists).values({
    id: 'observe-a-list',
    connectorInstanceId: 'observe-a',
    sourceId: 'owner/repo',
    name: 'owner/repo',
    type: 'repo',
  }).run();
  database.default.insert(schema.tasks).values([
    taskRow('observe-a', 'task-bound', 'owner/repo:1', 'todo'),
    taskRow('observe-a', 'task-terminal', 'owner/repo:410', 'cancelled'),
    taskRow('observe-a', 'task-unexplained', 'owner/repo:411', 'todo'),
    taskRow('observe-b', 'task-other', 'owner/repo:1', 'todo'),
  ]).run();
  identity.persistExternalIdentityBatch([
    identityWrite('observe-a', 'task-bound', 'I_bound'),
    repositoryIdentityWrite('observe-a', 'observe-a-list', 'R_github.com'),
  ], 'comparing');
  identity.persistExternalIdentityBatch([
    identityWrite('observe-b', 'task-other', 'I_bound'),
  ], 'comparing');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub stable comparison lookup', () => {
  it('resolves one indexed connector-scoped batch without exposing raw IDs', () => {
    const result = identity.resolveGitHubStableIdentityBatch('observe-a', [{
      candidateKey: 'owner/repo:1',
      bindingType: 'task',
      evidence: issueEvidence('I_bound'),
    }, {
      candidateKey: 'owner/repo:2',
      bindingType: 'task',
      evidence: issueEvidence('I_missing', 2),
    }]);

    expect(result.queryCount).toBe(1);
    expect(result.resolutions.get('owner/repo:1')).toMatchObject({
      selectedLocalIds: ['task-bound'],
      evidence: 'verified',
      action: 'update',
    });
    expect(result.resolutions.get('owner/repo:2')).toMatchObject({
      selectedLocalIds: [],
      evidence: 'verified',
      action: 'create',
    });
    expect(result.resolutions.get('owner/repo:1')?.stableIdDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.resolutions.get('owner/repo:1'))).not.toContain('I_bound');
  });

  it('isolates identical stable IDs by connector and host and enforces batch bounds', () => {
    expect(identity.resolveGitHubStableIdentityBatch('observe-b', [{
      candidateKey: 'other-connector',
      bindingType: 'task',
      evidence: issueEvidence('I_bound'),
    }]).resolutions.get('other-connector')?.selectedLocalIds).toEqual(['task-other']);

    expect(identity.resolveGitHubStableIdentityBatch('observe-a', [{
      candidateKey: 'enterprise-host',
      bindingType: 'task',
      evidence: issueEvidence('I_bound', 1, 'github.example.com'),
    }]).resolutions.get('enterprise-host')).toMatchObject({
      selectedLocalIds: [],
      action: 'create',
    });

    expect(() => identity.resolveGitHubStableIdentityBatch(
      'observe-a',
      Array.from({ length: 501 }, (_, index) => ({
        candidateKey: `candidate-${index}`,
        bindingType: 'task' as const,
      })),
    )).toThrow('maximum of 500');
  });

  it('ignores orphaned source-list bindings but preserves their collision state', () => {
    const listId = 'observe-a-orphan-list';
    const write = repositoryIdentityWrite(
      'observe-a',
      listId,
      'R_orphan_source_list',
      'orphan-repo',
    );
    database.default.insert(schema.sourceLists).values({
      id: listId,
      connectorInstanceId: 'observe-a',
      sourceId: 'owner/orphan-repo',
      name: 'owner/orphan-repo',
      type: 'repo',
    }).run();
    identity.persistExternalIdentityBatch([write], 'comparing');
    database.default.delete(schema.sourceLists).where(
      eq(schema.sourceLists.id, listId),
    ).run();

    const resolved = identity.resolveGitHubStableIdentityBatch('observe-a', [{
      candidateKey: 'owner/orphan-repo',
      bindingType: 'source_list',
      evidence: write.evidence,
    }]).resolutions.get('owner/orphan-repo');
    expect(resolved).toMatchObject({
      selectedLocalIds: [],
      evidence: 'verified',
      action: 'create',
    });

    database.default.update(schema.externalEntityBindings).set({
      state: 'collision',
    }).where(eq(schema.externalEntityBindings.localId, listId)).run();
    expect(identity.resolveGitHubStableIdentityBatch('observe-a', [{
      candidateKey: 'owner/orphan-repo',
      bindingType: 'source_list',
      evidence: write.evidence,
    }]).resolutions.get('owner/orphan-repo')).toMatchObject({
      selectedLocalIds: [],
      evidence: 'collision',
    });
    database.default.update(schema.externalEntityBindings).set({
      state: 'shadow',
    }).where(eq(schema.externalEntityBindings.localId, listId)).run();
  });

  it('can resolve task bindings against a frozen applicable-local snapshot', () => {
    const taskId = 'observe-a-frozen-task';
    database.default.insert(schema.tasks).values(
      taskRow('observe-a', taskId, 'owner/repo:777', 'todo'),
    ).run();
    identity.persistExternalIdentityBatch([
      identityWrite('observe-a', taskId, 'I_frozen_task', 777),
    ], 'comparing');
    const applicableLocalIds = new Set([taskId]);
    database.default.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();

    const candidate = {
      candidateKey: 'owner/repo:777',
      bindingType: 'task' as const,
      evidence: issueEvidence('I_frozen_task', 777),
    };
    expect(identity.resolveGitHubStableIdentityBatch('observe-a', [{
      ...candidate,
      applicableLocalIds,
    }]).resolutions.get(candidate.candidateKey)).toMatchObject({
      selectedLocalIds: [taskId],
      evidence: 'verified',
      action: 'update',
    });
    expect(identity.resolveGitHubStableIdentityBatch('observe-a', [candidate])
      .resolutions.get(candidate.candidateKey)).toMatchObject({
      selectedLocalIds: [],
      evidence: 'verified',
      action: 'create',
    });
  });
});

describe('GitHub comparison runtime', () => {
  it('emits project-scoped agreements when one issue belongs to several projects', () => {
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-project-memberships',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const evidence = issueEvidence('I_bound');
    const projectIdentity = compareGitHubProjectAssociations(
      runtime,
      [17, 18, 19, 21].map((number) => ({
        project: { id: `P_${number}`, number },
        taskSourceIds: ['owner/repo:1', 'owner/repo:1'],
        taskIdentityEvidence: [
          { sourceId: 'owner/repo:1', evidence },
          { sourceId: 'owner/repo:1', evidence },
        ],
      })),
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    );
    runtime.observeDeduplicatedBatch('sub_issue', 'task', [{
      candidateKey: 'sub-issue:owner/repo:1',
      legacySelectedLocalIds: ['task-bound'],
      legacyAction: 'present',
      applicableStableLocalIds: new Set(['task-bound']),
      evidence,
      localTaskId: 'task-bound',
    }]);
    runtime.complete('succeeded');

    expect(projectIdentity.decisions).toHaveLength(4);
    expect(projectIdentity.decisions).toEqual(expect.arrayContaining(
      [17, 18, 19, 21].map((number) => expect.objectContaining({
        candidateKey: `project:${number}:owner/repo:1`,
        surface: 'project_association',
        legacySelectedLocalId: 'task-bound',
        stableSelectedLocalId: 'task-bound',
        outcome: 'agreement',
        appliedSource: 'legacy',
      })),
    ));
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get()).toMatchObject({
      state: 'succeeded',
      evidenceEligible: true,
      queryCount: 2,
      outcomeCounts: { agreement: 5 },
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.runId, runtime.runId)).all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: 'sub_issue', outcome: 'agreement' }),
      ]));
  });

  it('keeps project association duplicates and conflicting evidence blocking', () => {
    const genericLookup = identity.resolveGitHubStableIdentityBatch('observe-a', [{
      candidateKey: 'generic:first',
      bindingType: 'task',
      evidence: issueEvidence('I_bound'),
    }, {
      candidateKey: 'generic:second',
      bindingType: 'task',
      evidence: issueEvidence('I_bound'),
    }]);
    expect(genericLookup.resolutions.get('generic:first')).toMatchObject({
      evidence: 'collision',
    });
    expect(genericLookup.resolutions.get('generic:second')).toMatchObject({
      evidence: 'collision',
    });

    const duplicateRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-duplicate-project-membership',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const duplicateAssociation = {
      project: { id: 'P_17', number: 17 },
      taskSourceIds: ['owner/repo:1'],
      taskIdentityEvidence: [{
        sourceId: 'owner/repo:1',
        evidence: issueEvidence('I_bound'),
      }],
    };
    expect(() => compareGitHubProjectAssociations(
      duplicateRuntime,
      [duplicateAssociation, duplicateAssociation],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    )).toThrow('multiple association rows');
    duplicateRuntime.complete('failed', 'duplicate_project_association');

    const evidenceRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-conflicting-project-evidence',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    expect(() => compareGitHubProjectAssociations(
      evidenceRuntime,
      [{
        project: { id: 'P_18', number: 18 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_bound'),
        }, {
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_other'),
        }],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    )).toThrow('conflicting stable evidence');
    evidenceRuntime.complete('failed', 'conflicting_project_association_evidence');

    const sourceConflictRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-cross-project-source-conflict',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    expect(() => compareGitHubProjectAssociations(
      sourceConflictRuntime,
      [{
        project: { id: 'P_19', number: 19 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_bound'),
        }],
      }, {
        project: { id: 'P_20', number: 20 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_other'),
        }],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    )).toThrow('conflicting stable evidence');
    sourceConflictRuntime.complete('failed', 'cross_project_source_identity_conflict');
  });

  it('rejects partial, inaccessible, and unspecified project membership observations', () => {
    for (const membershipState of ['partial', 'inaccessible', undefined] as const) {
      expect(() => assertCompleteGitHubProjectAssociations([{
        project: { id: 'P_17', number: 17 },
        membershipState,
        taskSourceIds: [],
      }])).toThrow(`membership observation is ${membershipState ?? 'unknown'}`);
    }
    expect(() => assertCompleteGitHubProjectAssociations([{
      project: { id: 'P_17', number: 17 },
      membershipState: 'complete',
      taskSourceIds: [],
    }])).not.toThrow();
  });

  it('keeps project identity stable across rename and rejects project-number reuse', () => {
    const project = { id: 'P_stable_project', number: 17 };
    const digest = resolveGitHubProjectIdentityDigest(project);
    expect(resolveGitHubProjectIdentityDigest(project, digest)).toBe(digest);
    expect(() => resolveGitHubProjectIdentityDigest(
      { id: 'P_replacement_project', number: 17 },
      digest,
    )).toThrow('stable identity does not match its Hub Project');

    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-project-number-reuse',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    expect(() => compareGitHubProjectAssociations(
      runtime,
      [{
        project,
        taskSourceIds: ['owner/repo:1'],
      }, {
        project: { id: 'P_replacement_project', number: 17 },
        taskSourceIds: ['owner/repo:2'],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    )).toThrow('multiple stable identities');
    runtime.complete('failed', 'project_number_identity_reuse');
  });

  it('keeps renamed locators clean while blocking collisions and namespace leakage', () => {
    const renamedTaskId = 'task-project-renamed';
    database.default.insert(schema.tasks).values(
      taskRow('observe-a', renamedTaskId, 'owner/legacy:77', 'todo'),
    ).run();
    identity.persistExternalIdentityBatch([
      identityWrite('observe-a', renamedTaskId, 'I_project_renamed', 77),
    ], 'comparing');
    const renamedEvidence = issueEvidenceAt(
      'I_project_renamed',
      77,
      'owner',
      'renamed',
    );
    identity.persistExternalIdentityBatch([{
      ...identityWrite('observe-a', renamedTaskId, 'I_project_renamed', 77),
      evidence: renamedEvidence,
    }], 'comparing');

    const renamedRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-renamed-project-membership',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const renamed = compareGitHubProjectAssociations(
      renamedRuntime,
      [{
        project: { id: 'P_22', number: 22 },
        taskSourceIds: ['owner/legacy:77'],
        taskIdentityEvidence: [{
          sourceId: 'owner/legacy:77',
          evidence: renamedEvidence,
        }],
      }],
      [{ id: renamedTaskId, sourceId: 'owner/legacy:77' }],
    );
    renamedRuntime.complete('succeeded');
    expect(renamed.decisions).toEqual([
      expect.objectContaining({
        outcome: 'agreement',
        legacySelectedLocalId: renamedTaskId,
        stableSelectedLocalId: renamedTaskId,
      }),
    ]);

    database.default.update(schema.externalEntityBindings).set({
      state: 'collision',
    }).where(eq(schema.externalEntityBindings.localId, 'task-bound')).run();
    const collisionRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-project-binding-collision',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const collision = compareGitHubProjectAssociations(
      collisionRuntime,
      [{
        project: { id: 'P_23', number: 23 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_bound'),
        }],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    );
    collisionRuntime.complete('succeeded');
    expect(collision.decisions).toEqual([
      expect.objectContaining({
        outcome: 'collision',
        reason: 'multiple_stable_bindings',
      }),
    ]);
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, collisionRuntime.runId)).get())
      .toMatchObject({ evidenceEligible: false });
    database.default.update(schema.externalEntityBindings).set({
      state: 'shadow',
    }).where(eq(schema.externalEntityBindings.localId, 'task-bound')).run();

    const otherConnectorTaskId = 'task-project-other-connector';
    database.default.insert(schema.tasks).values(
      taskRow('observe-b', otherConnectorTaskId, 'owner/repo:99', 'todo'),
    ).run();
    identity.persistExternalIdentityBatch([
      identityWrite('observe-b', otherConnectorTaskId, 'I_project_other_connector', 99),
    ], 'comparing');
    const isolatedRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-project-connector-isolation',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const isolated = compareGitHubProjectAssociations(
      isolatedRuntime,
      [{
        project: { id: 'P_24', number: 24 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidenceAt(
            'I_project_other_connector',
            99,
            'other',
            'repo',
          ),
        }],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    );
    isolatedRuntime.complete('succeeded');
    expect(isolated.decisions).toEqual([
      expect.objectContaining({
        stableSelectedLocalId: null,
        outcome: 'stable_legacy_disagree',
        appliedSource: 'legacy',
      }),
    ]);

    const hostRuntime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-project-host-isolation',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    const hostIsolated = compareGitHubProjectAssociations(
      hostRuntime,
      [{
        project: { id: 'P_25', number: 25 },
        taskSourceIds: ['owner/repo:1'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:1',
          evidence: issueEvidence('I_bound', 1, 'github.example.com'),
        }],
      }],
      [{ id: 'task-bound', sourceId: 'owner/repo:1' }],
    );
    hostRuntime.complete('succeeded');
    expect(hostIsolated.decisions).toEqual([
      expect.objectContaining({
        stableSelectedLocalId: null,
        outcome: 'stable_legacy_disagree',
        appliedSource: 'legacy',
      }),
    ]);
  });

  it('routes each project membership through the active stable task after cutover', () => {
    const connectorId = 'observe-project-stable';
    const taskId = 'task-project-stable';
    database.default.insert(schema.connectorConfigs).values(
      connector(connectorId, ['owner/repo']),
    ).run();
    database.default.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: connectorId,
      phase: 'stable_primary',
      updatedAt: now,
    }).run();
    database.default.insert(schema.githubIdentityControls).values({
      connectorInstanceId: connectorId,
      stablePrimaryEnabled: true,
      modeRevision: 1,
      updatedAt: now,
    }).run();
    database.default.insert(schema.tasks).values(
      taskRow(connectorId, taskId, 'owner/repo:88', 'todo'),
    ).run();
    identity.persistExternalIdentityBatch([
      identityWrite(connectorId, taskId, 'I_project_stable', 88),
    ], 'stable_primary');

    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: connectorId,
      jobId: 'observe-job-project-stable-routing',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot(connectorId),
      syncKind: 'full',
    });
    const evidence = issueEvidence('I_project_stable', 88);
    const result = compareGitHubProjectAssociations(
      runtime,
      [31, 32].map((number) => ({
        project: { id: `P_${number}`, number },
        taskSourceIds: ['owner/repo:88'],
        taskIdentityEvidence: [{
          sourceId: 'owner/repo:88',
          evidence,
        }],
      })),
      [{ id: taskId, sourceId: 'owner/repo:88' }],
    );
    runtime.assertDecisionsCurrent(result.decisions);
    runtime.complete('succeeded');

    expect(result.decisions).toEqual([
      expect.objectContaining({
        candidateKey: 'project:31:owner/repo:88',
        appliedSource: 'stable',
        selectedLocalId: taskId,
      }),
      expect.objectContaining({
        candidateKey: 'project:32:owner/repo:88',
        appliedSource: 'stable',
        selectedLocalId: taskId,
      }),
    ]);
    expect(result.stableProjectTaskIds).toEqual(new Map([
      [31, new Set([taskId])],
      [32, new Set([taskId])],
    ]));
    expect(result.blockedStableProjects).toEqual(new Set());
  });

  it('rejects deduplicated candidates with different applicable-local scopes', () => {
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-dedup-scope',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });

    expect(() => runtime.observeDeduplicatedBatch('sub_issue', 'task', [{
      candidateKey: 'same-identity:first',
      legacySelectedLocalIds: ['task-bound'],
      legacyAction: 'present',
      applicableStableLocalIds: new Set(['task-bound']),
      evidence: issueEvidence('I_bound'),
    }, {
      candidateKey: 'same-identity:second',
      legacySelectedLocalIds: ['task-bound'],
      legacyAction: 'present',
      applicableStableLocalIds: new Set(['task-other']),
      evidence: issueEvidence('I_bound'),
    }])).toThrow('different local ID scopes');
    runtime.complete('failed', 'deduplicated_local_scope_mismatch');
  });

  it('records agreement and fallback while legacy remains authoritative', () => {
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'observe-job-agreement',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    runtime.markNetworkPage();
    const decisions = runtime.observeBatch('task', 'task', [{
      candidateKey: 'owner/repo:1',
      legacySelectedLocalIds: ['task-bound'],
      legacyAction: 'update',
      evidence: issueEvidence('I_bound'),
      localTaskId: 'task-bound',
    }, {
      candidateKey: 'owner/repo:99',
      legacySelectedLocalIds: [],
      legacyAction: 'create',
    }]);
    runtime.complete('succeeded');

    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateKey: 'owner/repo:1',
        outcome: 'agreement',
        appliedSource: 'legacy',
        selectedLocalId: 'task-bound',
      }),
      expect.objectContaining({
        candidateKey: 'owner/repo:99',
        outcome: 'missing_stable_id',
        appliedSource: 'legacy',
        selectedAction: 'create',
      }),
    ]));
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get()).toMatchObject({
      state: 'succeeded',
      pageCount: 1,
      queryCount: 1,
      evidenceEligible: true,
      outcomeCounts: { agreement: 1, missing_stable_id: 1 },
    });
  });

  it('marks disagreement and failed/interrupted runs ineligible and rejects conflicting replay', () => {
    const interrupted = identity.startGitHubIdentityComparisonRun({
      id: 'orphaned-observe-run',
      connectorInstanceId: 'observe-a',
      jobId: 'old-job',
      identityMode: 'comparison',
      identityModeRevision: 3,
      syncKind: 'full',
    });
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'new-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, interrupted.id)).get()).toMatchObject({
      state: 'cancelled',
      errorCode: 'owner_lease_expired',
      evidenceEligible: false,
    });

    runtime.observeResolvedBatch('task', [{
      candidateKey: 'disagreement',
      legacySelectedLocalIds: ['task-bound'],
      legacyAction: 'update',
      localTaskId: 'task-bound',
      stable: {
        selectedLocalIds: ['task-other'],
        action: 'update',
        evidence: 'verified',
        stableIdDigest: 'a'.repeat(64),
      },
    }]);
    runtime.complete('failed', 'sync_failed');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get()).toMatchObject({
      state: 'failed',
      evidenceEligible: false,
      errorCode: 'sync_failed',
    });
    const replayRun = identity.startGitHubIdentityComparisonRun({
      id: 'replay-observe-run',
      connectorInstanceId: 'observe-a',
      identityMode: 'comparison',
      identityModeRevision: 3,
      syncKind: 'full',
    });
    const record = {
      surface: 'task' as const,
      candidateKey: 'replay',
      legacyAction: 'present' as const,
      stableAction: 'present' as const,
      outcome: 'agreement' as const,
      reason: 'exact_match' as const,
    };
    const first = identity.appendGitHubIdentityComparisonRecords(replayRun.id, [record]);
    expect(identity.appendGitHubIdentityComparisonRecords(replayRun.id, [record])[0].id)
      .toBe(first[0].id);
    expect(() => identity.appendGitHubIdentityComparisonRecords(replayRun.id, [{
      ...record,
      stableAction: 'none',
    }])).toThrow('Conflicting comparison replay');
  });

  it('does not let an ad-hoc runtime cancel an active sync job comparison', () => {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    database.default.insert(schema.syncJobs).values({
      id: 'active-sync-job',
      connectorId: 'observe-a',
      source: 'schedule',
      status: 'running',
      availableAt: now,
      scheduledFor: now,
      startedAt: now,
      leaseOwner: 'test-worker',
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
      identityMode: 'comparison',
      identityModeRevision: 3,
    }).run();
    const active = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'active-sync-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'incremental',
    });

    expect(() => new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'incremental',
    })).toThrow('owned by an active runtime');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, active.runId)).get()).toMatchObject({
      state: 'running',
      jobId: 'active-sync-job',
    });

    active.complete('succeeded');
  });

  it('recovers job-owned comparison evidence after the sync job becomes inactive', () => {
    const jobTime = new Date().toISOString();
    const comparisonLeaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    database.default.insert(schema.syncJobs).values({
      id: 'stale-sync-job',
      connectorId: 'observe-a',
      source: 'schedule',
      status: 'failed',
      availableAt: jobTime,
      scheduledFor: jobTime,
      startedAt: jobTime,
      completedAt: jobTime,
      createdAt: jobTime,
      updatedAt: jobTime,
      identityMode: 'comparison',
      identityModeRevision: 3,
    }).run();
    const stale = identity.startGitHubIdentityComparisonRun({
      connectorInstanceId: 'observe-a',
      jobId: 'stale-sync-job',
      identityMode: 'comparison',
      identityModeRevision: 3,
      syncKind: 'incremental',
      ownerId: 'job:stale-sync-job',
      ownerToken: 'stale-owner-token',
    });
    database.default.update(schema.githubIdentityComparisonRuns).set({
      ownerLeaseExpiresAt: comparisonLeaseExpiresAt,
    }).where(eq(schema.githubIdentityComparisonRuns.id, stale.id)).run();
    identity.appendGitHubIdentityComparisonRecords(stale.id, [{
      surface: 'task',
      candidateKey: 'blocked-stable-evidence',
      legacyAction: 'update',
      stableAction: 'update',
      outcome: 'stable_legacy_disagree',
      reason: 'selected_ids_differ',
    }], 'stale-owner-token');

    const replacement = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'replacement-sync-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'incremental',
    });

    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, stale.id)).get()).toMatchObject({
      state: 'cancelled',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionReason: 'stale_owner_takeover',
      errorCode: 'owner_lease_expired',
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.runId, stale.id)).all()).toHaveLength(1);
    replacement.complete('cancelled', 'test_complete');
  });

  it('keeps successful runs ineligible after a non-fatal observation failure', () => {
    const runtime = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'incomplete-observation-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    runtime.markIneligible('project_association_observation_failed');
    runtime.complete('succeeded');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get()).toMatchObject({
      state: 'succeeded',
      evidenceEligible: false,
      errorCode: 'project_association_observation_failed',
    });
  });
});

describe('terminal inaccessible compatibility evidence', () => {
  it('preserves durable Stage-1 acceptance and idempotency', () => {
    database.default.insert(schema.githubIdentityBackfillItems).values([
      {
        connectorInstanceId: 'observe-a',
        bindingType: 'task',
        localId: 'task-terminal',
        state: 'inaccessible',
        attemptCount: 1,
        observedAt: now,
        updatedAt: now,
      },
      {
        connectorInstanceId: 'observe-a',
        bindingType: 'task',
        localId: 'task-unexplained',
        state: 'inaccessible',
        attemptCount: 1,
        observedAt: now,
        updatedAt: now,
      },
    ]).run();
    const request = {
      connectorInstanceId: 'observe-a',
      bindingType: 'task' as const,
      localId: 'task-terminal',
      category: 'terminal_inaccessible' as const,
      action: 'accept' as const,
      actor: 'test-operator',
      reason: 'Authoritative inaccessible terminal record',
      idempotencyKey: 'terminal-accept-1',
      now,
    };
    expect(identity.recordGitHubIdentityException(request)).toMatchObject({
      changed: true,
      action: 'accept',
      proofType: 'stage1_inaccessible',
      comparisonRunId: null,
    });
    expect(identity.recordGitHubIdentityException(request)).toMatchObject({
      changed: false,
      action: 'accept',
    });
    expect(() => identity.recordGitHubIdentityException({
      ...request,
      reason: 'conflicting replay',
    })).toThrow('idempotency key was already used');
    expect(() => identity.recordGitHubIdentityException({
      ...request,
      localId: 'task-unexplained',
      idempotencyKey: 'active-inaccessible-1',
    })).toThrow('cancelled historical task');
  });

  it('accepts explicitly confirmed post-backfill evidence and requires a fresh soak run', () => {
    addBoundTask('task-post-backfill', 'cancelled', 'I_post_backfill');
    const evidenceRun = comparisonRun({
      id: 'post-backfill-evidence',
      localId: 'task-post-backfill',
      state: 'succeeded',
    });
    const request = {
      connectorInstanceId: 'observe-a',
      bindingType: 'task' as const,
      localId: 'task-post-backfill',
      category: 'terminal_inaccessible' as const,
      action: 'accept' as const,
      actor: 'test-operator',
      reason: 'Independently verified authoritative GitHub deletion',
      idempotencyKey: 'post-backfill-accept-1',
      comparisonRunId: evidenceRun,
      confirmAuthoritativeDeletion: true,
      now,
    };
    expect(identity.recordGitHubIdentityException(request)).toMatchObject({
      changed: true,
      proofType: 'post_backfill_authoritative_deletion',
      comparisonRunId: evidenceRun,
    });
    expect(identity.recordGitHubIdentityException(request)).toMatchObject({
      changed: false,
      proofType: 'post_backfill_authoritative_deletion',
      comparisonRunId: evidenceRun,
    });

    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'task-post-backfill')).get()).toMatchObject({
      status: 'cancelled',
    });
    expect(database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.localId, 'task-post-backfill')).get())
      .toMatchObject({ state: 'shadow' });
    expect(identity.resolveGitHubIdentityBatch({
      modeSnapshot: {
        ...identity.getGitHubIdentityModeSnapshot('observe-a'),
        effectiveMode: 'stable',
      },
      candidates: [{
        candidateKey: 'accepted-does-not-authorize-mutation',
        surface: 'deletion',
        localTaskId: 'task-post-backfill',
        legacy: {
          selectedLocalIds: ['task-post-backfill'],
          action: 'delete_candidate',
        },
        stable: {
          selectedLocalIds: [],
          action: 'none',
          evidence: 'inaccessible',
        },
      }],
    }).decisions[0]).toMatchObject({
      outcome: 'inaccessible',
      appliedSource: 'blocked',
      selectedAction: 'none',
    });

    const freshRun = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'fresh-post-acceptance-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    freshRun.observeResolvedBatch('deletion', [{
      candidateKey: 'task:post-backfill-fresh',
      localTaskId: 'task-post-backfill',
      legacySelectedLocalIds: ['task-post-backfill'],
      legacyAction: 'delete_candidate',
      stable: { selectedLocalIds: [], action: 'none', evidence: 'inaccessible' },
    }]);
    freshRun.complete('succeeded');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, freshRun.runId)).get())
      .toMatchObject({ evidenceEligible: true });

    const status = identity.getGitHubIdentityComparisonStatus('observe-a', {
      includeEvidence: true,
      limit: 100,
    });
    expect(status).toMatchObject({
      terminalExceptionProofRequirements: {
        soak: expect.stringContaining('fresh successful full comparison run'),
      },
      acceptedExceptions: expect.arrayContaining([
        expect.objectContaining({
          localId: 'task-post-backfill',
          proofType: 'post_backfill_authoritative_deletion',
          comparisonRunId: evidenceRun,
        }),
      ]),
    });
    expect(status.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localTaskId: 'task-post-backfill',
        terminalExceptionStatus: 'accepted',
        terminalExceptionProofType: 'post_backfill_authoritative_deletion',
      }),
    ]));
  });

  it.each([
    ['running', 'running', 'full', 'inaccessible', 'deletion', 'run state was running'],
    ['failed', 'failed', 'full', 'inaccessible', 'deletion', 'run state was failed'],
    ['cancelled', 'cancelled', 'full', 'inaccessible', 'deletion', 'run state was cancelled'],
    ['incremental', 'succeeded', 'incremental', 'inaccessible', 'deletion', 'incremental, not full'],
    ['partial', 'succeeded', 'full', 'partial_fetch', 'deletion', 'no inaccessible deletion record'],
    ['legacy-fallback', 'succeeded', 'full', 'legacy_fallback', 'deletion', 'no inaccessible deletion record'],
    ['dependency-only', 'succeeded', 'full', 'inaccessible', 'dependency', 'no inaccessible deletion record'],
  ] as const)(
    'rejects %s comparison evidence',
    (suffix, state, syncKind, outcome, surface, expected) => {
      const localId = `task-reject-${suffix}`;
      addBoundTask(localId, 'cancelled', `I_reject_${suffix}`);
      const runId = comparisonRun({ id: `reject-${suffix}`, localId, state, syncKind, outcome, surface });
      expect(() => identity.recordGitHubIdentityException({
        connectorInstanceId: 'observe-a',
        bindingType: 'task',
        localId,
        category: 'terminal_inaccessible',
        action: 'accept',
        actor: 'test-operator',
        reason: `Reject ${suffix}`,
        idempotencyKey: `reject-${suffix}-key`,
        comparisonRunId: runId,
        confirmAuthoritativeDeletion: true,
      })).toThrow(expected);
    },
  );

  it('rejects generic access-denied evidence without explicit authoritative confirmation', () => {
    addBoundTask('task-access-denied', 'cancelled', 'I_access_denied');
    const runId = comparisonRun({
      id: 'access-denied-evidence',
      localId: 'task-access-denied',
      state: 'succeeded',
    });
    expect(() => identity.recordGitHubIdentityException({
      connectorInstanceId: 'observe-a',
      bindingType: 'task',
      localId: 'task-access-denied',
      category: 'terminal_inaccessible',
      action: 'accept',
      actor: 'test-operator',
      reason: 'Unconfirmed inaccessible record',
      idempotencyKey: 'unconfirmed-access-denied',
      comparisonRunId: runId,
    })).toThrow('both a comparison run and explicit authoritative-deletion confirmation');
  });

  it('rejects evidence for another connector or local task and non-cancelled tasks', () => {
    addBoundTask('task-wrong-local', 'cancelled', 'I_wrong_local');
    addBoundTask('task-request-wrong-local', 'cancelled', 'I_request_wrong_local');
    addBoundTask('task-active-post', 'todo', 'I_active_post');
    const localRun = comparisonRun({
      id: 'wrong-local-evidence',
      localId: 'task-wrong-local',
      state: 'succeeded',
    });
    const activeRun = comparisonRun({
      id: 'active-task-evidence',
      localId: 'task-active-post',
      state: 'succeeded',
    });
    const otherConnectorRun = comparisonRun({
      id: 'other-connector-evidence',
      connectorInstanceId: 'observe-b',
      localId: 'task-other',
      state: 'succeeded',
    });
    expect(() => acceptPostBackfill('task-request-wrong-local', localRun, 'wrong-local-key'))
      .toThrow('no inaccessible deletion record for this task');
    expect(() => acceptPostBackfill(
      'task-request-wrong-local',
      otherConnectorRun,
      'wrong-connector-key',
    )).toThrow('comparison run was not found for this connector');
    expect(() => acceptPostBackfill('task-active-post', activeRun, 'active-task-key'))
      .toThrow('cancelled historical task');
  });

  it('returns bounded redacted operator evidence and remaining uncovered gates', () => {
    const queryHeavyRun = new identity.GitHubIdentityComparisonRuntime({
      connectorInstanceId: 'observe-a',
      jobId: 'query-heavy-job',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('observe-a'),
      syncKind: 'full',
    });
    for (let index = 0; index < 3; index++) {
      queryHeavyRun.observeBatch('task', 'task', [{
        candidateKey: `query-heavy-${index}`,
        legacySelectedLocalIds: [],
        legacyAction: 'create',
        evidence: issueEvidence(`I_query_heavy_${index}`, index + 20),
      }]);
    }
    queryHeavyRun.complete('succeeded');
    const linkedBudgetRun = identity.startGitHubIdentityComparisonRun({
      id: 'linked-query-budget-run',
      connectorInstanceId: 'observe-a',
      identityMode: 'comparison',
      identityModeRevision: 3,
      syncKind: 'full',
    });
    identity.appendGitHubIdentityComparisonRecords(linkedBudgetRun.id, [
      {
        surface: 'linked_source',
        candidateKey: 'linked:budget-1',
        localTaskId: 'task-bound',
        legacySelectedLocalId: 'task-bound',
        stableSelectedLocalId: 'task-bound',
        legacyAction: 'present',
        stableAction: 'present',
        outcome: 'agreement',
        reason: 'exact_match',
      },
      {
        surface: 'linked_source',
        candidateKey: 'linked:budget-2',
        localTaskId: 'task-bound',
        legacySelectedLocalId: 'task-bound',
        stableSelectedLocalId: 'task-bound',
        legacyAction: 'present',
        stableAction: 'present',
        outcome: 'agreement',
        reason: 'exact_match',
      },
    ]);
    identity.completeGitHubIdentityComparisonRun(linkedBudgetRun.id, {
      state: 'succeeded',
      pageCount: 1,
      queryCount: 5,
      outcomeCounts: { agreement: 2 },
      evidenceEligible: true,
    });
    const status = identity.getGitHubIdentityComparisonStatus('observe-a', {
      includeEvidence: true,
      limit: 10,
    });
    expect(status).toMatchObject({
      mode: {
        effectiveMode: 'comparison',
        stablePrimaryEnabled: false,
        modeRevision: 3,
      },
      coverage: {
        implementedSurfaces: [
          'source_list',
          'task',
          'project_association',
          'linked_source',
          'dependency',
          'sub_issue',
          'deletion',
          'write_route',
        ],
        uncoveredGates: [],
      },
      stageTwo: {
        eligible: false,
        blockers: expect.arrayContaining([
          'dependency_identity_evidence_required',
          'sub_issue_identity_evidence_required',
          'pending_write_cycle_not_observed',
        ]),
      },
    });
    expect((status.runs as Array<{ id: string; queryBound: boolean }>)
      .find((run) => run.id === 'linked-query-budget-run')).toMatchObject({
      id: 'linked-query-budget-run',
      queryBound: true,
      queryBudget: 5,
      evidenceEligible: true,
    });
    expect((status.stageTwo as { blockers: string[] }).blockers).not.toEqual(
      expect.arrayContaining([
        'uncovered:linked_source_identity',
        'uncovered:write_route_and_pending_write_comparison',
        'uncovered:deletion_recovery_binding_fence',
      ]),
    );
    expect((status.runs as Array<{ id: string; queryBound: boolean }>)
      .find((run) => run.id === queryHeavyRun.runId)).toMatchObject({
      queryBound: false,
      evidenceEligible: false,
    });
    expect((status.stageTwo as { blockers: string[] }).blockers)
      .not.toContain('uncovered:linked_source_identity');
    expect(JSON.stringify(status)).not.toContain('I_bound');
    expect(() => identity.getGitHubIdentityComparisonStatus('observe-a', { limit: 101 }))
      .toThrow('between 1 and 100');
  });
});

function addBoundTask(
  localId: string,
  status: 'todo' | 'cancelled',
  stableId: string,
): void {
  const issueNumber = nextBoundIssueNumber++;
  database.default.insert(schema.tasks).values(
    taskRow('observe-a', localId, `owner/repo:${issueNumber}`, status),
  ).run();
  identity.persistExternalIdentityBatch([
    identityWrite('observe-a', localId, stableId, issueNumber),
  ], 'comparing');
  database.default.insert(schema.githubIdentityBackfillItems).values({
    connectorInstanceId: 'observe-a',
    bindingType: 'task',
    localId,
    state: 'bound',
    attemptCount: 1,
    reasonCode: 'metadata_node_id',
    observedAt: now,
    updatedAt: now,
  }).run();
}

function comparisonRun(options: {
  id: string;
  localId: string;
  connectorInstanceId?: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  syncKind?: 'full' | 'incremental';
  outcome?: 'inaccessible' | 'partial_fetch' | 'legacy_fallback';
  surface?: 'deletion' | 'dependency';
}): string {
  const outcome = options.outcome ?? 'inaccessible';
  const connectorInstanceId = options.connectorInstanceId ?? 'observe-a';
  const modeSnapshot = identity.getGitHubIdentityModeSnapshot(connectorInstanceId);
  const run = identity.startGitHubIdentityComparisonRun({
    id: options.id,
    connectorInstanceId,
    identityMode: 'comparison',
    identityModeRevision: modeSnapshot.modeRevision,
    syncKind: options.syncKind ?? 'full',
  });
  identity.appendGitHubIdentityComparisonRecords(run.id, [{
    surface: options.surface ?? 'deletion',
    candidateKey: `${options.id}:candidate`,
    localTaskId: options.localId,
    legacySelectedLocalId: options.localId,
    legacyAction: 'delete_candidate',
    stableAction: 'none',
    outcome,
    reason: outcome === 'inaccessible'
      ? 'access_denied'
      : outcome === 'partial_fetch'
        ? 'fetch_incomplete'
        : 'legacy_only',
  }]);
  if (options.state !== 'running') {
    identity.completeGitHubIdentityComparisonRun(run.id, {
      state: options.state,
      pageCount: 1,
      queryCount: 1,
      outcomeCounts: { [outcome]: 1 },
      evidenceEligible: false,
    });
  }
  return run.id;
}

function acceptPostBackfill(localId: string, comparisonRunId: string, idempotencyKey: string) {
  return identity.recordGitHubIdentityException({
    connectorInstanceId: 'observe-a',
    bindingType: 'task',
    localId,
    category: 'terminal_inaccessible',
    action: 'accept',
    actor: 'test-operator',
    reason: 'Independently verified authoritative deletion',
    idempotencyKey,
    comparisonRunId,
    confirmAuthoritativeDeletion: true,
  });
}

function connector(id: string, repos: string[]) {
  return {
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual' as const,
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'secret-that-must-not-appear' },
    settings: { repos },
    syncedLists: repos,
    createdAt: now,
    updatedAt: now,
  };
}

function taskRow(
  connectorInstanceId: string,
  id: string,
  sourceId: string,
  status: 'todo' | 'cancelled',
) {
  return {
    id,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId,
    sourceListId: connectorInstanceId === 'observe-a' ? 'observe-a-list' : null,
    title: id,
    status,
    isChecklistItem: false,
    syncStatus: 'synced' as const,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    metadata: {},
  };
}

function issueEvidence(stableId: string, issueNumber = 1, hostKey = 'github.com') {
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'repository' as const,
        stableId: `R_${hostKey}`,
      },
      locator: { owner: 'owner', repository: 'repo' },
      observationSource: 'graphql' as const,
      observedAt: now,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'issue' as const,
        stableId,
      },
      locator: { owner: 'owner', repository: 'repo', issueNumber },
      observationSource: 'graphql' as const,
      observedAt: now,
    },
  };
}

function issueEvidenceAt(
  stableId: string,
  issueNumber: number,
  owner: string,
  repository: string,
) {
  const evidence = issueEvidence(stableId, issueNumber);
  return {
    ...evidence,
    repository: {
      ...evidence.repository,
      locator: { owner, repository },
    },
    entity: {
      ...evidence.entity,
      locator: { owner, repository, issueNumber },
    },
  };
}

function identityWrite(
  connectorInstanceId: string,
  localId: string,
  stableId: string,
  issueNumber = 1,
) {
  return {
    target: {
      connectorInstanceId,
      bindingType: 'task' as const,
      localId,
      legacyIdentity: `owner/repo:${issueNumber}`,
    },
    evidence: issueEvidence(stableId, issueNumber),
  };
}

function repositoryIdentityWrite(
  connectorInstanceId: string,
  localId: string,
  stableId: string,
  repository = 'repo',
) {
  return {
    target: {
      connectorInstanceId,
      bindingType: 'source_list' as const,
      localId,
      legacyIdentity: `owner/${repository}`,
    },
    evidence: {
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'repository' as const,
          stableId,
        },
        locator: { owner: 'owner', repository },
        observationSource: 'graphql' as const,
        observedAt: now,
      },
    },
  };
}
