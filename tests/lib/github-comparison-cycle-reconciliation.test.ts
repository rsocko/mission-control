import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { digestGitHubTaskPopulationMembers } from '@/lib/sync/github-native-task';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

process.env.MC_DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

const now = '2026-08-11T12:00:00.000Z';
const memberDigest = 'a'.repeat(64);
const populationDigest = digestGitHubTaskPopulationMembers([memberDigest]);

beforeAll(async () => {
  vi.resetModules();
  [database, schema, identity] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
  ]);
});

describe('GitHub interrupted comparison-cycle reconciliation', () => {
  it('audits an empty current-revision runtime failure and clears only its status gate', () => {
    const connectorId = seedConnector('comparison-no-write');
    const ownerId = 'runtime:0d5ce6df-8324-4b39-a9e3-e631440c09ac';
    seedRun(connectorId, 'empty-runtime-failure', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId,
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    const command = {
      connectorInstanceId: connectorId,
      runId: 'empty-runtime-failure',
      expectedRevision: 1,
      action: 'resolve_no_write' as const,
      actor: 'cutover-operator',
      reason: 'Confirmed the interrupted runtime emitted no comparison or write evidence',
      idempotencyKey: 'resolve-empty-runtime-failure',
      now,
    };
    const before = identity.getGitHubIdentityComparisonStatus(connectorId, { now }) as {
      operationalState: {
        comparisonCycleReconciliation: {
          comparisonUnresolvedCount: number;
          cycles: Array<Record<string, unknown>>;
        };
      };
      stageTwo: { blockers: string[] };
    };
    expect(before.operationalState.comparisonCycleReconciliation.comparisonUnresolvedCount)
      .toBe(1);
    expect(before.stageTwo.blockers).toContain('comparison_cycle_unresolved');
    expect(JSON.stringify(before.operationalState.comparisonCycleReconciliation.cycles))
      .not.toContain(ownerId);

    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: true,
      runId: 'empty-runtime-failure',
      state: 'resolved',
      successorRunId: null,
    });
    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: false,
      runId: 'empty-runtime-failure',
      state: 'resolved',
      successorRunId: null,
    });
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...command,
      idempotencyKey: 'concurrent-empty-runtime-resolution',
    })).toThrow('not unresolved');

    const row = database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, command.runId)).get();
    expect(row).toMatchObject({
      interruptionState: 'resolved',
      reconciledBy: command.actor,
      reconciliationReason: command.reason,
      reconciliationKey: command.idempotencyKey,
      resolvedByRunId: null,
    });
    const after = identity.getGitHubIdentityComparisonStatus(connectorId, { now }) as {
      operationalState: {
        comparisonCycleReconciliation: { comparisonUnresolvedCount: number };
      };
      stageTwo: { blockers: string[] };
    };
    expect(after.operationalState.comparisonCycleReconciliation.comparisonUnresolvedCount)
      .toBe(0);
    expect(after.stageTwo.blockers).not.toContain('comparison_cycle_unresolved');
  });

  it('rejects comparison evidence, incomplete sub-issue work, and stale revisions', () => {
    const recordConnector = seedConnector('comparison-no-write-record');
    seedRun(recordConnector, 'failed-with-record', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId: 'runtime:record-owner',
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    database.default.insert(schema.githubIdentityComparisonRecords).values({
      id: 'failed-with-record-evidence',
      runId: 'failed-with-record',
      surface: 'task',
      candidateKey: 'owner/repo:1',
      legacyAction: 'none',
      stableAction: 'none',
      outcome: 'agreement',
      reason: 'exact_match',
      createdAt: now,
    }).run();
    expect(() => identity.reconcileGitHubComparisonCycle(noWriteCommand(
      recordConnector,
      'failed-with-record',
      'record-evidence-resolution',
    ))).toThrow('zero comparison records');

    const subIssueConnector = seedConnector('comparison-no-write-sub-issue');
    seedRun(subIssueConnector, 'incomplete-sub-issue', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      syncKind: 'full',
      subIssueGenerationComplete: false,
      ownerId: 'runtime:sub-issue-owner',
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    expect(() => identity.reconcileGitHubComparisonCycle(noWriteCommand(
      subIssueConnector,
      'incomplete-sub-issue',
      'sub-issue-resolution',
    ))).toThrow('incremental runs');

    const staleConnector = seedConnector('comparison-no-write-stale', 2);
    seedRun(staleConnector, 'prior-revision-failure', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      identityModeRevision: 1,
      ownerId: 'runtime:stale-owner',
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...noWriteCommand(staleConnector, 'prior-revision-failure', 'stale-resolution'),
      expectedRevision: 2,
    })).toThrow('current-revision');
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...noWriteCommand(staleConnector, 'prior-revision-failure', 'stale-fence'),
      expectedRevision: 1,
    })).toThrow('revision conflict');
  });

  it('rejects every linked write cycle and lease state, including terminal success', () => {
    const cycleConnector = seedConnector('comparison-no-write-cycle');
    seedRun(cycleConnector, 'failed-with-cycle', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId: 'runtime:cycle-owner',
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: 'linked-write-cycle',
      connectorInstanceId: cycleConnector,
      comparisonRunId: 'failed-with-cycle',
      effectiveMode: 'comparison',
      modeRevision: 1,
      state: 'interrupted',
      startedAt: now,
      completedAt: now,
    }).run();
    expect(() => identity.reconcileGitHubComparisonCycle(noWriteCommand(
      cycleConnector,
      'failed-with-cycle',
      'cycle-evidence-resolution',
    ))).toThrow('zero linked write cycles');

    for (const state of [
      'claimed',
      'authorized',
      'dispatched',
      'unknown',
      'succeeded',
    ] as const) {
      const connectorId = seedConnector(`comparison-no-write-lease-${state}`);
      const runId = `failed-with-${state}-lease`;
      seedRun(connectorId, runId, {
        state: 'failed',
        evidenceEligible: false,
        interruptionState: 'unresolved',
        interruptionSurface: 'comparison',
        syncKind: 'incremental',
        ownerId: `runtime:${state}-owner`,
        ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
        ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
      });
      database.default.insert(schema.taskSourceWriteLeases).values({
        id: `${state}-write-lease`,
        token: `${state}-write-token`,
        connectorInstanceId: connectorId,
        taskId: `${state}-task`,
        operation: 'update',
        taskVersion: now,
        idempotencyKey: `${state}-write-lease`,
        effectiveMode: 'comparison',
        modeRevision: 1,
        comparisonRunId: runId,
        state,
        dispatchedAt: ['dispatched', 'unknown', 'succeeded'].includes(state) ? now : null,
        finalizedAt: state === 'succeeded' ? now : null,
        expiresAt: '2026-08-11T13:00:00.000Z',
        createdAt: now,
        updatedAt: now,
      }).run();
      expect(() => identity.reconcileGitHubComparisonCycle(noWriteCommand(
        connectorId,
        runId,
        `${state}-lease-resolution`,
      )), state).toThrow('zero linked write leases');
    }
  });

  it('requires an expired owner heartbeat and rejects a restarted successor', () => {
    const connectorId = seedConnector('comparison-no-write-owner');
    seedRun(connectorId, 'owner-active-failure', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId: 'runtime:restarted-owner',
      ownerHeartbeatAt: '2026-08-11T11:59:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T12:14:00.000Z',
    });
    const command = noWriteCommand(
      connectorId,
      'owner-active-failure',
      'active-owner-resolution',
    );
    expect(() => identity.reconcileGitHubComparisonCycle(command))
      .toThrow('run owner is inactive');

    database.default.update(schema.githubIdentityComparisonRuns).set({
      ownerLeaseExpiresAt: '2026-08-11T11:59:59.000Z',
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'owner-active-failure')).run();
    const successor = identity.startGitHubIdentityComparisonRun({
      id: 'restarted-owner-successor',
      connectorInstanceId: connectorId,
      identityMode: 'comparison',
      identityModeRevision: 1,
      syncKind: 'incremental',
      ownerId: 'runtime:restarted-owner',
      ownerToken: 'restart-secret',
      startedAt: '2026-08-11T12:01:00.000Z',
    });
    expect(successor.predecessorRunId).toBe('owner-active-failure');
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...command,
      idempotencyKey: 'restarted-owner-resolution',
    })).toThrow('successor run has started');
  });

  it('rejects unrelated active write work while proving connector inactivity', () => {
    const connectorId = seedConnector('comparison-no-write-active-lease');
    seedRun(connectorId, 'empty-run-with-active-lease', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId: 'runtime:inactive-owner',
      ownerHeartbeatAt: '2026-08-11T11:00:00.000Z',
      ownerLeaseExpiresAt: '2026-08-11T11:15:00.000Z',
    });
    database.default.insert(schema.taskSourceWriteLeases).values({
      id: 'unrelated-active-write-lease',
      token: 'unrelated-active-write-token',
      connectorInstanceId: connectorId,
      taskId: 'other-task',
      operation: 'update',
      taskVersion: now,
      idempotencyKey: 'unrelated-active-write-lease',
      effectiveMode: 'comparison',
      modeRevision: 1,
      state: 'claimed',
      expiresAt: '2026-08-11T13:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    }).run();
    expect(() => identity.reconcileGitHubComparisonCycle(noWriteCommand(
      connectorId,
      'empty-run-with-active-lease',
      'active-write-resolution',
    ))).toThrow('zero active or ambiguous write leases');
  });

  it('resolves only a complete owner-linked replacement and replays idempotently', () => {
    const connectorId = seedConnector('comparison-replacement');
    seedRun(connectorId, 'interrupted', {
      state: 'cancelled',
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      ownerId: 'job:sync-1',
    });
    seedRun(connectorId, 'successor', {
      predecessorRunId: 'interrupted',
      ownerId: 'job:sync-1',
    });
    seedCompleteAttestation('successor');
    const command = {
      connectorInstanceId: connectorId,
      runId: 'interrupted',
      expectedRevision: 1,
      action: 'replacement' as const,
      successorRunId: 'successor',
      actor: 'cutover-operator',
      reason: 'Verified complete owner-linked replacement generation',
      idempotencyKey: 'replacement-interrupted-successor',
      now,
    };

    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: true,
      runId: 'interrupted',
      state: 'resolved',
      successorRunId: 'successor',
    });
    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: false,
      runId: 'interrupted',
      state: 'resolved',
      successorRunId: 'successor',
    });
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...command,
      idempotencyKey: 'second-owner-resolution-attempt',
    })).toThrow('not unresolved');
  });

  it('atomically links a fresh authoritative full successor across runtime owners', () => {
    const connectorId = seedConnector('comparison-fresh-full-replacement');
    seedRun(connectorId, 'fresh-full-interrupted', {
      state: 'cancelled',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      ownerId: 'job:owner-before-restart',
      ownerLeaseExpiresAt: '2026-08-10T14:59:00.000Z',
      startedAt: '2026-08-10T13:00:00.000Z',
      completedAt: '2026-08-10T14:00:00.000Z',
      interruptedAt: '2026-08-10T14:00:00.000Z',
    });
    seedRun(connectorId, 'fresh-full-successor', {
      ownerId: 'job:owner-after-restart',
      startedAt: '2026-08-10T15:01:00.000Z',
      completedAt: '2026-08-10T15:02:00.000Z',
    });
    seedCompleteAttestation('fresh-full-successor');
    const command = {
      connectorInstanceId: connectorId,
      runId: 'fresh-full-interrupted',
      expectedRevision: 1,
      action: 'replacement' as const,
      successorRunId: 'fresh-full-successor',
      actor: 'cutover-operator',
      reason: 'Verified fresh authoritative full successor after inactive owner restart',
      idempotencyKey: 'fresh-authoritative-full-replacement',
      now,
    };

    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: true,
      runId: 'fresh-full-interrupted',
      state: 'resolved',
      successorRunId: 'fresh-full-successor',
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, 'fresh-full-successor')).get())
      .toMatchObject({ predecessorRunId: 'fresh-full-interrupted' });
    expect(identity.reconcileGitHubComparisonCycle(command)).toMatchObject({
      changed: false,
      successorRunId: 'fresh-full-successor',
    });
    database.default.update(schema.githubIdentityComparisonRuns).set({
      predecessorRunId: null,
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'fresh-full-successor')).run();
    expect(() => identity.reconcileGitHubComparisonCycle(command))
      .toThrow('idempotency conflict');
  });

  it.each([
    'sub_issue_generation_incomplete',
    'sub_issue_child_unresolved',
  ])('replaces a succeeded full predecessor with approved incomplete reason %s', (reason) => {
    const seeded = seedSucceededIncompleteReplacement(reason, reason);

    expect(identity.reconcileGitHubComparisonCycle(seeded.command)).toEqual({
      changed: true,
      runId: seeded.predecessorId,
      state: 'resolved',
      successorRunId: seeded.successorId,
    });
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, seeded.successorId)).get())
      .toMatchObject({ predecessorRunId: null });
    expect(identity.reconcileGitHubComparisonCycle(seeded.command)).toEqual({
      changed: false,
      runId: seeded.predecessorId,
      state: 'resolved',
      successorRunId: seeded.successorId,
    });
  });

  it('accepts exactly one owner-linked successor for the approved succeeded category', () => {
    const seeded = seedSucceededIncompleteReplacement(
      'owner-linked-succeeded-incomplete',
      'sub_issue_child_unresolved',
    );
    database.default.update(schema.githubIdentityComparisonRuns).set({
      predecessorRunId: seeded.predecessorId,
      ownerId: `job:inactive-owner-linked-succeeded-incomplete`,
    }).where(eq(schema.githubIdentityComparisonRuns.id, seeded.successorId)).run();

    expect(identity.reconcileGitHubComparisonCycle(seeded.command)).toMatchObject({
      changed: true,
      successorRunId: seeded.successorId,
    });
  });

  it('reuses one unlinked authoritative successor across incomplete succeeded predecessors', () => {
    const connectorId = seedConnector('shared-succeeded-incomplete-successor');
    const successorId = 'shared-authoritative-successor';
    seedRun(connectorId, 'shared-incomplete-predecessor-one', {
      state: 'succeeded',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      interruptionReason: 'sub_issue_generation_incomplete',
      ownerId: 'job:inactive-shared-one',
      ownerLeaseExpiresAt: '2026-08-10T14:59:00.000Z',
      startedAt: '2026-08-10T13:00:00.000Z',
      completedAt: '2026-08-10T14:00:00.000Z',
      interruptedAt: '2026-08-10T14:00:00.000Z',
      subIssueGenerationComplete: false,
    });
    seedRun(connectorId, 'shared-incomplete-predecessor-two', {
      state: 'succeeded',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      interruptionReason: 'sub_issue_child_unresolved',
      ownerId: 'job:inactive-shared-two',
      ownerLeaseExpiresAt: '2026-08-10T14:59:00.000Z',
      startedAt: '2026-08-10T13:30:00.000Z',
      completedAt: '2026-08-10T14:30:00.000Z',
      interruptedAt: '2026-08-10T14:30:00.000Z',
    });
    seedRun(connectorId, successorId, {
      ownerId: 'job:shared-authoritative-successor',
      startedAt: '2026-08-10T15:01:00.000Z',
      completedAt: '2026-08-10T15:02:00.000Z',
    });
    seedCompleteAttestation(successorId);
    const commands = [
      replacementCommand(
        connectorId,
        'shared-incomplete-predecessor-one',
        successorId,
        'replace-shared-predecessor-one',
      ),
      replacementCommand(
        connectorId,
        'shared-incomplete-predecessor-two',
        successorId,
        'replace-shared-predecessor-two',
      ),
    ];

    for (const command of commands) {
      expect(identity.reconcileGitHubComparisonCycle(command)).toMatchObject({
        changed: true,
        successorRunId: successorId,
      });
      expect(identity.reconcileGitHubComparisonCycle(command)).toMatchObject({
        changed: false,
        successorRunId: successorId,
      });
    }
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, successorId)).get())
      .toMatchObject({ predecessorRunId: null });
  });

  it.each([
    {
      name: 'an arbitrary interruption reason',
      predecessor: { interruptionReason: 'comparison_failed' },
    },
    {
      name: 'an eligible predecessor',
      predecessor: { evidenceEligible: true },
    },
    {
      name: 'another interruption surface',
      predecessor: { interruptionSurface: 'comparison' as const },
    },
    {
      name: 'an incremental predecessor',
      predecessor: { syncKind: 'incremental' as const },
    },
    {
      name: 'a prior-revision predecessor and successor',
      predecessor: { identityModeRevision: 0 },
      successor: { identityModeRevision: 0 },
    },
    {
      name: 'a predecessor and successor in another mode',
      predecessor: { identityMode: 'legacy' as const },
      successor: { identityMode: 'legacy' as const },
    },
    {
      name: 'a successor that did not start after the interruption',
      successor: { startedAt: '2026-08-10T14:00:00.000Z' },
    },
    {
      name: 'an incremental successor',
      successor: { syncKind: 'incremental' as const },
    },
    {
      name: 'a failed successor',
      successor: { state: 'failed' as const },
    },
    {
      name: 'an ineligible successor',
      successor: { evidenceEligible: false },
    },
  ])('rejects succeeded incomplete replacement with $name', ({
    name,
    predecessor = {},
    successor = {},
  }) => {
    const seeded = seedSucceededIncompleteReplacement(name, 'sub_issue_generation_incomplete', {
      predecessor,
      successor,
    });

    expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
      .toThrow('complete authoritative replacement');
  });

  it('rejects an eligible succeeded successor with incomplete attestation', () => {
    const seeded = seedSucceededIncompleteReplacement(
      'incomplete-successor-attestation',
      'sub_issue_generation_incomplete',
    );
    database.default.delete(schema.githubIdentitySubIssuePopulationMembers)
      .where(eq(schema.githubIdentitySubIssuePopulationMembers.runId, seeded.successorId))
      .run();

    expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
      .toThrow('complete authoritative replacement');
  });

  it('rejects succeeded predecessors whose sub-issue attestation is already complete', () => {
    const seeded = seedSucceededIncompleteReplacement(
      'complete-predecessor-attestation',
      'sub_issue_child_unresolved',
    );
    seedCompleteAttestation(seeded.predecessorId);

    expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
      .toThrow('complete authoritative replacement');
  });

  it('rejects ambiguous owner-linked successor lineage', () => {
    const seeded = seedSucceededIncompleteReplacement(
      'ambiguous-owner-linked-lineage',
      'sub_issue_generation_incomplete',
    );
    database.default.update(schema.githubIdentityComparisonRuns).set({
      predecessorRunId: seeded.predecessorId,
      ownerId: 'job:inactive-ambiguous-owner-linked-lineage',
    }).where(eq(schema.githubIdentityComparisonRuns.id, seeded.successorId)).run();
    seedRun(seeded.connectorId, 'second-owner-linked-successor', {
      predecessorRunId: seeded.predecessorId,
      ownerId: 'job:inactive-ambiguous-owner-linked-lineage',
      startedAt: '2026-08-10T15:03:00.000Z',
      completedAt: '2026-08-10T15:04:00.000Z',
    });

    expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
      .toThrow('lineage is already assigned');
  });

  it.each(['predecessor', 'successor'] as const)(
    'rejects blocking comparison evidence on the %s',
    (blockedRun) => {
      const seeded = seedSucceededIncompleteReplacement(
        `blocked-${blockedRun}`,
        'sub_issue_generation_incomplete',
      );
      database.default.insert(schema.githubIdentityComparisonRecords).values({
        id: `${seeded.predecessorId}-${blockedRun}-blocker`,
        runId: blockedRun === 'predecessor'
          ? seeded.predecessorId
          : seeded.successorId,
        surface: 'task',
        candidateKey: `task:${blockedRun}:blocker`,
        localTaskId: `${blockedRun}-blocked-task`,
        legacyAction: 'update',
        stableAction: 'present',
        outcome: 'stable_legacy_disagree',
        reason: 'selected_ids_differ',
        createdAt: now,
      }).run();

      expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
        .toThrow('blocking comparison evidence');
    },
  );

  it('rejects an active predecessor owner and active connector runtime', () => {
    const activeOwner = seedSucceededIncompleteReplacement(
      'active-predecessor-owner',
      'sub_issue_generation_incomplete',
      { predecessor: { ownerLeaseExpiresAt: '2026-08-11T12:15:00.000Z' } },
    );
    expect(() => identity.reconcileGitHubComparisonCycle(activeOwner.command))
      .toThrow('inactive predecessor owner');

    const activeRuntime = seedSucceededIncompleteReplacement(
      'active-connector-runtime',
      'sub_issue_generation_incomplete',
    );
    database.default.insert(schema.syncJobs).values({
      id: 'active-succeeded-incomplete-replacement-job',
      connectorId: activeRuntime.connectorId,
      source: 'api',
      status: 'queued',
      availableAt: now,
      scheduledFor: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    expect(() => identity.reconcileGitHubComparisonCycle(activeRuntime.command))
      .toThrow('inactive connector runtime');
  });

  it('rejects linked writes and preserves unassigned successor lineage', () => {
    const seeded = seedSucceededIncompleteReplacement(
      'linked-write',
      'sub_issue_child_unresolved',
    );
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: 'succeeded-incomplete-linked-write-cycle',
      connectorInstanceId: seeded.connectorId,
      comparisonRunId: seeded.predecessorId,
      effectiveMode: 'comparison',
      modeRevision: 1,
      state: 'completed',
      startedAt: now,
      completedAt: now,
    }).run();

    expect(() => identity.reconcileGitHubComparisonCycle(seeded.command))
      .toThrow('zero linked or ambiguous writes');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, seeded.successorId)).get())
      .toMatchObject({ predecessorRunId: null });
  });

  it('refuses fresh full replacement with linked writes or assigned lineage', () => {
    const connectorId = seedConnector('comparison-fresh-full-refusal');
    seedRun(connectorId, 'fresh-refusal-interrupted', {
      state: 'failed',
      evidenceEligible: false,
      interruptionState: 'unresolved',
      interruptionSurface: 'sub_issue',
      ownerId: 'job:inactive-owner',
      ownerLeaseExpiresAt: '2026-08-10T14:59:00.000Z',
      completedAt: '2026-08-10T14:00:00.000Z',
      interruptedAt: '2026-08-10T14:00:00.000Z',
    });
    seedRun(connectorId, 'fresh-refusal-successor', {
      ownerId: 'job:fresh-owner',
      startedAt: '2026-08-10T15:01:00.000Z',
      completedAt: '2026-08-10T15:02:00.000Z',
    });
    seedCompleteAttestation('fresh-refusal-successor');
    database.default.insert(schema.githubIdentityComparisonRecords).values({
      id: 'fresh-refusal-blocking-record',
      runId: 'fresh-refusal-successor',
      surface: 'task',
      candidateKey: 'task:fresh-refusal-blocking',
      localTaskId: 'fresh-refusal-task',
      legacyAction: 'update',
      stableAction: 'present',
      outcome: 'stable_legacy_disagree',
      reason: 'selected_ids_differ',
      createdAt: now,
    }).run();
    const command = {
      connectorInstanceId: connectorId,
      runId: 'fresh-refusal-interrupted',
      expectedRevision: 1,
      action: 'replacement' as const,
      successorRunId: 'fresh-refusal-successor',
      actor: 'cutover-operator',
      reason: 'Replacement must refuse every linked ambiguous write outcome',
      idempotencyKey: 'fresh-authoritative-refusal',
      now,
    };

    expect(() => identity.reconcileGitHubComparisonCycle(command))
      .toThrow('blocking comparison evidence');
    database.default.delete(schema.githubIdentityComparisonRecords)
      .where(eq(
        schema.githubIdentityComparisonRecords.id,
        'fresh-refusal-blocking-record',
      )).run();
    database.default.insert(schema.taskSourceWriteLeases).values({
      id: 'fresh-refusal-write',
      token: 'fresh-refusal-write-token',
      connectorInstanceId: connectorId,
      comparisonRunId: 'fresh-refusal-interrupted',
      taskId: 'fresh-refusal-task',
      operation: 'update',
      taskVersion: now,
      idempotencyKey: 'fresh-refusal-task:update:version',
      effectiveMode: 'comparison',
      modeRevision: 1,
      state: 'unknown',
      dispatchedAt: '2026-08-10T14:00:01.000Z',
      expiresAt: '2026-08-10T14:10:00.000Z',
      createdAt: now,
      updatedAt: now,
    }).run();

    expect(() => identity.reconcileGitHubComparisonCycle(command))
      .toThrow('zero linked or ambiguous writes');
    expect(database.default.select().from(schema.githubIdentityComparisonRuns)
      .where(eq(schema.githubIdentityComparisonRuns.id, 'fresh-refusal-successor')).get())
      .toMatchObject({ predecessorRunId: null });
  });

  it('rejects unrelated, incomplete, stale-revision, and concurrent successors', () => {
    const connectorId = seedConnector('comparison-fencing');
    seedRun(connectorId, 'fenced-interrupted', {
      state: 'failed',
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      ownerId: 'job:owner-a',
    });
    seedRun(connectorId, 'unrelated-successor', {
      ownerId: 'job:owner-b',
    });
    seedCompleteAttestation('unrelated-successor');

    const base = {
      connectorInstanceId: connectorId,
      runId: 'fenced-interrupted',
      expectedRevision: 1,
      action: 'replacement' as const,
      successorRunId: 'unrelated-successor',
      actor: 'cutover-operator',
      reason: 'Attempted replacement must retain durable lineage',
      idempotencyKey: 'unrelated-replacement-attempt',
      now,
    };
    expect(() => identity.reconcileGitHubComparisonCycle(base))
      .toThrow('complete authoritative replacement');
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...base,
      expectedRevision: 0,
      idempotencyKey: 'stale-revision-attempt',
    })).toThrow('revision conflict');

    database.default.update(schema.githubIdentityComparisonRuns).set({
      predecessorRunId: 'fenced-interrupted',
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'unrelated-successor')).run();
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...base,
      idempotencyKey: 'wrong-owner-replacement-attempt',
    })).toThrow('complete authoritative replacement');

    database.default.update(schema.githubIdentityComparisonRuns).set({
      ownerId: 'job:owner-a',
      evidenceEligible: false,
    }).where(eq(schema.githubIdentityComparisonRuns.id, 'unrelated-successor')).run();
    expect(() => identity.reconcileGitHubComparisonCycle({
      ...base,
      idempotencyKey: 'incomplete-replacement-attempt',
    })).toThrow('complete authoritative replacement');
  });

  it('retains durable same-job lineage across process restart tokens', () => {
    const connectorId = seedConnector('comparison-restart');
    seedRun(connectorId, 'restart-interrupted-root', {
    state: 'cancelled',
    interruptionState: 'unresolved',
    interruptionSurface: 'sub_issue',
    ownerId: 'job:restart-job',
    ownerTokenDigest: 'c'.repeat(64),
    });
    seedRun(connectorId, 'restart-interrupted', {
    state: 'cancelled',
    interruptionState: 'unresolved',
    interruptionSurface: 'sub_issue',
    ownerId: 'job:restart-job',
    ownerTokenDigest: 'd'.repeat(64),
    predecessorRunId: 'restart-interrupted-root',
    });
    const successor = identity.startGitHubIdentityComparisonRun({
    id: 'restart-successor',
    connectorInstanceId: connectorId,
    jobId: 'restart-job',
    identityMode: 'comparison',
    identityModeRevision: 1,
    syncKind: 'full',
    ownerId: 'job:restart-job',
    ownerToken: 'new-process-token',
    startedAt: '2026-08-11T12:01:00.000Z',
    });
    expect(successor.predecessorRunId).toBe('restart-interrupted');

    seedCompleteAttestation(successor.id);
    identity.completeGitHubIdentityComparisonRun(successor.id, {
    state: 'succeeded',
    pageCount: 1,
    queryCount: 1,
    outcomeCounts: { agreement: 1 },
    evidenceEligible: true,
    subIssueGenerationComplete: true,
    subIssueExpectedChildCount: 1,
    subIssueExpectedParentCount: 0,
    subIssuePopulationCount: 1,
    subIssuePopulationDigest: populationDigest,
    subIssueObservedChildCount: 1,
    subIssueObservedChildDigest: populationDigest,
    ownerToken: 'new-process-token',
    completedAt: '2026-08-11T12:02:00.000Z',
    });
    const resolved = database.default.select().from(schema.githubIdentityComparisonRuns)
    .where(eq(schema.githubIdentityComparisonRuns.ownerId, 'job:restart-job')).all();
    expect(resolved).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 'restart-interrupted',
      interruptionState: 'resolved',
      resolvedByRunId: successor.id,
    }),
    expect.objectContaining({
      id: 'restart-interrupted-root',
      interruptionState: 'resolved',
      resolvedByRunId: successor.id,
    }),
    ]));
  });

  it('retires prior-revision evidence only after linked write evidence is safe', () => {
    const connectorId = seedConnector('comparison-retirement', 2);
    seedRun(connectorId, 'old-interrupted', {
      state: 'failed',
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      syncKind: 'incremental',
      identityModeRevision: 1,
    });
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: 'old-write-cycle',
      connectorInstanceId: connectorId,
      comparisonRunId: 'old-interrupted',
      effectiveMode: 'comparison',
      modeRevision: 1,
      pendingCandidateCount: 1,
      state: 'interrupted',
      reconciliationState: 'unresolved',
      startedAt: now,
      completedAt: now,
    }).run();
    const command = {
      connectorInstanceId: connectorId,
      runId: 'old-interrupted',
      expectedRevision: 2,
      action: 'retire_revision' as const,
      actor: 'cutover-operator',
      reason: 'Retire old revision after rollback and evidence review',
      idempotencyKey: 'retire-old-comparison-revision',
      now,
    };

    expect(() => identity.reconcileGitHubComparisonCycle(command))
      .toThrow('unresolved write-cycle evidence');
    database.default.update(schema.githubIdentityWriteCycles).set({
      reconciliationState: 'pre_dispatch_retryable',
    }).where(eq(schema.githubIdentityWriteCycles.id, 'old-write-cycle')).run();
    expect(identity.reconcileGitHubComparisonCycle(command)).toEqual({
      changed: true,
      runId: 'old-interrupted',
      state: 'retired',
      successorRunId: null,
    });
  });
});

function seedConnector(id: string, revision = 1): string {
  database.default.insert(schema.connectorConfigs).values({
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
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: id,
    phase: 'comparing',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: id,
    stablePrimaryEnabled: false,
    modeRevision: revision,
    updatedAt: now,
  }).run();
  return id;
}

function seedRun(
  connectorId: string,
  id: string,
  overrides: Partial<typeof schema.githubIdentityComparisonRuns.$inferInsert> = {},
): void {
  const values: typeof schema.githubIdentityComparisonRuns.$inferInsert = {
    id,
    connectorInstanceId: connectorId,
    identityMode: 'comparison',
    identityModeRevision: 1,
    syncKind: 'full',
    state: 'succeeded',
    evidenceEligible: true,
    subIssueGenerationComplete: true,
    subIssueExpectedChildCount: 1,
    subIssueExpectedParentCount: 0,
    subIssuePopulationCount: 1,
    subIssuePopulationDigest: populationDigest,
    subIssueObservedChildCount: 1,
    subIssueObservedChildDigest: populationDigest,
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
  if (values.ownerId) {
    values.ownerTokenDigest ??= 'c'.repeat(64);
    values.ownerHeartbeatAt ??= now;
    values.ownerLeaseExpiresAt ??= '2026-08-11T12:15:00.000Z';
  }
  if (values.interruptionState && values.interruptionState !== 'none') {
    values.interruptedAt ??= now;
    values.interruptionReason ??= 'test_interruption';
  }
  database.default.insert(schema.githubIdentityComparisonRuns).values(values).run();
}

function seedCompleteAttestation(runId: string): void {
  database.default.insert(schema.githubIdentitySubIssuePopulationMembers).values({
    id: `${runId}-member`,
    runId,
    localTaskId: `${runId}-task`,
    sourceIdDigest: 'b'.repeat(64),
    issueNumber: 1,
    memberDigest,
    observed: true,
    createdAt: now,
  }).run();
  database.default.insert(schema.githubIdentityComparisonRecords).values({
    id: `${runId}-record`,
    runId,
    surface: 'sub_issue',
    candidateKey: `sub_issue:owner/repo:1:child`,
    localTaskId: `${runId}-task`,
    legacyAction: 'none',
    stableAction: 'none',
    outcome: 'agreement',
    reason: 'exact_match',
    createdAt: now,
  }).run();
}

function seedSucceededIncompleteReplacement(
  suffix: string,
  interruptionReason: 'sub_issue_generation_incomplete' | 'sub_issue_child_unresolved',
  overrides: {
    predecessor?: Partial<typeof schema.githubIdentityComparisonRuns.$inferInsert>;
    successor?: Partial<typeof schema.githubIdentityComparisonRuns.$inferInsert>;
  } = {},
) {
  const normalizedSuffix = suffix.replaceAll('_', '-').replaceAll(' ', '-');
  const connectorId = seedConnector(`succeeded-incomplete-${normalizedSuffix}`);
  const predecessorId = `predecessor-${normalizedSuffix}`;
  const successorId = `successor-${normalizedSuffix}`;
  seedRun(connectorId, predecessorId, {
    state: 'succeeded',
    evidenceEligible: false,
    interruptionState: 'unresolved',
    interruptionSurface: 'sub_issue',
    interruptionReason,
    ownerId: `job:inactive-${normalizedSuffix}`,
    ownerLeaseExpiresAt: '2026-08-10T14:59:00.000Z',
    startedAt: '2026-08-10T13:00:00.000Z',
    completedAt: '2026-08-10T14:00:00.000Z',
    interruptedAt: '2026-08-10T14:00:00.000Z',
    subIssueGenerationComplete: interruptionReason !== 'sub_issue_generation_incomplete',
    ...overrides.predecessor,
  });
  seedRun(connectorId, successorId, {
    ownerId: `job:successor-${normalizedSuffix}`,
    startedAt: '2026-08-10T15:01:00.000Z',
    completedAt: '2026-08-10T15:02:00.000Z',
    ...overrides.successor,
  });
  seedCompleteAttestation(successorId);
  return {
    connectorId,
    predecessorId,
    successorId,
    command: {
      ...replacementCommand(
        connectorId,
        predecessorId,
        successorId,
        `replace-${normalizedSuffix}`,
      ),
    },
  };
}

function replacementCommand(
  connectorInstanceId: string,
  runId: string,
  successorRunId: string,
  idempotencyKey: string,
) {
  return {
    connectorInstanceId,
    runId,
    expectedRevision: 1,
    action: 'replacement' as const,
    successorRunId,
    actor: 'cutover-operator',
    reason: 'Verified newer complete full replacement for incomplete sub-issue evidence',
    idempotencyKey,
    now,
  };
}

function noWriteCommand(connectorInstanceId: string, runId: string, idempotencyKey: string) {
  return {
    connectorInstanceId,
    runId,
    expectedRevision: 1,
    action: 'resolve_no_write' as const,
    actor: 'cutover-operator',
    reason: 'Confirmed durable empty-run evidence and inactive runtime ownership',
    idempotencyKey,
    now,
  };
}
