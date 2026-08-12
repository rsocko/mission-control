import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

process.env.MC_DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

const connectorId = 'post-cutover-verification';
const now = '2026-08-11T15:00:00.000Z';

beforeAll(async () => {
  vi.resetModules();
  [database, schema, identity] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/external-identities'),
  ]);
  database.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: 'Post-cutover verification',
    enabled: true,
    syncMode: 'manual',
    capabilities: {},
    credentials: {},
    settings: { repos: [] },
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: 'stable_primary',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
    stablePrimaryEnabled: true,
    modeRevision: 7,
    updatedAt: now,
  }).run();
  seedRun('stable-incremental', 'incremental', 'succeeded', true);
  seedRun('stable-full-1', 'full', 'succeeded', true);
  seedRun('stable-full-2', 'full', 'succeeded', true);
  seedRun('cancelled-partial', 'incremental', 'cancelled', false);
  seedRun('ineligible-partial', 'full', 'succeeded', false);
  seedRecord('cancelled-partial-record', 'cancelled-partial', 'partial_fetch');
  seedRecord('ineligible-partial-record', 'ineligible-partial', 'partial_fetch');
});

describe('GitHub post-cutover verification evidence', () => {
  it('ignores blockers from cancelled and evidence-ineligible stable attempts', () => {
    expect(postCutoverVerification()).toEqual({
      complete: true,
      incrementalRuns: 1,
      requiredIncrementalRuns: 1,
      fullRuns: 2,
      requiredFullRuns: 2,
      blockingRecords: 0,
      blockers: [],
    });
  });

  it('continues to block on evidence from a qualifying successful stable run', () => {
    seedRecord('qualifying-partial-record', 'stable-incremental', 'partial_fetch');
    expect(postCutoverVerification()).toMatchObject({
      complete: false,
      blockingRecords: 1,
      blockers: ['stable_blocking_identity_evidence'],
    });
  });

  it('counts accepted terminal-inaccessible deletions without applying them', () => {
    const acceptedConnector = 'post-cutover-accepted-terminal';
    const localId = 'accepted-terminal-task';
    seedStableTerminalTask(acceptedConnector, localId);
    identity.recordGitHubIdentityException({
      connectorInstanceId: acceptedConnector,
      bindingType: 'task',
      localId,
      category: 'terminal_inaccessible',
      action: 'accept',
      actor: 'test-operator',
      reason: 'Authoritative HTTP 410 independently verified',
      idempotencyKey: 'accepted-terminal-before-stable-run',
      now,
    });

    const result = runStableInaccessible(acceptedConnector, localId, 'deletion');

    expect(result.decision).toMatchObject({
      outcome: 'inaccessible',
      appliedSource: 'blocked',
      selectedAction: 'none',
    });
    expect(result.run).toMatchObject({
      state: 'succeeded',
      evidenceEligible: true,
      errorCode: null,
    });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, localId)).get()).toMatchObject({
      status: 'cancelled',
    });
    expect(postCutoverVerification(acceptedConnector)).toMatchObject({
      fullRuns: 1,
      blockingRecords: 0,
    });
  });

  it('keeps unaccepted, revoked, and non-deletion inaccessible evidence blocking', () => {
    const unacceptedConnector = 'post-cutover-unaccepted-terminal';
    const unacceptedLocalId = 'unaccepted-terminal-task';
    seedStableTerminalTask(unacceptedConnector, unacceptedLocalId);
    expect(runStableInaccessible(
      unacceptedConnector,
      unacceptedLocalId,
      'deletion',
    ).run).toMatchObject({
      evidenceEligible: false,
      errorCode: 'stable_inaccessible',
    });
    expect(postCutoverVerification(unacceptedConnector)).toMatchObject({
      fullRuns: 0,
    });

    const revokedConnector = 'post-cutover-revoked-terminal';
    const revokedLocalId = 'revoked-terminal-task';
    seedStableTerminalTask(revokedConnector, revokedLocalId);
    identity.recordGitHubIdentityException({
      connectorInstanceId: revokedConnector,
      bindingType: 'task',
      localId: revokedLocalId,
      category: 'terminal_inaccessible',
      action: 'accept',
      actor: 'test-operator',
      reason: 'Initially accepted terminal evidence',
      idempotencyKey: 'revoked-terminal-accept',
      now,
    });
    expect(runStableInaccessible(
      revokedConnector,
      revokedLocalId,
      'dependency',
    ).run).toMatchObject({
      evidenceEligible: false,
      errorCode: 'stable_inaccessible',
    });
    identity.recordGitHubIdentityException({
      connectorInstanceId: revokedConnector,
      bindingType: 'task',
      localId: revokedLocalId,
      category: 'terminal_inaccessible',
      action: 'revoke',
      actor: 'test-operator',
      reason: 'Terminal evidence no longer accepted',
      idempotencyKey: 'revoked-terminal-revoke',
      now,
    });
    expect(runStableInaccessible(
      revokedConnector,
      revokedLocalId,
      'deletion',
    ).run).toMatchObject({
      evidenceEligible: false,
      errorCode: 'stable_inaccessible',
    });
    expect(postCutoverVerification(revokedConnector)).toMatchObject({
      fullRuns: 0,
    });
  });
});

function seedRun(
  id: string,
  syncKind: 'full' | 'incremental',
  state: 'succeeded' | 'cancelled',
  evidenceEligible: boolean,
): void {
  database.default.insert(schema.githubIdentityComparisonRuns).values({
    id,
    connectorInstanceId: connectorId,
    identityMode: 'stable',
    identityModeRevision: 7,
    syncKind,
    state,
    evidenceEligible,
    startedAt: now,
    completedAt: now,
  }).run();
}

function seedRecord(
  id: string,
  runId: string,
  outcome: 'partial_fetch',
): void {
  database.default.insert(schema.githubIdentityComparisonRecords).values({
    id,
    runId,
    surface: 'task',
    candidateKey: id,
    legacyAction: 'none',
    stableAction: 'none',
    outcome,
    reason: 'fetch_incomplete',
    createdAt: now,
  }).run();
}

function postCutoverVerification(
  requestedConnectorId = connectorId,
): Record<string, unknown> {
  const status = identity.getGitHubIdentityComparisonStatus(requestedConnectorId, { now }) as {
    cutover: { postCutoverVerification: Record<string, unknown> };
  };
  return status.cutover.postCutoverVerification;
}

function seedStableTerminalTask(requestedConnectorId: string, localId: string): void {
  database.default.insert(schema.connectorConfigs).values({
    id: requestedConnectorId,
    type: 'github-issues',
    name: requestedConnectorId,
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
    connectorInstanceId: requestedConnectorId,
    phase: 'stable_primary',
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: requestedConnectorId,
    stablePrimaryEnabled: true,
    modeRevision: 8,
    updatedAt: now,
  }).run();
  database.default.insert(schema.tasks).values({
    id: localId,
    sourceId: 'owner/repo:410',
    connectorType: 'github-issues',
    connectorInstanceId: requestedConnectorId,
    title: localId,
    status: 'cancelled',
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    metadata: {},
  }).run();
  database.default.insert(schema.githubIdentityBackfillItems).values({
    connectorInstanceId: requestedConnectorId,
    bindingType: 'task',
    localId,
    state: 'inaccessible',
    attemptCount: 1,
    observedAt: now,
    updatedAt: now,
  }).run();
}

function runStableInaccessible(
  requestedConnectorId: string,
  localId: string,
  surface: 'deletion' | 'dependency',
) {
  const runtime = new identity.GitHubIdentityComparisonRuntime({
    connectorInstanceId: requestedConnectorId,
    jobId: `${requestedConnectorId}-${surface}`,
    modeSnapshot: identity.getGitHubIdentityModeSnapshot(requestedConnectorId),
    syncKind: 'full',
  });
  const decision = runtime.observeResolvedBatch(surface, [{
    candidateKey: `${surface}:${localId}`,
    localTaskId: localId,
    legacySelectedLocalIds: [localId],
    legacyAction: 'delete_candidate',
    stable: {
      selectedLocalIds: [],
      action: 'none',
      evidence: 'inaccessible',
    },
  }])[0];
  runtime.complete('succeeded');
  const run = database.default.select().from(schema.githubIdentityComparisonRuns)
    .where(eq(schema.githubIdentityComparisonRuns.id, runtime.runId)).get();
  return { decision, run };
}
