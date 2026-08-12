import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runTransaction } from '@/db';
import {
  githubIdentityComparisonRecords,
  githubIdentityComparisonRuns,
} from '@/db/schema';
import type {
  AppendGitHubIdentityComparisonRecordInput,
  CompleteGitHubIdentityComparisonRunInput,
  StartGitHubIdentityComparisonRunInput,
} from './comparison-types';
import type { ExternalIdentityTransaction } from './service';
import { getGitHubIdentityModeSnapshotInTransaction } from './mode-control';
import { hasCompleteGitHubSubIssueAttestation } from './sub-issue-attestation';

const MAX_RECORD_BATCH_SIZE = 500;
const DEFAULT_OWNER_LEASE_SECONDS = 15 * 60;

function ownerTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ownerLeaseExpiresAt(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

export type GitHubIdentityComparisonRunRecord =
  typeof githubIdentityComparisonRuns.$inferSelect;
export type GitHubIdentityComparisonDecisionRecord =
  typeof githubIdentityComparisonRecords.$inferSelect;

export function startGitHubIdentityComparisonRun(
  input: StartGitHubIdentityComparisonRunInput,
): GitHubIdentityComparisonRunRecord {
  return runTransaction((tx) =>
    startGitHubIdentityComparisonRunInTransaction(tx, input));
}

export function startGitHubIdentityComparisonRunInTransaction(
  database: ExternalIdentityTransaction,
  input: StartGitHubIdentityComparisonRunInput,
): GitHubIdentityComparisonRunRecord {
  if (!Number.isSafeInteger(input.identityModeRevision) || input.identityModeRevision < 0) {
    throw new Error('Comparison run mode revision must be a non-negative integer');
  }
  assertComparisonContext(database, {
    connectorInstanceId: input.connectorInstanceId,
    identityMode: input.identityMode,
    identityModeRevision: input.identityModeRevision,
  });
  if ((input.ownerId && !input.ownerToken) || (!input.ownerId && input.ownerToken)) {
    throw new Error('Comparison run ownership requires both an owner ID and owner token');
  }
  const startedAt = input.startedAt ?? new Date().toISOString();
  const ownerLeaseSeconds = input.ownerLeaseSeconds ?? DEFAULT_OWNER_LEASE_SECONDS;
  if (!Number.isSafeInteger(ownerLeaseSeconds) || ownerLeaseSeconds < 30 || ownerLeaseSeconds > 3_600) {
    throw new Error('Comparison run owner lease must be between 30 and 3600 seconds');
  }
  let predecessorRunId: string | null = null;
  if (input.ownerId && input.ownerToken) {
    const activeRuns = database.select().from(githubIdentityComparisonRuns).where(and(
      eq(githubIdentityComparisonRuns.connectorInstanceId, input.connectorInstanceId),
      eq(githubIdentityComparisonRuns.state, 'running'),
    )).all();
    for (const active of activeRuns) {
      const sameOwner = active.ownerId === input.ownerId;
      const staleOwner = !active.ownerLeaseExpiresAt || active.ownerLeaseExpiresAt <= startedAt;
      if (!sameOwner && !staleOwner) {
        throw new Error(
          `GitHub identity comparison run ${active.id} is owned by an active runtime`,
        );
      }
      const interrupted = database.update(githubIdentityComparisonRuns).set({
        state: 'cancelled',
        evidenceEligible: false,
        interruptionState: 'unresolved',
        interruptionSurface: active.syncKind === 'full' ? 'sub_issue' : 'comparison',
        interruptedAt: startedAt,
        interruptedByOwnerId: input.ownerId,
        interruptionReason: sameOwner ? 'owner_retry' : 'stale_owner_takeover',
        completedAt: startedAt,
        errorCode: sameOwner ? 'owner_retry' : 'owner_lease_expired',
      }).where(and(
        eq(githubIdentityComparisonRuns.id, active.id),
        eq(githubIdentityComparisonRuns.state, 'running'),
      )).returning({ id: githubIdentityComparisonRuns.id }).get();
      if (!interrupted) {
        throw new Error(`GitHub identity comparison run ${active.id} lost interruption ownership`);
      }
      predecessorRunId = active.id;
    }
    if (!predecessorRunId) {
      const sameOwnerUnresolved = database.select({
        id: githubIdentityComparisonRuns.id,
      }).from(githubIdentityComparisonRuns).where(and(
         eq(githubIdentityComparisonRuns.connectorInstanceId, input.connectorInstanceId),
         eq(githubIdentityComparisonRuns.ownerId, input.ownerId),
         eq(githubIdentityComparisonRuns.identityMode, input.identityMode),
         eq(githubIdentityComparisonRuns.identityModeRevision, input.identityModeRevision),
         eq(githubIdentityComparisonRuns.interruptionState, 'unresolved'),
      )).orderBy(sql`${githubIdentityComparisonRuns.startedAt} DESC`).limit(1).get();
      predecessorRunId = sameOwnerUnresolved?.id ?? null;
    }
  }
  return database.insert(githubIdentityComparisonRuns).values({
    id: input.id ?? randomUUID(),
    connectorInstanceId: input.connectorInstanceId,
    jobId: input.jobId ?? null,
    identityMode: input.identityMode,
    identityModeRevision: input.identityModeRevision,
    syncKind: input.syncKind,
    ownerId: input.ownerId ?? null,
    ownerTokenDigest: input.ownerToken ? ownerTokenDigest(input.ownerToken) : null,
    ownerHeartbeatAt: input.ownerId ? startedAt : null,
    ownerLeaseExpiresAt: input.ownerId
      ? ownerLeaseExpiresAt(startedAt, ownerLeaseSeconds)
      : null,
    predecessorRunId,
    startedAt,
  }).returning().get();
}

export function appendGitHubIdentityComparisonRecords(
  runId: string,
  records: readonly AppendGitHubIdentityComparisonRecordInput[],
  ownerToken?: string,
): GitHubIdentityComparisonDecisionRecord[] {
  return runTransaction(
    (tx) => appendGitHubIdentityComparisonRecordsInTransaction(tx, runId, records, ownerToken),
  );
}

export function appendGitHubIdentityComparisonRecordsInTransaction(
  database: ExternalIdentityTransaction,
  runId: string,
  records: readonly AppendGitHubIdentityComparisonRecordInput[],
  ownerToken?: string,
): GitHubIdentityComparisonDecisionRecord[] {
  if (records.length === 0) return [];
  if (records.length > MAX_RECORD_BATCH_SIZE) {
    throw new Error(`Comparison record batch exceeds the maximum of ${MAX_RECORD_BATCH_SIZE}`);
  }
  const run = database.select({
    state: githubIdentityComparisonRuns.state,
    connectorInstanceId: githubIdentityComparisonRuns.connectorInstanceId,
    identityMode: githubIdentityComparisonRuns.identityMode,
    identityModeRevision: githubIdentityComparisonRuns.identityModeRevision,
    ownerTokenDigest: githubIdentityComparisonRuns.ownerTokenDigest,
  })
    .from(githubIdentityComparisonRuns)
    .where(eq(githubIdentityComparisonRuns.id, runId))
    .limit(1)
    .get();
  if (!run) throw new Error(`GitHub identity comparison run ${runId} does not exist`);
  if (run.state !== 'running') {
    throw new Error(`GitHub identity comparison run ${runId} is not running`);
  }
  if (run.ownerTokenDigest && ownerTokenDigest(ownerToken ?? '') !== run.ownerTokenDigest) {
    throw new Error(`GitHub identity comparison run ${runId} owner token does not match`);
  }
  assertComparisonContext(database, run);
  for (const record of records) {
    if (
      record.stableIdDigest !== undefined
      && record.stableIdDigest !== null
      && !/^[a-f0-9]{64}$/.test(record.stableIdDigest)
    ) {
      throw new Error('Comparison records require a lowercase SHA-256 stable ID digest');
    }
    for (const value of [record.legacyLookupMs ?? 0, record.stableLookupMs ?? 0]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Comparison lookup durations must be non-negative integers');
      }
    }
    if (
      record.locatorRevision !== undefined
      && record.locatorRevision !== null
      && (!Number.isSafeInteger(record.locatorRevision) || record.locatorRevision < 1)
    ) {
      throw new Error('Comparison locator revision must be a positive integer');
    }
  }
  const values = records.map((record) => ({
    id: record.id ?? randomUUID(),
    runId,
    jobId: record.jobId ?? null,
    surface: record.surface,
    candidateKey: record.candidateKey,
    localTaskId: record.localTaskId ?? null,
    localSourceListId: record.localSourceListId ?? null,
    externalEntityId: record.externalEntityId ?? null,
    legacySelectedLocalId: record.legacySelectedLocalId ?? null,
    stableSelectedLocalId: record.stableSelectedLocalId ?? null,
    legacyAction: record.legacyAction,
    stableAction: record.stableAction,
    outcome: record.outcome,
    reason: record.reason,
    stableIdDigest: record.stableIdDigest ?? null,
    locatorRevision: record.locatorRevision ?? null,
    legacyLookupMs: record.legacyLookupMs ?? 0,
    stableLookupMs: record.stableLookupMs ?? 0,
    createdAt: record.createdAt ?? new Date().toISOString(),
  }));
  const inserted = database.insert(githubIdentityComparisonRecords).values(values)
    .onConflictDoNothing({
      target: [
        githubIdentityComparisonRecords.runId,
        githubIdentityComparisonRecords.surface,
        githubIdentityComparisonRecords.candidateKey,
      ],
    })
    .returning()
    .all();
  if (inserted.length === records.length) {
    heartbeatComparisonOwner(database, runId, run.ownerTokenDigest);
    return inserted;
  }

  const existing = database.select().from(githubIdentityComparisonRecords)
    .where(and(
      eq(githubIdentityComparisonRecords.runId, runId),
      inArray(
        githubIdentityComparisonRecords.candidateKey,
        records.map((record) => record.candidateKey),
      ),
    ))
    .all();
  const existingByKey = new Map(existing.map((record) => [
    `${record.surface}\0${record.candidateKey}`,
    record,
  ]));
  const replay = values.map((value) => {
    const record = existingByKey.get(`${value.surface}\0${value.candidateKey}`);
    if (!record || !sameDecision(record, value)) {
      throw new Error(`Conflicting comparison replay for ${value.surface}:${value.candidateKey}`);
    }
    return record;
  });
  heartbeatComparisonOwner(database, runId, run.ownerTokenDigest);
  return replay;
}

export function completeGitHubIdentityComparisonRun(
  runId: string,
  input: CompleteGitHubIdentityComparisonRunInput,
): GitHubIdentityComparisonRunRecord {
  return runTransaction(
    (tx) => completeGitHubIdentityComparisonRunInTransaction(tx, runId, input),
  );
}

export function completeGitHubIdentityComparisonRunInTransaction(
  database: ExternalIdentityTransaction,
  runId: string,
  input: CompleteGitHubIdentityComparisonRunInput,
): GitHubIdentityComparisonRunRecord {
  for (const value of [
    input.pageCount,
    input.queryCount,
    input.subIssueExpectedChildCount ?? 0,
    input.subIssueExpectedParentCount ?? 0,
    input.subIssuePopulationCount ?? 0,
    input.subIssueObservedChildCount ?? 0,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Comparison run counts must be non-negative integers');
    }
  }
  for (const value of [
    input.lookupLatencyP50Ms,
    input.lookupLatencyP95Ms,
    input.lookupLatencyP99Ms,
  ]) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('Comparison run latencies must be non-negative integers');
    }
  }
  for (const digest of [
    input.subIssuePopulationDigest,
    input.subIssueObservedChildDigest,
  ]) {
    if (digest !== undefined && digest !== null && !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Sub-issue population evidence requires a lowercase SHA-256 digest');
    }
  }
  const run = database.select().from(githubIdentityComparisonRuns)
    .where(eq(githubIdentityComparisonRuns.id, runId))
    .limit(1)
    .get();
  if (!run || run.state !== 'running') {
    throw new Error(`GitHub identity comparison run ${runId} does not exist or is not running`);
  }
  if (
    run.ownerTokenDigest
    && ownerTokenDigest(input.ownerToken ?? '') !== run.ownerTokenDigest
  ) {
    throw new Error(`GitHub identity comparison run ${runId} owner token does not match`);
  }
  const current = getGitHubIdentityModeSnapshotInTransaction(
    database,
    run.connectorInstanceId,
  );
  if (
    current.effectiveMode !== run.identityMode
    || current.modeRevision !== run.identityModeRevision
  ) {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const cancelled = database.update(githubIdentityComparisonRuns).set({
      state: 'cancelled',
      evidenceEligible: false,
      completedAt,
      errorCode: 'identity_context_changed',
      interruptionState: 'unresolved',
      interruptionSurface: run.syncKind === 'full' ? 'sub_issue' : 'comparison',
      interruptedAt: completedAt,
      interruptedByOwnerId: run.ownerId,
      interruptionReason: 'identity_context_changed',
    }).where(and(
      eq(githubIdentityComparisonRuns.id, runId),
      eq(githubIdentityComparisonRuns.state, 'running'),
    )).returning().get();
    if (!cancelled) {
      throw new Error(`GitHub identity comparison run ${runId} lost completion ownership`);
    }
    return cancelled;
  }

  const actualCounts = Object.fromEntries(database.select({
    outcome: githubIdentityComparisonRecords.outcome,
    count: sql<number>`count(*)`,
  }).from(githubIdentityComparisonRecords)
    .where(eq(githubIdentityComparisonRecords.runId, runId))
    .groupBy(githubIdentityComparisonRecords.outcome)
    .all()
    .map((row) => [row.outcome, row.count]));
  const outcomes = new Set([...Object.keys(actualCounts), ...Object.keys(input.outcomeCounts)]);
  for (const outcome of outcomes) {
    if ((actualCounts[outcome] ?? 0) !== (input.outcomeCounts[outcome as keyof typeof input.outcomeCounts] ?? 0)) {
      throw new Error(`Comparison outcome count does not match stored records for ${outcome}`);
    }
  }
  const currentRun = database.select().from(githubIdentityComparisonRuns)
    .where(eq(githubIdentityComparisonRuns.id, runId)).limit(1).get();
  if (!currentRun) throw new Error(`GitHub identity comparison run ${runId} does not exist`);
  const subIssueIncomplete = currentRun.syncKind === 'full'
    && input.subIssueGenerationComplete !== true;
  const unresolved = input.state !== 'succeeded' || subIssueIncomplete;
  const completedAt = input.completedAt ?? new Date().toISOString();
  const completed = database.update(githubIdentityComparisonRuns).set({
    state: input.state,
    pageCount: input.pageCount,
    queryCount: input.queryCount,
    outcomeCounts: input.outcomeCounts,
    lookupLatencyP50Ms: input.lookupLatencyP50Ms ?? null,
    lookupLatencyP95Ms: input.lookupLatencyP95Ms ?? null,
    lookupLatencyP99Ms: input.lookupLatencyP99Ms ?? null,
    evidenceEligible: input.evidenceEligible,
    subIssueGenerationComplete: input.subIssueGenerationComplete ?? false,
    subIssueExpectedChildCount: input.subIssueExpectedChildCount ?? 0,
    subIssueExpectedParentCount: input.subIssueExpectedParentCount ?? 0,
    subIssuePopulationCount: input.subIssuePopulationCount ?? 0,
    subIssuePopulationDigest: input.subIssuePopulationDigest ?? null,
    subIssueObservedChildCount: input.subIssueObservedChildCount ?? 0,
    subIssueObservedChildDigest: input.subIssueObservedChildDigest ?? null,
    interruptionState: unresolved ? 'unresolved' : 'none',
    interruptionSurface: unresolved
      ? input.interruptionSurface ?? (subIssueIncomplete ? 'sub_issue' : 'comparison')
      : null,
    interruptedAt: unresolved ? completedAt : null,
    interruptedByOwnerId: unresolved ? currentRun.ownerId : null,
    interruptionReason: unresolved
      ? input.errorCode ?? (subIssueIncomplete ? 'sub_issue_generation_incomplete' : 'comparison_failed')
      : null,
    completedAt,
    errorCode: input.errorCode ?? null,
  }).where(and(
    eq(githubIdentityComparisonRuns.id, runId),
    eq(githubIdentityComparisonRuns.state, 'running'),
  )).returning().get();
  if (!completed) {
    throw new Error(`GitHub identity comparison run ${runId} does not exist or is not running`);
  }
  if (
    completed.state === 'succeeded'
    && completed.evidenceEligible
    && hasCompleteGitHubSubIssueAttestation(database, completed)
    && completed.predecessorRunId
    && completed.ownerId
  ) {
    const visited = new Set<string>();
    let predecessorRunId: string | null = completed.predecessorRunId;
    while (predecessorRunId && !visited.has(predecessorRunId)) {
      visited.add(predecessorRunId);
      const predecessor = database.select().from(githubIdentityComparisonRuns)
        .where(eq(githubIdentityComparisonRuns.id, predecessorRunId))
        .limit(1)
        .get();
      if (
        !predecessor
        || predecessor.connectorInstanceId !== completed.connectorInstanceId
        || predecessor.identityMode !== completed.identityMode
        || predecessor.identityModeRevision !== completed.identityModeRevision
        || predecessor.ownerId !== completed.ownerId
      ) {
        break;
      }
      database.update(githubIdentityComparisonRuns).set({
        interruptionState: 'resolved',
        reconciledAt: completedAt,
        reconciledBy: `runtime:${completed.ownerId}`,
        reconciliationReason: 'same-owner successful replacement',
        resolvedByRunId: completed.id,
      }).where(and(
        eq(githubIdentityComparisonRuns.id, predecessor.id),
        eq(githubIdentityComparisonRuns.interruptionState, 'unresolved'),
      )).run();
      predecessorRunId = predecessor.predecessorRunId;
    }
  }
  return completed;
}

export function heartbeatGitHubIdentityComparisonRun(
  runId: string,
  ownerToken: string,
): void {
  runTransaction((tx) => {
    const changed = heartbeatComparisonOwner(
      tx,
      runId,
      ownerTokenDigest(ownerToken),
    );
    if (changed !== 1) {
      throw new Error(`GitHub identity comparison run ${runId} lost ownership`);
    }
  });
}

function heartbeatComparisonOwner(
  database: ExternalIdentityTransaction,
  runId: string,
  tokenDigest: string | null,
): number {
  if (!tokenDigest) return 0;
  const now = new Date().toISOString();
  return database.update(githubIdentityComparisonRuns).set({
    ownerHeartbeatAt: now,
    ownerLeaseExpiresAt: ownerLeaseExpiresAt(now, DEFAULT_OWNER_LEASE_SECONDS),
  }).where(and(
    eq(githubIdentityComparisonRuns.id, runId),
    eq(githubIdentityComparisonRuns.state, 'running'),
    eq(githubIdentityComparisonRuns.ownerTokenDigest, tokenDigest),
  )).run().changes;
}

function assertComparisonContext(
  database: ExternalIdentityTransaction,
  run: {
    connectorInstanceId: string;
    identityMode: 'legacy' | 'comparison' | 'stable';
    identityModeRevision: number;
  },
): void {
  const current = getGitHubIdentityModeSnapshotInTransaction(
    database,
    run.connectorInstanceId,
  );
  if (
    current.effectiveMode !== run.identityMode
    || current.modeRevision !== run.identityModeRevision
  ) {
    throw new Error(
      `GitHub identity comparison context changed from ${run.identityMode}:${run.identityModeRevision}`,
    );
  }
}

function sameDecision(
  existing: GitHubIdentityComparisonDecisionRecord,
  replay: typeof githubIdentityComparisonRecords.$inferInsert,
): boolean {
  return existing.jobId === (replay.jobId ?? null)
    && existing.localTaskId === (replay.localTaskId ?? null)
    && existing.localSourceListId === (replay.localSourceListId ?? null)
    && existing.externalEntityId === (replay.externalEntityId ?? null)
    && existing.legacySelectedLocalId === (replay.legacySelectedLocalId ?? null)
    && existing.stableSelectedLocalId === (replay.stableSelectedLocalId ?? null)
    && existing.legacyAction === replay.legacyAction
    && existing.stableAction === replay.stableAction
    && existing.outcome === replay.outcome
    && existing.reason === replay.reason
    && existing.stableIdDigest === (replay.stableIdDigest ?? null)
    && existing.locatorRevision === (replay.locatorRevision ?? null);
}
