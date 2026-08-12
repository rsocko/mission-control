import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import db, { runTransaction, sqlite } from '@/db';
import {
  connectorConfigs,
  githubBulkTransferEvents,
  githubBulkTransferItems,
  githubBulkTransferRuns,
  tasks,
} from '@/db/schema';
import {
  getGitHubIdentityModeSnapshot,
  observeOperatorExternalEntityLocatorInTransaction,
  readGitHubTaskTransferBinding,
} from '@/lib/external-identities';
import { runWithConnectorOperationLease } from '@/lib/sync/connector-lock';
import { parseSourceId } from './issue-transformer';
import {
  createGitHubRepositoryRemote,
  type GitHubRepointBackupProof,
  type GitHubRepositoryRepointRemote,
  transferGitHubIssueWithLease,
} from './repoint-service';

const REPOSITORY_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_CONCURRENCY = 8;

export interface GitHubBulkTransferInput {
  connectorInstanceId: string;
  sourceRepository: string;
  targetRepository: string;
  actor: string;
  backupProof: GitHubRepointBackupProof;
}

export interface GitHubBulkTransferExecuteInput extends GitHubBulkTransferInput {
  idempotencyKey: string;
  planHash: string;
  confirmation: string;
  concurrency?: number;
}

export interface GitHubBulkTransferPlanItem extends Record<string, unknown> {
  taskId: string;
  issueEntityId: string;
  issueStableId: string;
  sourceNumber: number;
  sourceState: string;
  beforeDigest: string;
}

export interface GitHubBulkTransferPreview extends Record<string, unknown> {
  connectorInstanceId: string;
  sourceRepository: string;
  targetRepository: string;
  sourceRepositoryStableIdDigest: string | null;
  targetRepositoryStableIdDigest: string | null;
  sourceIssueCount: number;
  destinationIssueCount: number;
  targetIssueStableIds: string[];
  openIssueCount: number;
  closedIssueCount: number;
  localTaskCount: number;
  globalBeforeDigest: string;
  items: GitHubBulkTransferPlanItem[];
  planHash: string;
  go: boolean;
  reasons: string[];
}

export interface GitHubBulkTransferStatus extends Record<string, unknown> {
  id: string;
  connectorInstanceId: string;
  phase: 'running' | 'completed' | 'failed' | 'aborted';
  sourceRepository: string;
  targetRepository: string;
  planHash: string;
  totalCount: number;
  transferredCount: number;
  skippedCount: number;
  failedCount: number;
  pendingCount: number;
  ambiguousCount: number;
  reconciledCount: number;
  connectorEnabled: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GitHubBulkTransferDependencies {
  remote?: GitHubRepositoryRepointRemote;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  operationLeaseOwned?: boolean;
}

export async function previewGitHubBulkTransfer(
  input: GitHubBulkTransferInput,
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferPreview> {
  validateInput(input);
  requireConnector(input.connectorInstanceId);
  const remote = dependencies.remote ?? createGitHubRepositoryRemote(input.connectorInstanceId);
  if (!remote.listIssues) throw new Error('GitHub remote does not support issue enumeration');

  const reasons: string[] = [];
  const mode = getGitHubIdentityModeSnapshot(input.connectorInstanceId);
  if (mode.effectiveMode !== 'stable') reasons.push('stable_primary_matching_required');
  if (!backupReady(input.backupProof, dependencies.now?.() ?? new Date())) {
    reasons.push('verified_recent_backup_required');
  }
  if (connectorActivity(
    input.connectorInstanceId,
    dependencies.operationLeaseOwned ?? false,
  ) > 0) {
    reasons.push('connector_activity_must_be_drained');
  }
  if (blockingStateCount(input.connectorInstanceId) > 0) {
    reasons.push('pending_writes_deletions_or_identity_collisions');
  }

  const sourceBinding = repositoryBinding(input.connectorInstanceId, input.sourceRepository);
  const targetBinding = repositoryBinding(input.connectorInstanceId, input.targetRepository);
  if (!sourceBinding) reasons.push('source_repository_binding_missing_or_ambiguous');
  if (!targetBinding) reasons.push('target_repository_binding_missing_or_ambiguous');

  const [sourceEvidence, targetEvidence, remoteIssues, targetIssues] = await Promise.all([
    remote.resolveRepository(input.sourceRepository),
    remote.resolveRepository(input.targetRepository),
    remote.listIssues(input.sourceRepository),
    remote.listIssues(input.targetRepository),
  ]);
  if (!sourceEvidence || sourceEvidence.identity.stableId !== sourceBinding?.stableId) {
    reasons.push('source_repository_identity_mismatch');
  }
  if (!targetEvidence || targetEvidence.identity.stableId !== targetBinding?.stableId) {
    reasons.push('target_repository_identity_mismatch');
  }

  const localRows = db.select({
    id: tasks.id,
    sourceId: tasks.sourceId,
  }).from(tasks).where(and(
    eq(tasks.connectorInstanceId, input.connectorInstanceId),
    eq(tasks.connectorType, 'github-issues'),
  )).all().filter((row) => parseSourceId(row.sourceId).repo.toLowerCase()
    === input.sourceRepository.toLowerCase());
  const remoteByNumber = new Map(remoteIssues.map((issue) => [issue.number, issue]));
  const items: GitHubBulkTransferPlanItem[] = [];
  for (const row of localRows) {
    try {
      const locator = parseSourceId(row.sourceId);
      const binding = readGitHubTaskTransferBinding(db, input.connectorInstanceId, row.id);
      const remoteIssue = remoteByNumber.get(locator.issueNumber);
      if (!remoteIssue?.node_id || remoteIssue.node_id !== binding.stableId) {
        reasons.push(`issue_identity_mismatch:${row.id}`);
        continue;
      }
      items.push({
        taskId: row.id,
        issueEntityId: binding.externalEntityId,
        issueStableId: binding.stableId,
        sourceNumber: locator.issueNumber,
        sourceState: remoteIssue.state,
        beforeDigest: taskMetadataDigest(row.id),
      });
    } catch {
      reasons.push(`issue_binding_missing_or_ambiguous:${row.id}`);
    }
  }
  if (remoteIssues.length !== localRows.length || items.length !== remoteIssues.length) {
    reasons.push('source_issue_and_task_counts_do_not_reconcile');
  }
  for (const issue of remoteIssues) {
    if (!items.some((item) => item.sourceNumber === issue.number)) {
      reasons.push(`source_issue_unbound:${issue.number}`);
    }
  }

  items.sort((left, right) => left.sourceNumber - right.sourceNumber);
  const planCore = {
    connectorInstanceId: input.connectorInstanceId,
    sourceRepository: input.sourceRepository.toLowerCase(),
    targetRepository: input.targetRepository.toLowerCase(),
    sourceRepositoryStableId: sourceBinding?.stableId ?? null,
    targetRepositoryStableId: targetBinding?.stableId ?? null,
    backupSha256: input.backupProof.sha256,
    globalBeforeDigest: globalMetadataDigest(input.connectorInstanceId),
    targetIssueStableIds: targetIssues
      .map((issue) => issue.node_id)
      .filter((value): value is string => typeof value === 'string')
      .sort(),
    items,
  };
  const planHash = digest(planCore);
  return {
    connectorInstanceId: input.connectorInstanceId,
    sourceRepository: input.sourceRepository,
    targetRepository: input.targetRepository,
    sourceRepositoryStableIdDigest: sourceBinding ? digest(sourceBinding.stableId) : null,
    targetRepositoryStableIdDigest: targetBinding ? digest(targetBinding.stableId) : null,
    sourceIssueCount: remoteIssues.length,
    destinationIssueCount: targetIssues.length,
    targetIssueStableIds: planCore.targetIssueStableIds,
    openIssueCount: remoteIssues.filter((issue) => issue.state === 'open').length,
    closedIssueCount: remoteIssues.filter((issue) => issue.state === 'closed').length,
    localTaskCount: localRows.length,
    globalBeforeDigest: planCore.globalBeforeDigest,
    items,
    planHash,
    go: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

export async function executeGitHubBulkTransfer(
  input: GitHubBulkTransferExecuteInput,
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferStatus> {
  validateExecutionInput(input);
  const existing = findRun(input.connectorInstanceId, input.idempotencyKey);
  if (existing) {
    assertSameRun(existing, input);
    if (existing.phase === 'completed') return status(existing.id);
    if (existing.phase === 'aborted') throw new Error('Aborted bulk transfer cannot be resumed');
    const ambiguous = db.select().from(githubBulkTransferItems).where(and(
      eq(githubBulkTransferItems.runId, existing.id),
      eq(githubBulkTransferItems.state, 'transferring'),
    )).get();
    if (ambiguous) {
      throw new Error(
        `Bulk transfer has an unresolved post-dispatch item: ${ambiguous.taskId}`,
      );
    }
  }

  return runWithConnectorOperationLease(input.connectorInstanceId, 'transfer', async () => {
    let runId: string;
    if (existing) {
      runId = existing.id;
      db.update(githubBulkTransferRuns).set({
        phase: 'running',
        lastError: null,
        updatedAt: nowIso(dependencies),
      }).where(eq(githubBulkTransferRuns.id, runId)).run();
    } else {
      const preview = await previewGitHubBulkTransfer(input, {
        ...dependencies,
        operationLeaseOwned: true,
      });
      if (!preview.go) {
        throw new Error(`GitHub bulk transfer preflight failed: ${preview.reasons.join('; ')}`);
      }
      if (preview.planHash !== input.planHash) {
        throw new Error('GitHub bulk transfer plan hash is stale');
      }
      runId = createRun(input, preview, dependencies.now?.() ?? new Date());
    }

    try {
      const remote = dependencies.remote ?? createGitHubRepositoryRemote(input.connectorInstanceId);
      const pending = db.select().from(githubBulkTransferItems).where(and(
        eq(githubBulkTransferItems.runId, runId),
        inArray(githubBulkTransferItems.state, ['pending', 'failed']),
      )).orderBy(githubBulkTransferItems.sourceNumber).all();
      await runBounded(pending, input.concurrency ?? 1, async (item) => {
        if (taskMetadataDigest(item.taskId) !== item.beforeDigest) {
          throw new Error(`Local metadata drift detected for task ${item.taskId}`);
        }
        const attemptStartedAt = nowIso(dependencies);
        db.update(githubBulkTransferItems).set({
          state: 'pending',
          startedAt: attemptStartedAt,
          updatedAt: attemptStartedAt,
          lastError: null,
        }).where(and(
          eq(githubBulkTransferItems.runId, runId),
          eq(githubBulkTransferItems.taskId, item.taskId),
        )).run();
        appendEvent(runId, item.taskId, 'preflight_started', {
          issueStableIdDigest: digest(item.issueStableId),
        }, attemptStartedAt);

        let result;
        try {
          result = await withRateLimitBackoff(() => transferGitHubIssueWithLease({
            connectorInstanceId: input.connectorInstanceId,
            sourceId: `${input.sourceRepository}:${item.sourceNumber}`,
            targetRepository: input.targetRepository,
            actor: input.actor,
          }, {
            remote,
            now: dependencies.now,
            sleep: dependencies.sleep,
            onTransferDispatch: () => {
              const dispatchedAt = nowIso(dependencies);
              db.update(githubBulkTransferItems).set({
                state: 'transferring',
                updatedAt: dispatchedAt,
              }).where(and(
                eq(githubBulkTransferItems.runId, runId),
                eq(githubBulkTransferItems.taskId, item.taskId),
              )).run();
              appendEvent(runId, item.taskId, 'dispatch_started', {
                issueStableIdDigest: digest(item.issueStableId),
              }, dispatchedAt);
            },
          }), dependencies.sleep);
        } catch (error) {
          const current = db.select({ state: githubBulkTransferItems.state })
            .from(githubBulkTransferItems).where(and(
              eq(githubBulkTransferItems.runId, runId),
              eq(githubBulkTransferItems.taskId, item.taskId),
            )).get();
          if (current?.state === 'pending') {
            const failedAt = nowIso(dependencies);
            const message = error instanceof Error ? error.message : String(error);
            db.update(githubBulkTransferItems).set({
              state: 'failed',
              lastError: message.slice(0, 1_000),
              updatedAt: failedAt,
            }).where(and(
              eq(githubBulkTransferItems.runId, runId),
              eq(githubBulkTransferItems.taskId, item.taskId),
            )).run();
            appendEvent(runId, item.taskId, 'pre_dispatch_failed', {
              error: message.slice(0, 1_000),
            }, failedAt);
          }
          throw error;
        }
        if (taskMetadataDigest(item.taskId) !== item.beforeDigest) {
          throw new Error(`Local metadata changed during transfer for task ${item.taskId}`);
        }
        const targetNumber = parseSourceId(result.newSourceId).issueNumber;
        const completedAt = nowIso(dependencies);
        runTransaction((tx) => {
          tx.update(githubBulkTransferItems).set({
            state: 'transferred',
            targetNumber,
            newSourceId: result.newSourceId,
            completedAt,
            updatedAt: completedAt,
          }).where(and(
            eq(githubBulkTransferItems.runId, runId),
            eq(githubBulkTransferItems.taskId, item.taskId),
          )).run();
          tx.update(githubBulkTransferRuns).set({
            transferredCount: sqlCountTransferred(runId),
            updatedAt: completedAt,
          }).where(eq(githubBulkTransferRuns.id, runId)).run();
          tx.insert(githubBulkTransferEvents).values({
            runId,
            taskId: item.taskId,
            eventType: 'verified',
            payload: {
              newSourceId: result.newSourceId,
              issueStableIdDigest: digest(result.issueStableId),
            },
            createdAt: completedAt,
          }).run();
        });
      });
      await completeRun(runId, remote, dependencies);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failRun(runId, message, dependencies);
      throw error;
    }
    return status(runId);
  });
}

export function getGitHubBulkTransferStatus(runId: string): GitHubBulkTransferStatus {
  return status(runId);
}

export async function reconcileGitHubBulkTransferItem(
  input: {
    runId: string;
    taskId: string;
    targetNumber: number;
    actor: string;
  },
  dependencies: GitHubBulkTransferDependencies = {},
): Promise<GitHubBulkTransferStatus> {
  validateActor(input.actor);
  if (!Number.isSafeInteger(input.targetNumber) || input.targetNumber <= 0) {
    throw new Error('Bulk transfer reconciliation requires a positive target issue number');
  }
  const run = requireRun(input.runId);
  if (run.phase !== 'failed') {
    throw new Error(`Bulk transfer item cannot be reconciled from run phase ${run.phase}`);
  }
  const item = db.select().from(githubBulkTransferItems).where(and(
    eq(githubBulkTransferItems.runId, input.runId),
    eq(githubBulkTransferItems.taskId, input.taskId),
  )).limit(1).get();
  if (!item || item.state !== 'transferring') {
    throw new Error('Bulk transfer reconciliation requires an ambiguous item');
  }
  if (taskMetadataDigest(item.taskId) !== item.beforeDigest) {
    throw new Error('Bulk transfer reconciliation found local metadata drift');
  }

  await runWithConnectorOperationLease(run.connectorInstanceId, 'transfer', async () => {
    const remote = dependencies.remote ?? createGitHubRepositoryRemote(run.connectorInstanceId);
    const targetBinding = repositoryBinding(run.connectorInstanceId, run.targetRepository);
    const targetRepository = await remote.resolveRepository(run.targetRepository);
    if (
      !targetBinding
      || !targetRepository
      || targetRepository.identity.stableId !== targetBinding.stableId
    ) {
      throw new Error('Bulk transfer reconciliation target repository identity mismatch');
    }
    const evidence = await remote.resolveIssue(
      run.targetRepository,
      input.targetNumber,
      targetRepository,
    );
    if (!evidence || evidence.entity.identity.stableId !== item.issueStableId) {
      throw new Error('Bulk transfer reconciliation target issue identity mismatch');
    }
    const now = nowIso(dependencies);
    runTransaction((tx) => {
      const observed = observeOperatorExternalEntityLocatorInTransaction(tx, {
        entityId: item.issueEntityId,
        identity: evidence.entity.identity,
        locator: evidence.entity.locator,
        repositoryEntityId: targetBinding.entityId,
        observedAt: now,
      });
      if (observed.state === 'collision') {
        throw new Error('Bulk transfer reconciliation target locator collision');
      }
      const newSourceId = `${run.targetRepository}:${input.targetNumber}`;
      tx.update(tasks).set({
        sourceId: newSourceId,
        sourceListId: run.targetRepository,
        sourceListName: run.targetRepository,
        syncStatus: 'synced',
        updatedAt: now,
      }).where(eq(tasks.id, item.taskId)).run();
      tx.update(githubBulkTransferItems).set({
        state: 'transferred',
        targetNumber: input.targetNumber,
        newSourceId,
        lastError: null,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(githubBulkTransferItems.runId, input.runId),
        eq(githubBulkTransferItems.taskId, input.taskId),
      )).run();
      tx.update(githubBulkTransferRuns).set({
        actor: input.actor,
        transferredCount: sqlCountTransferred(input.runId),
        failedCount: 0,
        lastError: null,
        updatedAt: now,
      }).where(eq(githubBulkTransferRuns.id, input.runId)).run();
      tx.insert(githubBulkTransferEvents).values({
        runId: input.runId,
        taskId: input.taskId,
        eventType: 'ambiguity_reconciled',
        payload: {
          targetNumber: input.targetNumber,
          issueStableIdDigest: digest(item.issueStableId),
          actor: input.actor,
        },
        createdAt: now,
      }).run();
    });
  });
  return status(input.runId);
}

export function abortGitHubBulkTransfer(
  runId: string,
  actor: string,
): GitHubBulkTransferStatus {
  validateActor(actor);
  const run = requireRun(runId);
  if (run.phase !== 'running' && run.phase !== 'failed') {
    throw new Error(`Bulk transfer cannot be aborted from phase ${run.phase}`);
  }
  const ambiguous = db.select().from(githubBulkTransferItems).where(and(
    eq(githubBulkTransferItems.runId, runId),
    eq(githubBulkTransferItems.state, 'transferring'),
  )).get();
  if (ambiguous) {
    throw new Error('Bulk transfer cannot be aborted with an unresolved post-dispatch item');
  }
  const now = new Date().toISOString();
  db.update(githubBulkTransferRuns).set({
    phase: 'aborted',
    actor,
    completedAt: now,
    updatedAt: now,
  }).where(eq(githubBulkTransferRuns.id, runId)).run();
  appendEvent(runId, null, 'aborted', { actor }, now);
  return status(runId);
}

function createRun(
  input: GitHubBulkTransferExecuteInput,
  preview: GitHubBulkTransferPreview,
  now: Date,
): string {
  const connector = requireConnector(input.connectorInstanceId);
  const runId = randomUUID();
  const timestamp = now.toISOString();
  runTransaction((tx) => {
    tx.insert(githubBulkTransferRuns).values({
      id: runId,
      connectorInstanceId: input.connectorInstanceId,
      idempotencyKey: input.idempotencyKey,
      phase: 'running',
      actor: input.actor,
      sourceRepository: input.sourceRepository,
      targetRepository: input.targetRepository,
      planHash: input.planHash,
      plan: preview,
      connectorWasEnabled: connector.enabled,
      transferredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    tx.insert(githubBulkTransferItems).values(preview.items.map((item) => ({
      runId,
      taskId: item.taskId,
      issueEntityId: item.issueEntityId,
      issueStableId: item.issueStableId,
      sourceNumber: item.sourceNumber,
      state: 'pending' as const,
      beforeDigest: item.beforeDigest,
      updatedAt: timestamp,
    }))).run();
    tx.update(connectorConfigs).set({
      enabled: false,
      updatedAt: timestamp,
    }).where(eq(connectorConfigs.id, input.connectorInstanceId)).run();
    tx.insert(githubBulkTransferEvents).values({
      runId,
      taskId: null,
      eventType: 'started',
      payload: { planHash: input.planHash, totalCount: preview.items.length },
      createdAt: timestamp,
    }).run();
  });
  return runId;
}

async function completeRun(
  runId: string,
  remote: GitHubRepositoryRepointRemote,
  dependencies: GitHubBulkTransferDependencies,
): Promise<void> {
  const run = requireRun(runId);
  const items = db.select().from(githubBulkTransferItems)
    .where(eq(githubBulkTransferItems.runId, runId)).all();
  if (items.some((item) => item.state !== 'transferred')) {
    throw new Error('Bulk transfer reconciliation found incomplete items');
  }
  for (const item of items) {
    if (taskMetadataDigest(item.taskId) !== item.beforeDigest) {
      throw new Error(`Bulk transfer reconciliation found metadata drift for ${item.taskId}`);
    }
  }
  if (
    typeof run.plan.globalBeforeDigest !== 'string'
    || globalMetadataDigest(run.connectorInstanceId) !== run.plan.globalBeforeDigest
  ) {
    throw new Error('Bulk transfer reconciliation found connector metadata drift');
  }
  if (!remote.listIssues) throw new Error('GitHub remote does not support final enumeration');
  const destinationIssues = await remote.listIssues(run.targetRepository);
  const destinationStableIds = new Set(
    destinationIssues.map((issue) => issue.node_id).filter((value): value is string => Boolean(value)),
  );
  const targetBefore = Array.isArray(run.plan.targetIssueStableIds)
    ? run.plan.targetIssueStableIds.filter((value): value is string => typeof value === 'string')
    : null;
  if (
    !targetBefore
    || destinationIssues.length !== targetBefore.length + items.length
    || items.some((item) => !destinationStableIds.has(item.issueStableId))
  ) {
    throw new Error('Bulk transfer destination counts or stable identities did not reconcile');
  }
  const now = nowIso(dependencies);
  runTransaction((tx) => {
    tx.update(connectorConfigs).set({
      enabled: run.connectorWasEnabled,
      updatedAt: now,
    }).where(eq(connectorConfigs.id, run.connectorInstanceId)).run();
    tx.update(githubBulkTransferRuns).set({
      phase: 'completed',
      transferredCount: items.length,
      failedCount: 0,
      lastError: null,
      completedAt: now,
      updatedAt: now,
    }).where(eq(githubBulkTransferRuns.id, runId)).run();
    tx.insert(githubBulkTransferEvents).values({
      runId,
      taskId: null,
      eventType: 'reconciled',
      payload: {
        sourceCount: items.length,
        destinationBeforeCount: targetBefore.length,
        destinationAfterCount: destinationIssues.length,
        transferredCount: items.length,
        skippedCount: 0,
        failedCount: 0,
        reconciledCount: items.length,
        metadataDriftCount: 0,
      },
      createdAt: now,
    }).run();
  });
}

function failRun(
  runId: string,
  message: string,
  dependencies: GitHubBulkTransferDependencies,
): void {
  const now = nowIso(dependencies);
  db.update(githubBulkTransferRuns).set({
    phase: 'failed',
    failedCount: scalar(`
      SELECT COUNT(*) AS value FROM github_bulk_transfer_items
      WHERE run_id = ? AND state IN ('failed', 'transferring')
    `, runId),
    lastError: message.slice(0, 1_000),
    updatedAt: now,
  }).where(eq(githubBulkTransferRuns.id, runId)).run();
  appendEvent(runId, null, 'failed', { error: message.slice(0, 1_000) }, now);
}

async function runBounded<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, concurrency));
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        await operation(values[index]);
      } catch (error) {
        stopped = true;
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
}

async function withRateLimitBackoff<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (!message.includes('rate limit') && !message.includes('(429)')) throw error;
      if (attempt < 3) await sleep(1_000 * 2 ** attempt);
    }
  }
  throw lastError;
}

function taskMetadataDigest(taskId: string): string {
  const task = sqlite.prepare(`
    SELECT id, title, description, status, priority, due_date, effort, metadata,
           local_disposition, completed_at, created_at
    FROM tasks WHERE id = ?
  `).get(taskId);
  if (!task) throw new Error(`Task disappeared during bulk transfer: ${taskId}`);
  const relations: Record<string, unknown[]> = {};
  for (const [table, column] of [
    ['task_projects', 'task_id'],
    ['project_phase_items', 'task_id'],
    ['task_tags', 'task_id'],
    ['task_schedules', 'task_id'],
    ['task_field_states', 'task_id'],
    ['task_linked_sources', 'task_id'],
    ['task_history_events', 'task_id'],
    ['my_day_items', 'task_id'],
    ['focus_items', 'task_id'],
    ['task_attachments', 'task_id'],
  ] as const) {
    if (!tableHasColumn(table, column)) continue;
    relations[table] = sqlite.prepare(
      `SELECT * FROM ${table} WHERE ${column} = ?`,
    ).all(taskId).sort(compareCanonical);
  }

  if (tableHasColumn('task_dependencies', 'task_id')) {
    relations.task_dependencies = sqlite.prepare(`
      SELECT * FROM task_dependencies
      WHERE task_id = ? OR depends_on_task_id = ?
    `).all(taskId, taskId).sort(compareCanonical);
  }
  return digest({ task, relations });
}

function globalMetadataDigest(connectorInstanceId: string): string {
  const connector = sqlite.prepare(`
    SELECT id, type, name, sync_mode, capabilities, settings, synced_lists, created_at
    FROM connector_configs WHERE id = ?
  `).get(connectorInstanceId);
  const sourceLists = sqlite.prepare(`
    SELECT * FROM source_lists WHERE connector_instance_id = ?
  `).all(connectorInstanceId).sort(compareCanonical);
  const suppressions = sqlite.prepare(`
    SELECT * FROM task_ingest_suppressions WHERE connector_instance_id = ?
  `).all(connectorInstanceId).sort(compareCanonical);
  return digest({ connector, sourceLists, suppressions });
}

function tableHasColumn(table: string, column: string): boolean {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

function compareCanonical(left: unknown, right: unknown): number {
  return canonical(left).localeCompare(canonical(right));
}

function repositoryBinding(
  connectorInstanceId: string,
  repository: string,
): { entityId: string; stableId: string } | null {
  const [owner, name] = repository.toLowerCase().split('/');
  const rows = sqlite.prepare(`
    SELECT e.id AS entityId, e.stable_id AS stableId
    FROM external_entity_bindings b
    JOIN external_entities e ON e.id = b.external_entity_id
    JOIN external_entity_locators l ON l.external_entity_id = e.id
    WHERE b.connector_instance_id = ?
      AND b.binding_type = 'source_list'
      AND b.state IN ('shadow', 'active')
      AND e.provider = 'github'
      AND e.entity_type = 'repository'
      AND l.valid_to IS NULL
      AND l.issue_number IS NULL
      AND l.owner_key = ?
      AND l.repository_key = ?
  `).all(connectorInstanceId, owner, name) as Array<{ entityId: string; stableId: string }>;
  return rows.length === 1 ? rows[0] : null;
}

function connectorActivity(
  connectorInstanceId: string,
  ignoreOwnedOperationLease: boolean,
): number {
  return scalar(`
    SELECT
      (SELECT COUNT(*) FROM sync_jobs
       WHERE connector_id = ? AND status IN ('queued', 'running'))
      + (SELECT COUNT(*) FROM connector_operation_leases
         WHERE connector_id = ? AND ? = 0)
      + (SELECT COUNT(*) FROM connector_maintenance_locks WHERE connector_instance_id = ?)
      AS value
  `, connectorInstanceId, connectorInstanceId, ignoreOwnedOperationLease ? 1 : 0, connectorInstanceId);
}

function blockingStateCount(connectorInstanceId: string): number {
  return scalar(`
    SELECT
      (SELECT COUNT(*) FROM tasks
       WHERE connector_instance_id = ? AND sync_status IN ('pending_push', 'push_error'))
      + (SELECT COUNT(*) FROM sync_deletion_candidates WHERE connector_id = ?)
      + (SELECT COUNT(*) FROM github_identity_collisions
         WHERE connector_instance_id = ? AND state = 'open')
      + (SELECT COUNT(*) FROM github_identity_write_cycles
         WHERE connector_instance_id = ? AND reconciliation_state IN
           ('unresolved', 'pre_dispatch_retryable', 'post_dispatch_retryable', 'quarantined'))
      AS value
  `, connectorInstanceId, connectorInstanceId, connectorInstanceId, connectorInstanceId);
}

function status(runId: string): GitHubBulkTransferStatus {
  const run = requireRun(runId);
  const counts = sqlite.prepare(`
    SELECT
      COUNT(*) AS totalCount,
      SUM(CASE WHEN state = 'transferred' THEN 1 ELSE 0 END) AS transferredCount,
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN state = 'transferring' THEN 1 ELSE 0 END) AS ambiguousCount,
      SUM(CASE WHEN state IN ('failed', 'transferring') THEN 1 ELSE 0 END) AS failedCount
    FROM github_bulk_transfer_items WHERE run_id = ?
  `).get(runId) as Record<string, number | null>;
  const connector = requireConnector(run.connectorInstanceId);
  return {
    id: run.id,
    connectorInstanceId: run.connectorInstanceId,
    phase: run.phase,
    sourceRepository: run.sourceRepository,
    targetRepository: run.targetRepository,
    planHash: run.planHash,
    totalCount: counts.totalCount ?? 0,
    transferredCount: counts.transferredCount ?? 0,
    skippedCount: run.skippedCount,
    failedCount: counts.failedCount ?? run.failedCount,
    pendingCount: counts.pendingCount ?? 0,
    ambiguousCount: counts.ambiguousCount ?? 0,
    reconciledCount: run.phase === 'completed' ? counts.transferredCount ?? 0 : 0,
    connectorEnabled: connector.enabled,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function sqlCountTransferred(runId: string): number {
  return scalar(
    `SELECT COUNT(*) AS value FROM github_bulk_transfer_items
     WHERE run_id = ? AND state = 'transferred'`,
    runId,
  );
}

function scalar(query: string, ...values: unknown[]): number {
  return Number((sqlite.prepare(query).get(...values) as { value?: number } | undefined)?.value ?? 0);
}

function appendEvent(
  runId: string,
  taskId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: string,
): void {
  db.insert(githubBulkTransferEvents).values({
    runId,
    taskId,
    eventType,
    payload,
    createdAt,
  }).run();
}

function findRun(connectorInstanceId: string, idempotencyKey: string) {
  return db.select().from(githubBulkTransferRuns).where(and(
    eq(githubBulkTransferRuns.connectorInstanceId, connectorInstanceId),
    eq(githubBulkTransferRuns.idempotencyKey, idempotencyKey),
  )).limit(1).get() ?? null;
}

function requireRun(runId: string) {
  const run = db.select().from(githubBulkTransferRuns)
    .where(eq(githubBulkTransferRuns.id, runId)).limit(1).get();
  if (!run) throw new Error('GitHub bulk transfer run was not found');
  return run;
}

function requireConnector(connectorInstanceId: string) {
  const connector = db.select().from(connectorConfigs)
    .where(eq(connectorConfigs.id, connectorInstanceId)).limit(1).get();
  if (!connector || connector.type !== 'github-issues') {
    throw new Error('GitHub connector was not found');
  }
  return connector;
}

function assertSameRun(
  run: typeof githubBulkTransferRuns.$inferSelect,
  input: GitHubBulkTransferExecuteInput,
): void {
  if (
    run.sourceRepository.toLowerCase() !== input.sourceRepository.toLowerCase()
    || run.targetRepository.toLowerCase() !== input.targetRepository.toLowerCase()
    || run.planHash !== input.planHash
  ) {
    throw new Error('Bulk transfer idempotency key belongs to another request');
  }
}

function validateExecutionInput(input: GitHubBulkTransferExecuteInput): void {
  validateInput(input);
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 192) {
    throw new Error('Bulk transfer idempotency key must be 8-192 characters');
  }
  if (!/^[a-f0-9]{64}$/.test(input.planHash)) {
    throw new Error('Bulk transfer requires a valid SHA-256 plan hash');
  }
  const expected = `${input.sourceRepository}=>${input.targetRepository}`;
  if (input.confirmation !== expected) {
    throw new Error(`Bulk transfer execution requires confirmation ${expected}`);
  }
  if (
    input.concurrency !== undefined
    && (!Number.isSafeInteger(input.concurrency)
      || input.concurrency < 1
      || input.concurrency > MAX_CONCURRENCY)
  ) {
    throw new Error(`Bulk transfer concurrency must be between 1 and ${MAX_CONCURRENCY}`);
  }
}

function validateInput(input: GitHubBulkTransferInput): void {
  validateActor(input.actor);
  if (!REPOSITORY_PATH.test(input.sourceRepository)) {
    throw new Error('Bulk transfer source repository must use owner/repository');
  }
  if (!REPOSITORY_PATH.test(input.targetRepository)) {
    throw new Error('Bulk transfer target repository must use owner/repository');
  }
  if (input.sourceRepository.toLowerCase() === input.targetRepository.toLowerCase()) {
    throw new Error('Bulk transfer source and target repositories must differ');
  }
  if (
    input.sourceRepository.split('/')[0].toLowerCase()
    !== input.targetRepository.split('/')[0].toLowerCase()
  ) {
    throw new Error('GitHub issue transfers require repositories under the same owner');
  }
}

function validateActor(actor: string): void {
  if (actor.trim().length < 1 || actor.length > 80) {
    throw new Error('Bulk transfer actor must be 1-80 characters');
  }
}

function backupReady(proof: GitHubRepointBackupProof, now: Date): boolean {
  const verifiedAt = Date.parse(proof.verifiedAt);
  return proof.integrityCheck === 'ok'
    && /^[a-f0-9]{64}$/.test(proof.sha256)
    && proof.sizeBytes > 0
    && Number.isFinite(verifiedAt)
    && now.getTime() - verifiedAt <= 24 * 60 * 60_000
    && now.getTime() >= verifiedAt;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function nowIso(dependencies: GitHubBulkTransferDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
