import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildGitHubNativeTaskPopulation } from '@/lib/sync/github-native-task';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

process.env.MC_DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

const connectorId = 'stable-cutover';
const now = '2026-08-10T15:00:00.000Z';

beforeAll(async () => {
  vi.resetModules();
  [database, schema, identity] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
  ]);
  seedEligibleConnector();
});

describe('GitHub connector-scoped stable-primary cutover', () => {
  it('reports and rejects every operational Stage 2 blocker without changing mode', () => {
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now)).toEqual({
      eligible: true,
      blockers: [],
    });

    const task = database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'stable-task')).get()!;
    const blockerCases: Array<{
      code: string;
      add: () => void;
      remove: () => void;
    }> = [
      {
        code: 'connector_operation_not_idle',
        add: () => database.default.insert(schema.connectorOperationLeases).values({
          connectorId,
          operationType: 'sync',
          owner: 'cutover-blocker',
          leaseExpiresAt: '2026-08-10T16:00:00.000Z',
          createdAt: now,
          updatedAt: now,
        }).run(),
        remove: () => database.default.delete(schema.connectorOperationLeases)
          .where(eq(schema.connectorOperationLeases.connectorId, connectorId)).run(),
      },
      {
        code: 'sync_jobs_not_idle',
        add: () => database.default.insert(schema.syncJobs).values({
          id: 'blocked-job',
          connectorId,
          source: 'api',
          status: 'queued',
          availableAt: now,
          scheduledFor: now,
          createdAt: now,
          updatedAt: now,
        }).run(),
        remove: () => database.default.delete(schema.syncJobs)
          .where(eq(schema.syncJobs.id, 'blocked-job')).run(),
      },
      {
        code: 'dependency_snapshot_not_idle',
        add: () => database.default.insert(schema.dependencyReconciliationSnapshots).values({
          id: 'blocked-dependency',
          connectorInstanceId: connectorId,
          status: 'running',
          total: 0,
          batchSize: 50,
          startedAt: now,
          updatedAt: now,
        }).run(),
        remove: () => database.default.delete(schema.dependencyReconciliationSnapshots)
          .where(eq(schema.dependencyReconciliationSnapshots.id, 'blocked-dependency')).run(),
      },
      {
        code: 'deletion_candidates_not_idle',
        add: () => database.default.insert(schema.syncDeletionCandidates).values({
          id: 'blocked-deletion',
          connectorId,
          taskId: task.id,
          sourceId: task.sourceId,
          firstMissingAt: now,
          lastMissingAt: now,
        }).run(),
        remove: () => database.default.delete(schema.syncDeletionCandidates)
          .where(eq(schema.syncDeletionCandidates.id, 'blocked-deletion')).run(),
      },
      writeLeaseBlocker('claimed', 'active_write_lease'),
      writeLeaseBlocker('unknown', 'unknown_write_outcome'),
      {
        code: 'pending_write_cycle_incomplete',
        add: () => database.default.insert(schema.githubIdentityWriteCycles).values({
          id: 'blocked-cycle',
          connectorInstanceId: connectorId,
          effectiveMode: 'comparison',
          modeRevision: 0,
          pendingCandidateCount: 1,
          state: 'interrupted',
          startedAt: now,
          completedAt: now,
        }).run(),
        remove: () => database.default.delete(schema.githubIdentityWriteCycles)
          .where(eq(schema.githubIdentityWriteCycles.id, 'blocked-cycle')).run(),
      },
      interruptedComparisonBlocker(
        'blocked-comparison-cycle',
        'incremental',
        'comparison',
        'comparison_cycle_unresolved',
      ),
      interruptedComparisonBlocker(
        'blocked-sub-issue-cycle',
        'full',
        'sub_issue',
        'sub_issue_cycle_unresolved',
      ),
      recoveryBlocker('pending', 'deletion_recovery_not_idle'),
      recoveryBlocker('quarantined', 'deletion_recovery_quarantined'),
      {
        code: 'active_collision',
        add: () => database.default.insert(schema.githubIdentityCollisions).values({
          id: 'blocked-collision',
          connectorInstanceId: connectorId,
          category: 'stable_legacy_disagree',
          fingerprint: 'blocked',
          bindingType: 'task',
          localIds: [task.id],
          externalEntityIds: ['stable-issue-entity'],
          state: 'open',
          firstSeenAt: now,
          lastSeenAt: now,
        }).run(),
        remove: () => database.default.delete(schema.githubIdentityCollisions)
          .where(eq(schema.githubIdentityCollisions.id, 'blocked-collision')).run(),
      },
      {
        code: 'selected_repository_binding_incomplete',
        add: () => database.default.update(schema.externalEntityBindings).set({
          state: 'collision',
        }).where(eq(schema.externalEntityBindings.id, 'stable-repo-binding')).run(),
        remove: () => database.default.update(schema.externalEntityBindings).set({
          state: 'shadow',
        }).where(eq(schema.externalEntityBindings.id, 'stable-repo-binding')).run(),
      },
      comparisonRecordBlocker('path_reuse', 'locator_owned_by_other_entity', 'repository_path_reuse'),
      comparisonRecordBlocker('partial_fetch', 'fetch_incomplete', 'partial_fetch_evidence'),
      comparisonRecordBlocker('inaccessible', 'access_denied', 'unexplained_inaccessible_evidence'),
    ];

    for (const blocker of blockerCases) {
      blocker.add();
      const eligibility = identity.getGitHubStablePrimaryEligibility(connectorId, now);
      expect(eligibility.eligible, blocker.code).toBe(false);
      expect(eligibility.blockers, blocker.code).toContain(blocker.code);
      const rejected = identity.enableGitHubStablePrimary({
        connectorInstanceId: connectorId,
        expectedRevision: 1,
        actor: 'cutover-test',
        reason: `Reject ${blocker.code}`,
        idempotencyKey: `reject-${blocker.code}`,
        now,
      });
      expect(rejected).toMatchObject({ ok: false, code: 'gate_failed' });
      expect(identity.getGitHubIdentityModeSnapshot(connectorId)).toMatchObject({
        effectiveMode: 'comparison',
        modeRevision: 1,
      });
      blocker.remove();
      expect(identity.getGitHubStablePrimaryEligibility(connectorId, now).eligible).toBe(true);
    }

    database.default.update(schema.githubIdentityComparisonRuns).set({
      completedAt: '2026-08-08T00:00:00.000Z',
    }).where(eq(schema.githubIdentityComparisonRuns.connectorInstanceId, connectorId)).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now).blockers)
      .toContain('comparison_evidence_stale');
    database.default.update(schema.githubIdentityComparisonRuns).set({
      completedAt: '2026-08-10T14:00:00.000Z',
    }).where(eq(schema.githubIdentityComparisonRuns.connectorInstanceId, connectorId)).run();
  });

  it('uses complete sub-issue generation cardinalities for operator preflight', () => {
    const parentRecord = database.default.select()
      .from(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.id, 'eligible-record-3'))
      .get()!;
    database.default.delete(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.id, parentRecord.id)).run();
    database.default.update(schema.githubIdentityComparisonRuns).set({
      subIssueExpectedParentCount: 0,
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'eligible-run-2')).run();

    const status = identity.getGitHubIdentityComparisonStatus(connectorId, { now }) as {
      coverage: {
        subIssueIdentity: {
          covered: boolean;
          expectedChildCount: number;
          expectedParentCount: number;
          childEndpointCount: number;
          parentEndpointCount: number;
        };
      };
      cutover: { preflightReady: boolean };
      stageTwo: { eligible: boolean; blockers: string[] };
    };
    expect(status.coverage.subIssueIdentity).toMatchObject({
      covered: true,
      expectedChildCount: 1,
      expectedParentCount: 0,
      childEndpointCount: 1,
      parentEndpointCount: 0,
    });
    expect(status.cutover.preflightReady).toBe(true);
    expect(status.stageTwo).toEqual({ eligible: true, blockers: [] });

    database.default.update(schema.githubIdentityComparisonRuns).set({
      subIssueExpectedParentCount: 1,
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'eligible-run-2')).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now)).toMatchObject({
      eligible: false,
      blockers: expect.arrayContaining(['sub_issue_identity_evidence_required']),
    });

    database.default.insert(schema.githubIdentityComparisonRecords).values(parentRecord).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now))
      .toEqual({ eligible: true, blockers: [] });

    database.default.update(schema.githubIdentitySubIssuePopulationMembers).set({
      observed: false,
    }).where(eq(
      schema.githubIdentitySubIssuePopulationMembers.id,
      'eligible-population-member',
    )).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now).blockers)
      .toContain('sub_issue_identity_evidence_required');
    database.default.update(schema.githubIdentitySubIssuePopulationMembers).set({
      observed: true,
    }).where(eq(
      schema.githubIdentitySubIssuePopulationMembers.id,
      'eligible-population-member',
    )).run();

    database.default.update(schema.githubIdentityComparisonRuns).set({
      subIssuePopulationDigest: '0'.repeat(64),
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'eligible-run-2')).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now).blockers)
      .toContain('sub_issue_identity_evidence_required');
    database.default.update(schema.githubIdentityComparisonRuns).set({
      subIssuePopulationDigest: database.default.select({
        digest: schema.githubIdentityComparisonRuns.subIssueObservedChildDigest,
      }).from(schema.githubIdentityComparisonRuns)
        .where(eq(schema.githubIdentityComparisonRuns.id, 'eligible-run-2')).get()!.digest,
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'eligible-run-2')).run();
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now))
      .toEqual({ eligible: true, blockers: [] });
  });

  it('never counts 0083-style self-attested runs toward current Stage 2 soak', () => {
    const originals = database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.connectorInstanceId, connectorId)).all();
    database.default.update(schema.githubIdentityComparisonRuns).set({
      subIssueGenerationComplete: true,
      subIssueExpectedChildCount: 1,
      subIssueExpectedParentCount: 1,
      subIssuePopulationCount: 0,
      subIssuePopulationDigest: null,
      subIssueObservedChildCount: 0,
      subIssueObservedChildDigest: null,
    }).where(eq(schema.githubIdentityComparisonRuns.connectorInstanceId, connectorId)).run();

    const legacyStatus = identity.getGitHubIdentityComparisonStatus(connectorId, { now }) as {
      soak: { successfulFullEvidenceRuns: number };
      stageTwo: { eligible: boolean; blockers: string[] };
    };
    expect(legacyStatus.soak.successfulFullEvidenceRuns).toBe(0);
    expect(legacyStatus.stageTwo.eligible).toBe(false);
    expect(legacyStatus.stageTwo.blockers).toEqual(expect.arrayContaining([
      'two_successful_full_runs_required',
      'sub_issue_identity_evidence_required',
    ]));

    for (const original of originals) {
      database.default.update(schema.githubIdentityComparisonRuns).set(original)
        .where(eq(schema.githubIdentityComparisonRuns.id, original.id)).run();
    }
    expect(identity.getGitHubStablePrimaryEligibility(connectorId, now))
      .toEqual({ eligible: true, blockers: [] });
  });

  it('cuts over atomically, is idempotent, preserves IDs, isolates connectors, and rolls back immediately', () => {
    const before = database.default.select({
      id: schema.tasks.id,
      sourceId: schema.tasks.sourceId,
    }).from(schema.tasks).where(eq(schema.tasks.connectorInstanceId, connectorId)).all();
    const enabled = identity.enableGitHubStablePrimary({
      connectorInstanceId: connectorId,
      expectedRevision: 1,
      actor: 'cutover-test',
      reason: 'Eligible Stage 3 cutover',
      idempotencyKey: 'stable-enable-once',
      now,
    });
    expect(enabled).toMatchObject({
      ok: true,
      changed: true,
      snapshot: {
        phase: 'stable_primary',
        effectiveMode: 'stable',
        stablePrimaryEnabled: true,
        modeRevision: 2,
      },
    });
    expect(identity.enableGitHubStablePrimary({
      connectorInstanceId: connectorId,
      expectedRevision: 1,
      actor: 'cutover-test',
      reason: 'Eligible Stage 3 cutover',
      idempotencyKey: 'stable-enable-once',
      now,
    })).toMatchObject({ ok: true, changed: false });
    expect(identity.enableGitHubStablePrimary({
      connectorInstanceId: connectorId,
      expectedRevision: 1,
      actor: 'cutover-test',
      reason: 'Concurrent loser',
      idempotencyKey: 'stable-enable-concurrent',
      now,
    })).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(database.default.select({
      id: schema.tasks.id,
      sourceId: schema.tasks.sourceId,
    }).from(schema.tasks).where(eq(schema.tasks.connectorInstanceId, connectorId)).all())
      .toEqual(before);
    expect(database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.connectorInstanceId, connectorId)).all()
      .every((binding) => binding.state === 'active')).toBe(true);
    expect(identity.getGitHubIdentityModeSnapshot('stable-other')).toMatchObject({
      effectiveMode: 'comparison',
      modeRevision: 1,
    });

    database.default.insert(schema.syncJobs).values({
      id: 'stable-running-job',
      connectorId,
      source: 'api',
      status: 'running',
      availableAt: now,
      scheduledFor: now,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      identityMode: 'stable',
      identityModeRevision: 2,
    }).run();
    database.default.insert(schema.taskSourceWriteLeases).values({
      id: 'stable-unknown-write',
      token: 'stable-unknown-token',
      connectorInstanceId: connectorId,
      taskId: 'stable-task',
      operation: 'update',
      taskVersion: now,
      idempotencyKey: 'stable-unknown-write',
      effectiveMode: 'stable',
      modeRevision: 2,
      route: 'stable',
      state: 'unknown',
      expiresAt: '2026-08-10T16:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    }).run();
    expect(identity.rollbackGitHubStablePrimary({
      connectorInstanceId: connectorId,
      expectedRevision: 2,
      actor: 'cutover-test',
      reason: 'Immediate rollback drill',
      idempotencyKey: 'stable-rollback-once',
      now,
    })).toMatchObject({
      ok: true,
      snapshot: {
        phase: 'rollback_legacy',
        effectiveMode: 'legacy',
        stablePrimaryEnabled: false,
        modeRevision: 3,
      },
    });
    expect(database.default.select().from(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, 'stable-unknown-write')).get())
      .toMatchObject({ state: 'unknown', route: 'stable' });
    expect(database.default.select().from(schema.externalEntityBindings)
      .where(eq(schema.externalEntityBindings.connectorInstanceId, connectorId)).all()
      .every((binding) => binding.state === 'active')).toBe(true);
    expect(identity.enableGitHubStablePrimary({
      connectorInstanceId: connectorId,
      expectedRevision: 1,
      actor: 'cutover-test',
      reason: 'Eligible Stage 3 cutover',
      idempotencyKey: 'stable-enable-once',
      now,
    })).toMatchObject({ ok: false, code: 'revision_conflict' });

    const status = identity.getGitHubIdentityComparisonStatus(connectorId, {
      includeEvidence: true,
      limit: 2,
      now,
    }) as {
      cutover: { legacyRetirement: { blocked: boolean } };
      modeAudit: Array<Record<string, unknown>>;
    };
    expect(status.cutover.legacyRetirement.blocked).toBe(true);
    expect(status.modeAudit).toHaveLength(2);
    expect(JSON.stringify(status.modeAudit)).not.toContain('Eligible Stage 3 cutover');
    expect(JSON.stringify(status.modeAudit)).not.toContain('stable-enable-once');

    expect(identity.transitionGitHubIdentityMode({
      connectorInstanceId: connectorId,
      targetPhase: 'comparing',
      stablePrimaryEnabled: false,
      expectedRevision: 3,
      actor: 'cutover-test',
      reason: 'Wrong re-entry gate',
      idempotencyKey: 'rollback-reentry-wrong-gate',
      gate: { code: 'stage_one_ready', passed: true },
      now,
    })).toMatchObject({ ok: false, code: 'gate_required' });
    expect(identity.transitionGitHubIdentityMode({
      connectorInstanceId: connectorId,
      targetPhase: 'comparing',
      stablePrimaryEnabled: false,
      expectedRevision: 3,
      actor: 'cutover-test',
      reason: 'Rollback evidence approved but hazards remain',
      idempotencyKey: 'rollback-reentry-hazards',
      gate: { code: 'rollback_verified', passed: true },
      now,
    })).toMatchObject({ ok: false, code: 'gate_failed' });
    database.default.delete(schema.syncJobs)
      .where(eq(schema.syncJobs.id, 'stable-running-job')).run();
    expect((identity as unknown as Record<string, unknown>).reconcileUnknownGitHubWrite)
      .toBeUndefined();
    database.default.delete(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, 'stable-unknown-write')).run();
    expect(identity.transitionGitHubIdentityMode({
      connectorInstanceId: connectorId,
      targetPhase: 'comparing',
      stablePrimaryEnabled: false,
      expectedRevision: 3,
      actor: 'cutover-test',
      reason: 'Rollback evidence approved',
      idempotencyKey: 'rollback-reentry-approved',
      gate: { code: 'rollback_verified', passed: true },
      now,
    })).toMatchObject({
      ok: true,
      snapshot: { phase: 'comparing', effectiveMode: 'comparison', modeRevision: 4 },
    });
  });
});

function writeLeaseBlocker(
  state: 'claimed' | 'unknown',
  code: string,
): { code: string; add: () => void; remove: () => void } {
  const id = `blocked-lease-${state}`;
  return {
    code,
    add: () => database.default.insert(schema.taskSourceWriteLeases).values({
      id,
      token: `${id}-token`,
      connectorInstanceId: connectorId,
      taskId: 'stable-task',
      operation: 'update',
      taskVersion: now,
      idempotencyKey: id,
      effectiveMode: 'comparison',
      modeRevision: 1,
      state,
      expiresAt: '2026-08-10T16:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    }).run(),
    remove: () => database.default.delete(schema.taskSourceWriteLeases)
      .where(eq(schema.taskSourceWriteLeases.id, id)).run(),
  };
}

function recoveryBlocker(
  recoveryState: 'pending' | 'quarantined',
  code: string,
): { code: string; add: () => void; remove: () => void } {
  const id = `blocked-recovery-${recoveryState}`;
  return {
    code,
    add: () => {
      const task = database.default.select().from(schema.tasks)
        .where(eq(schema.tasks.id, 'stable-task')).get()!;
      database.default.insert(schema.syncDeletionSnapshots).values({
        id,
        originalTaskId: task.id,
        connectorId,
        sourceId: task.sourceId,
        taskTitle: task.title,
        reason: 'blocker fixture',
        taskData: task,
        relationshipData: {},
        deletedAt: now,
        recoveryState,
      }).run();
    },
    remove: () => database.default.delete(schema.syncDeletionSnapshots)
      .where(eq(schema.syncDeletionSnapshots.id, id)).run(),
  };
}

function comparisonRecordBlocker(
  outcome: 'path_reuse' | 'partial_fetch' | 'inaccessible',
  reason: 'locator_owned_by_other_entity' | 'fetch_incomplete' | 'access_denied',
  code: string,
): { code: string; add: () => void; remove: () => void } {
  const id = `blocked-record-${outcome}`;
  return {
    code,
    add: () => database.default.insert(schema.githubIdentityComparisonRecords).values({
      id,
      runId: 'eligible-run-2',
      surface: 'deletion',
      candidateKey: id,
      localTaskId: 'stable-task',
      legacyAction: 'none',
      stableAction: 'none',
      outcome,
      reason,
      createdAt: now,
    }).run(),
    remove: () => database.default.delete(schema.githubIdentityComparisonRecords)
      .where(eq(schema.githubIdentityComparisonRecords.id, id)).run(),
  };
}

function interruptedComparisonBlocker(
  id: string,
  syncKind: 'full' | 'incremental',
  interruptionSurface: 'comparison' | 'sub_issue',
  code: string,
): { code: string; add: () => void; remove: () => void } {
  return {
    code,
    add: () => database.default.insert(schema.githubIdentityComparisonRuns).values({
      id,
      connectorInstanceId: connectorId,
      identityMode: 'comparison',
      identityModeRevision: 0,
      syncKind,
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface,
      interruptedAt: now,
      interruptionReason: 'test_interruption',
      startedAt: now,
      completedAt: now,
    }).run(),
    remove: () => database.default.delete(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, id)).run(),
  };
}

function seedEligibleConnector(): void {
  const population = buildGitHubNativeTaskPopulation([{
    id: 'stable-task',
    sourceId: 'owner/repo:1',
    connectorInstanceId: connectorId,
    connectorType: 'github-issues',
    isChecklistItem: false,
    metadata: { issueNumber: 1 },
  }], connectorId, new Map());
  const [populationMember] = population.members;
  database.default.insert(schema.connectorConfigs).values([
    connector(connectorId),
    connector('stable-other'),
  ]).run();
  database.default.insert(schema.githubIdentityMigrations).values([
    { connectorInstanceId: connectorId, phase: 'comparing', updatedAt: now },
    { connectorInstanceId: 'stable-other', phase: 'comparing', updatedAt: now },
  ]).run();
  database.default.insert(schema.githubIdentityControls).values([
    {
      connectorInstanceId: connectorId,
      stablePrimaryEnabled: false,
      modeRevision: 1,
      updatedAt: now,
    },
    {
      connectorInstanceId: 'stable-other',
      stablePrimaryEnabled: false,
      modeRevision: 1,
      updatedAt: now,
    },
  ]).run();
  database.default.insert(schema.sourceLists).values({
    id: 'stable-list',
    connectorInstanceId: connectorId,
    sourceId: 'owner/repo',
    name: 'owner/repo',
    type: 'repo',
  }).run();
  database.default.insert(schema.tasks).values({
    id: 'stable-task',
    sourceId: 'owner/repo:1',
    sourceListId: 'stable-list',
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: 'Stable task',
    status: 'todo',
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    metadata: { issueNumber: 1 },
  }).run();
  database.default.insert(schema.externalEntities).values([
    {
      id: 'stable-repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository',
      stableId: 'R_stable',
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      id: 'stable-issue-entity',
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'issue',
      stableId: 'I_stable',
      firstSeenAt: now,
      lastSeenAt: now,
    },
  ]).run();
  database.default.insert(schema.externalEntityLocators).values([
    {
      id: 'stable-repo-locator',
      externalEntityId: 'stable-repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'graphql',
      locatorRevision: 1,
    },
    {
      id: 'stable-issue-locator',
      externalEntityId: 'stable-issue-entity',
      repositoryEntityId: 'stable-repo-entity',
      provider: 'github',
      hostKey: 'github.com',
      owner: 'owner',
      repository: 'repo',
      ownerKey: 'owner',
      repositoryKey: 'repo',
      issueNumber: 1,
      validFrom: now,
      lastSeenAt: now,
      observationSource: 'graphql',
      locatorRevision: 1,
    },
  ]).run();
  database.default.insert(schema.externalEntityBindings).values([
    {
      id: 'stable-repo-binding',
      externalEntityId: 'stable-repo-entity',
      connectorInstanceId: connectorId,
      bindingType: 'source_list',
      localId: 'stable-list',
      state: 'shadow',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'stable-task-binding',
      externalEntityId: 'stable-issue-entity',
      connectorInstanceId: connectorId,
      bindingType: 'task',
      localId: 'stable-task',
      state: 'shadow',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).run();
  database.default.insert(schema.githubIdentityComparisonRuns).values([
    {
      id: 'eligible-run-1',
      connectorInstanceId: connectorId,
      identityMode: 'comparison',
      identityModeRevision: 1,
      syncKind: 'full',
      state: 'succeeded',
      pageCount: 1,
      queryCount: 1,
      evidenceEligible: true,
      subIssueGenerationComplete: true,
      subIssueExpectedChildCount: 1,
      subIssueExpectedParentCount: 1,
      subIssuePopulationCount: population.count,
      subIssuePopulationDigest: population.digest,
      subIssueObservedChildCount: population.count,
      subIssueObservedChildDigest: population.digest,
      startedAt: '2026-08-10T13:00:00.000Z',
      completedAt: '2026-08-10T14:00:00.000Z',
    },
    {
      id: 'eligible-run-2',
      connectorInstanceId: connectorId,
      identityMode: 'comparison',
      identityModeRevision: 1,
      syncKind: 'full',
      state: 'succeeded',
      pageCount: 1,
      queryCount: 2,
      evidenceEligible: true,
      subIssueGenerationComplete: true,
      subIssueExpectedChildCount: 1,
      subIssueExpectedParentCount: 1,
      subIssuePopulationCount: population.count,
      subIssuePopulationDigest: population.digest,
      subIssueObservedChildCount: population.count,
      subIssueObservedChildDigest: population.digest,
      startedAt: '2026-08-10T13:30:00.000Z',
      completedAt: '2026-08-10T14:00:00.000Z',
    },
  ]).run();
  database.default.insert(schema.githubIdentitySubIssuePopulationMembers).values([
    {
      id: 'eligible-population-member-run-1',
      runId: 'eligible-run-1',
      localTaskId: populationMember.localTaskId,
      sourceIdDigest: populationMember.sourceIdDigest,
      issueNumber: populationMember.issueNumber,
      memberDigest: populationMember.memberDigest,
      observed: true,
      createdAt: now,
    },
    {
      id: 'eligible-population-member',
      runId: 'eligible-run-2',
      localTaskId: populationMember.localTaskId,
      sourceIdDigest: populationMember.sourceIdDigest,
      issueNumber: populationMember.issueNumber,
      memberDigest: populationMember.memberDigest,
      observed: true,
      createdAt: now,
    },
  ]).run();
  database.default.insert(schema.githubIdentityComparisonRecords).values([
    {
      id: 'eligible-run-1-record-child',
      runId: 'eligible-run-1',
      surface: 'sub_issue',
      candidateKey: 'sub_issue:owner/repo:1:child',
      localTaskId: 'stable-task',
      legacySelectedLocalId: 'stable-task',
      stableSelectedLocalId: 'stable-task',
      legacyAction: 'present',
      stableAction: 'present',
      outcome: 'agreement',
      reason: 'exact_match',
      createdAt: now,
    },
    {
      id: 'eligible-run-1-record-parent',
      runId: 'eligible-run-1',
      surface: 'sub_issue',
      candidateKey: 'sub_issue:owner/repo:1:parent',
      localTaskId: 'stable-task',
      legacySelectedLocalId: 'stable-task',
      stableSelectedLocalId: 'stable-task',
      legacyAction: 'present',
      stableAction: 'present',
      outcome: 'agreement',
      reason: 'exact_match',
      createdAt: now,
    },
  ]).run();
  const records = [
    ['dependency', 'dependency:endpoint:owner/repo:1'],
    ['dependency', 'dependency:endpoint:owner/repo:2'],
    ['sub_issue', 'sub_issue:owner/repo:1:child'],
    ['sub_issue', 'sub_issue:owner/repo:1:parent'],
  ] as const;
  database.default.insert(schema.githubIdentityComparisonRecords).values(
    records.map(([surface, candidateKey], index) => ({
      id: `eligible-record-${index}`,
      runId: 'eligible-run-2',
      surface,
      candidateKey,
      localTaskId: 'stable-task',
      legacySelectedLocalId: 'stable-task',
      stableSelectedLocalId: 'stable-task',
      legacyAction: 'present' as const,
      stableAction: 'present' as const,
      outcome: 'agreement' as const,
      reason: 'exact_match' as const,
      createdAt: now,
    })),
  ).run();
  database.default.insert(schema.dependencyReconciliationSnapshots).values({
    id: 'eligible-dependency',
    connectorInstanceId: connectorId,
    status: 'completed',
    phase: 'completed',
    readMode: 'graphql-bulk',
    total: 1,
    batchSize: 50,
    identityMode: 'comparison',
    identityModeRevision: 1,
    identityEvidenceSource: 'graphql-node',
    identityEvidenceEligible: true,
    identityComparisonRunId: 'eligible-run-2',
    startedAt: '2026-08-10T13:30:00.000Z',
    updatedAt: '2026-08-10T14:00:00.000Z',
    completedAt: '2026-08-10T14:00:00.000Z',
  }).run();
  database.default.insert(schema.dependencyReconciliationItems).values({
    snapshotId: 'eligible-dependency',
    position: 0,
    sourceId: 'owner/repo:1',
    verified: true,
    identityEvidenceState: 'verified',
  }).run();
  database.default.insert(schema.dependencyReconciliationEdges).values({
    snapshotId: 'eligible-dependency',
    blockedSourceId: 'owner/repo:1',
    blockerSourceId: 'owner/repo:2',
    blockerIdentityEvidenceState: 'verified',
  }).run();
  database.default.insert(schema.githubIdentityWriteCycles).values({
    id: 'eligible-write-cycle',
    connectorInstanceId: connectorId,
    effectiveMode: 'comparison',
    modeRevision: 1,
    pendingCandidateCount: 1,
    observedRouteCount: 1,
    legacyAppliedCount: 1,
    state: 'completed',
    startedAt: '2026-08-10T13:00:00.000Z',
    completedAt: '2026-08-10T14:00:00.000Z',
  }).run();
}

function connector(id: string): typeof schema.connectorConfigs.$inferInsert {
  return {
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual',
    capabilities: {},
    credentials: {},
    settings: { repos: ['owner/repo'] },
    syncedLists: ['owner/repo'],
    createdAt: now,
    updatedAt: now,
  };
}
