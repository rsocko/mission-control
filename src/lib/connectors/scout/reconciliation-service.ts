import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  ScoutPersistenceConflictError,
  MAX_SCOUT_RECONCILIATION_TASKS_PER_RUN,
  type ScoutConnectorConfigurationRecord,
  type ScoutDigestNotificationRecord,
  type ScoutEvaluationContext,
  type ScoutEvaluationDecision,
  type ScoutEvaluationPlanEnvelope,
  type ScoutIngestionReconciliationPersistence,
  type ScoutReconciliationRepository,
  type ScoutReconciliationTask,
  type ScoutSuggestionActionDecision,
  type ScoutSuggestionActionSnapshot,
  type ScoutTaskCompletionUpdate,
} from '@/db/persistence/scout-ingestion-reconciliation';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { emitEvent } from '@/lib/events';
import {
  runResumableReconciliation,
  type ResumableReconciliationSnapshot,
} from '@/lib/reconciliation';
import { getStatusLifecycleUpdates } from '@/lib/tasks/status-lifecycle';
import {
  DEFAULT_SCOUT_SETTINGS,
  parseScoutSettings,
  type ScoutConnectorSettings,
} from './settings';
import {
  evaluateReconciliationPolicy,
  parseReconciliationScope,
  reconcileRequestSchema,
  reconciliationHash,
  resolutionEvidenceSourceRefHashes,
  scoreReconciliationEvidence,
  summarizeEvidence,
  type ReconcileRequest,
  type ReconciliationAction,
  type ReconciliationPolicyDecision,
  type ReconciliationSignal,
} from './reconciliation-domain';

const MAX_TASKS_PER_RUN = MAX_SCOUT_RECONCILIATION_TASKS_PER_RUN;
const RUN_LOCK_MINUTES = 15;
const FULL_RUN_RATE_LIMIT_MINUTES = 60;
const SUGGESTION_TTL_DAYS = 14;
const SCOUT_CONNECTOR_TYPE = 'scout';
const SCOUT_DIGEST_CONNECTOR_INSTANCE_ID = 'scout-primary';
const OPEN_TASK_STATUSES = ['todo', 'in_progress'] as const;
const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;

type ScoutTask = ScoutReconciliationTask;

interface EvaluationPlan {
  runId: string;
  task: ScoutTask;
  candidateAction: ReconciliationAction;
  action: ReconciliationAction;
  confidence: number;
  signals: ReconciliationSignal[];
  evidence: ReturnType<typeof summarizeEvidence>;
  evidenceHash: string;
  policyDecision: ReconciliationPolicyDecision;
  policyReason: string;
  proposedEffect: Record<string, unknown>;
  evidenceVerified: boolean;
  dryRun: boolean;
  now: Date;
}

interface ScoutReconciliationSnapshot extends ResumableReconciliationSnapshot {
  runId: string;
  leaseToken: string;
  plans: EvaluationPlan[];
}

export interface ReconciledTaskResult {
  taskId: string;
  title: string;
  candidateAction: ReconciliationAction;
  action: ReconciliationAction;
  confidence: number;
  signals: ReturnType<typeof summarizeEvidence>;
  policyDecision: ReconciliationPolicyDecision;
  policyReason: string;
  applied: boolean;
  appliedResult: Record<string, unknown> | null;
}

export interface ReconciliationSummary extends Record<string, number> {
  autoCompleted: number;
  suggestedComplete: number;
  escalated: number;
  unchanged: number;
  ignoredSignals: number;
}

export interface ReconcileScoutResult {
  runId: string;
  idempotentReplay: boolean;
  dryRun: boolean;
  reconciled: ReconciledTaskResult[];
  summary: ReconciliationSummary;
}

export interface ReconciliationSuggestionDto {
  id: string;
  taskId: string;
  taskTitle: string;
  taskPriority: string;
  taskDueDate: string | null;
  action: 'suggest-complete' | 'escalate';
  confidence: number;
  evidence: ReturnType<typeof summarizeEvidence>;
  policyReason: string;
  payloadHash: string;
  proposedEffect: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export class ScoutReconciliationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ScoutReconciliationError';
  }
}

/** Maps an adapter's bounded compare-and-set conflict onto the service's HTTP shape. */
function asReconciliationError(error: unknown): unknown {
  if (!(error instanceof ScoutPersistenceConflictError)) return error;
  return new ScoutReconciliationError(error.message, 409);
}

async function selectedReconciliationRepository(): Promise<ScoutReconciliationRepository> {
  const repositories = await getWorkerPersistenceRepositories();
  const scout = repositories.scoutIngestionReconciliation;
  if (!scout) {
    throw new ScoutReconciliationError(
      'Scout reconciliation persistence is not available in the selected backend',
      503,
    );
  }
  return scout.reconciliation;
}

function dateBefore(now: Date, amount: number, unit: 'hours' | 'minutes'): string {
  const milliseconds = amount * (unit === 'hours' ? 60 * 60 * 1000 : 60 * 1000);
  return new Date(now.getTime() - milliseconds).toISOString();
}

function dateAfter(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function toScoutConfiguration(
  record: ScoutConnectorConfigurationRecord | null,
): { enabled: boolean; settings: ScoutConnectorSettings } {
  return {
    enabled: record?.enabled === true,
    settings: record
      ? parseScoutSettings(record.settings, DEFAULT_SCOUT_SETTINGS)
      : DEFAULT_SCOUT_SETTINGS,
  };
}

/**
 * `getStatusLifecycleUpdates` returns model-shaped keys; the persistence port
 * speaks physical column names so both adapters write exactly the same columns.
 */
const COMPLETION_COLUMN_NAMES: Record<string, string> = {
  status: 'status',
  completedAt: 'completed_at',
  statusReason: 'status_reason',
};

function taskCompletion(task: ScoutTask, nowIso: string): ScoutTaskCompletionUpdate {
  const lifecycle = getStatusLifecycleUpdates({
    status: 'done',
    explicitReason: 'completed',
    completedAt: nowIso,
    currentStatus: task.status,
    currentCompletedAt: task.completedAt,
    currentStatusReason: task.statusReason,
  });
  return {
    columns: {
      ...Object.fromEntries(
        Object.entries(lifecycle).map(([key, value]) => [
          COMPLETION_COLUMN_NAMES[key] ?? key,
          value,
        ]),
      ),
      micro_status: null,
      snoozed_until: null,
      reminder_at: null,
      reminder_relative: null,
      reminder_due_time: null,
      updated_at: nowIso,
    },
    expectedStatuses: [...OPEN_TASK_STATUSES],
  };
}

async function getScopedTasks(
  repository: ScoutReconciliationRepository,
  scope: ReturnType<typeof parseReconciliationScope>,
): Promise<ScoutTask[]> {
  const rows = await repository.listScopedTasks({
    type: scope.type,
    id: scope.id ?? null,
    openStatuses: [...OPEN_TASK_STATUSES],
    connectorType: SCOUT_CONNECTOR_TYPE,
    limit: MAX_TASKS_PER_RUN + 1,
  });
  if (rows.length > MAX_TASKS_PER_RUN) {
    throw new ScoutReconciliationError(
      `Scope contains more than ${MAX_TASKS_PER_RUN} open Scout tasks; narrow the scope`,
      413,
    );
  }
  return rows;
}

async function loadRunResult(
  repository: ScoutReconciliationRepository,
  run: { id: string; dryRun: boolean; summary: Record<string, number> | null },
  idempotentReplay: boolean,
): Promise<ReconcileScoutResult> {
  const rows = await repository.loadRunEvaluations(run.id);
  return {
    runId: run.id,
    idempotentReplay,
    dryRun: run.dryRun,
    reconciled: rows.map((row) => ({
      taskId: row.taskId,
      title: row.title,
      candidateAction: row.candidateAction as ReconciliationAction,
      action: row.action as ReconciliationAction,
      confidence: row.confidence,
      signals: row.evidence as ReturnType<typeof summarizeEvidence>,
      policyDecision: row.policyDecision as ReconciliationPolicyDecision,
      policyReason: row.policyReason,
      applied: row.applied,
      appliedResult: row.appliedResult ?? null,
    })),
    summary: {
      autoCompleted: run.summary?.autoCompleted ?? 0,
      suggestedComplete: run.summary?.suggestedComplete ?? 0,
      escalated: run.summary?.escalated ?? 0,
      unchanged: run.summary?.unchanged ?? 0,
      ignoredSignals: run.summary?.ignoredSignals ?? 0,
    },
  };
}

async function findIdempotentRun(
  repository: ScoutReconciliationRepository,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ replay?: ReconcileScoutResult; retryRunId?: string }> {
  const run = await repository.findRunByIdempotencyKey(idempotencyKey);
  if (!run) return {};
  if (run.requestHash !== requestHash) {
    throw new ScoutReconciliationError(
      'The idempotency key belongs to a different reconciliation request',
      409,
    );
  }
  if (run.status === 'completed') {
    return { replay: await loadRunResult(repository, run, true) };
  }
  if (run.status === 'running') {
    throw new ScoutReconciliationError(
      'An identical reconciliation request is already running',
      409,
    );
  }
  return { retryRunId: run.id };
}

async function createRun(
  repository: ScoutReconciliationRepository,
  request: ReconcileRequest,
  scope: ReturnType<typeof parseReconciliationScope>,
  idempotencyKey: string,
  requestHash: string,
  now: Date,
  retryRunId?: string,
): Promise<{ runId?: string; leaseToken?: string; replay?: ReconcileScoutResult }> {
  const nowIso = now.toISOString();

  if (scope.type === 'all' && !request.dryRun) {
    const recent = await repository.findRecentCompletedRun({
      scopeKey: scope.key,
      startedAtOrAfter: dateBefore(now, FULL_RUN_RATE_LIMIT_MINUTES, 'minutes'),
    });
    if (recent) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (new Date(recent.startedAt).getTime() + 60 * 60 * 1000 - now.getTime()) / 1000,
        ),
      );
      throw new ScoutReconciliationError(
        'A full reconciliation may run at most once per hour',
        429,
        retryAfterSeconds,
      );
    }
  }

  const runId = retryRunId ?? randomUUID();
  const leaseToken = randomUUID();

  if (retryRunId) {
    const resumed = await repository.resumeFailedRun({
      runId: retryRunId,
      leaseToken,
      startedAt: nowIso,
    });
    if (!resumed) {
      throw new ScoutReconciliationError(
        'The failed reconciliation could not be claimed for retry',
        409,
      );
    }
    return { runId, leaseToken };
  }

  const created = await repository.createRun({
    id: runId,
    scopeKey: scope.key,
    scopeType: scope.type,
    scopeId: scope.id ?? null,
    lookbackHours: request.lookbackHours,
    dryRun: request.dryRun,
    source: request.source,
    sourceIdentity: request.sourceIdentity,
    idempotencyKey,
    requestHash,
    leaseToken,
    startedAt: nowIso,
  });
  if (created.kind === 'conflict') {
    const existing = await findIdempotentRun(repository, idempotencyKey, requestHash);
    if (existing.replay) return { replay: existing.replay };
    throw new ScoutReconciliationError(
      'Another reconciliation is already running for this scope',
      409,
    );
  }
  return { runId, leaseToken };
}

function summaryFor(
  results: readonly ReconciledTaskResult[],
  ignoredSignals: number,
): ReconciliationSummary {
  return {
    autoCompleted: results.filter(
      (result) => result.action === 'auto-complete' && result.applied,
    ).length,
    suggestedComplete: results.filter(
      (result) => result.action === 'suggest-complete',
    ).length,
    escalated: results.filter((result) => result.action === 'escalate').length,
    unchanged: results.filter((result) => result.action === 'no-change').length,
    ignoredSignals,
  };
}

function digestNotification(
  runId: string,
  summary: Record<string, number>,
  nowIso: string,
): ScoutDigestNotificationRecord | null {
  const autoCompleted = summary.autoCompleted ?? 0;
  const suggestedComplete = summary.suggestedComplete ?? 0;
  const escalated = summary.escalated ?? 0;
  if (autoCompleted + suggestedComplete + escalated === 0) return null;
  const needsReview = suggestedComplete + escalated > 0;
  return {
    id: randomUUID(),
    sourceId: `scout-reconciliation:${runId}`,
    connectorType: SCOUT_CONNECTOR_TYPE,
    connectorInstanceId: SCOUT_DIGEST_CONNECTOR_INSTANCE_ID,
    title: 'Scout reconciliation finished',
    body: `${autoCompleted} completed, ${suggestedComplete} ready for completion review, `
      + `${escalated} escalation${escalated === 1 ? '' : 's'}.`,
    level: needsReview ? 'heads_up' : 'fyi',
    levelRank: needsReview ? 2 : 3,
    category: 'automation',
    templateKey: 'scout_reconciliation_digest',
    state: 'unread',
    isActionable: false,
    receivedAt: nowIso,
    sortAt: nowIso,
    groupKey: 'scout-reconciliation',
    dedupeKey: `scout-reconciliation:${runId}`,
    navigationTarget: '/scout/reconciliation',
    metadata: { runId, summary },
    presentation: {
      sourceName: 'Scout',
      subtitle: needsReview ? 'Review requested' : 'No review required',
    },
  };
}

/**
 * Pure per-task decision, evaluated inside the run transaction. Re-checks the
 * task's current state, re-runs the auto-complete policy against the freshly
 * read connector/task-state rows, honours a previous dismissal of exactly this
 * evidence, and then names the storage effect the adapter must apply.
 */
function decideEvaluation(
  plan: EvaluationPlan,
  context: ScoutEvaluationContext,
): ScoutEvaluationDecision<ReconciledTaskResult> {
  const evaluationId = randomUUID();
  const nowIso = plan.now.toISOString();
  let task = plan.task;
  let action = plan.action;
  let policyDecision = plan.policyDecision;
  let policyReason = plan.policyReason;
  let applied = false;
  let appliedResult: Record<string, unknown> | null = null;

  if (!plan.dryRun && action !== 'no-change') {
    const currentTask = context.currentTask;
    const stillOpen = currentTask !== null
      && (OPEN_TASK_STATUSES as readonly string[]).includes(currentTask.status);
    if (!stillOpen) {
      action = 'no-change';
      policyDecision = 'deny';
      policyReason = 'The task is no longer open';
    } else {
      task = currentTask!;
      if (action === 'auto-complete') {
        const scoutConfiguration = toScoutConfiguration(context.connector);
        const currentPolicy = evaluateReconciliationPolicy({
          task,
          score: scoreReconciliationEvidence(plan.signals),
          neverAutoComplete: context.taskState?.neverAutoComplete === true,
          connectorEnabled: scoutConfiguration.enabled,
          autonomy: scoutConfiguration.settings.autonomy,
          evidenceVerified: plan.evidenceVerified,
          now: plan.now,
        });
        action = currentPolicy.action;
        policyDecision = currentPolicy.decision;
        policyReason = currentPolicy.reason;
      }
    }
  }

  if (
    !plan.dryRun
    && (action === 'suggest-complete' || action === 'escalate')
    && context.dismissedSuggestionId
  ) {
    action = 'no-change';
    policyDecision = 'deny';
    policyReason = 'The user previously dismissed this exact evidence';
    appliedResult = { suppressedBySuggestionId: context.dismissedSuggestionId };
  }

  const payloadHash = reconciliationHash({
    taskId: task.id,
    action,
    confidence: plan.confidence,
    evidenceHash: plan.evidenceHash,
    proposedEffect: plan.proposedEffect,
  });

  let effect: ScoutEvaluationDecision<ReconciledTaskResult>['effect'] = appliedResult
    ? { kind: 'record-applied-result', appliedResult }
    : { kind: 'none' };

  if (!plan.dryRun && action === 'auto-complete') {
    applied = true;
    appliedResult = { status: 'done', completedAt: nowIso };
    effect = {
      kind: 'complete-task',
      taskId: task.id,
      completion: taskCompletion(task, nowIso),
      supersedePending: {
        status: 'superseded',
        updatedAt: nowIso,
        actedAt: nowIso,
        actedBy: 'reconciliation',
      },
      appliedResult,
    };
  } else if (!plan.dryRun && (action === 'suggest-complete' || action === 'escalate')) {
    const existingPending = context.pendingSuggestion;
    if (existingPending?.evidenceHash === plan.evidenceHash) {
      appliedResult = { suggestionId: existingPending.id, existing: true };
      effect = { kind: 'reuse-suggestion', appliedResult };
    } else {
      const suggestionId = randomUUID();
      appliedResult = { suggestionId };
      effect = {
        kind: 'insert-suggestion',
        supersede: existingPending
          ? {
              suggestionId: existingPending.id,
              update: {
                status: 'superseded',
                updatedAt: nowIso,
                actedAt: nowIso,
                actedBy: 'reconciliation',
              },
            }
          : null,
        suggestion: {
          id: suggestionId,
          taskId: task.id,
          runId: plan.runId,
          evaluationId,
          action,
          status: 'pending',
          confidence: plan.confidence,
          evidenceHash: plan.evidenceHash,
          evidence: plan.evidence,
          policyDecision,
          policyReason,
          payloadHash,
          proposedEffect: plan.proposedEffect,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAt: dateAfter(plan.now, SUGGESTION_TTL_DAYS),
        },
        appliedResult,
      };
    }
  }

  return {
    evaluation: {
      id: evaluationId,
      runId: plan.runId,
      taskId: plan.task.id,
      candidateAction: plan.candidateAction,
      action,
      confidence: plan.confidence,
      evidenceHash: plan.evidenceHash,
      evidence: plan.evidence,
      policyDecision,
      policyReason,
      payloadHash,
      applied: false,
      appliedResult: null,
      createdAt: nowIso,
    },
    effect,
    result: {
      taskId: task.id,
      title: task.title,
      candidateAction: plan.candidateAction,
      action,
      confidence: plan.confidence,
      signals: plan.evidence,
      policyDecision,
      policyReason,
      applied,
      appliedResult,
    },
  };
}

export async function reconcileScoutTasks(
  rawRequest: unknown,
  options: {
    persistence?: ScoutIngestionReconciliationPersistence;
    now?: Date;
    verifiedSourceRefHashes?: ReadonlySet<string>;
  } = {},
): Promise<ReconcileScoutResult> {
  const repository = options.persistence?.reconciliation
    ?? await selectedReconciliationRepository();
  const now = options.now ?? new Date();
  const parsed = reconcileRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new ScoutReconciliationError(
      parsed.error.issues[0]?.message ?? 'Invalid reconciliation request',
      400,
    );
  }
  const request = parsed.data;
  let scope: ReturnType<typeof parseReconciliationScope>;
  try {
    scope = parseReconciliationScope(request.scope);
  } catch (error) {
    throw new ScoutReconciliationError(
      error instanceof Error ? error.message : 'Invalid scope',
      400,
    );
  }
  if (
    new Set(request.signals.map((signal) => signal.signalId)).size !== request.signals.length
  ) {
    throw new ScoutReconciliationError('signalId values must be unique within a run', 400);
  }
  const evidenceIdentities = request.signals.map(
    (signal) => `${signal.taskId}:${signal.sourceRefHash}:${signal.kind}`,
  );
  if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
    throw new ScoutReconciliationError(
      'Duplicate evidence artifacts are not allowed within a run',
      400,
    );
  }

  const requestHash = reconciliationHash({
    scope,
    lookbackHours: request.lookbackHours,
    dryRun: request.dryRun,
    source: request.source,
    sourceIdentity: request.sourceIdentity,
    signals: request.signals,
  });
  const idempotencyKey = request.idempotencyKey ?? requestHash;
  await repository.expireStaleRuns({
    scopeKey: scope.key,
    startedBefore: dateBefore(now, RUN_LOCK_MINUTES, 'minutes'),
    completedAt: now.toISOString(),
    error: 'Run lock expired before completion',
  });
  const existing = await findIdempotentRun(repository, idempotencyKey, requestHash);
  if (existing.replay) return existing.replay;

  const run = await createRun(
    repository,
    request,
    scope,
    idempotencyKey,
    requestHash,
    now,
    existing.retryRunId,
  );
  if (run.replay) return run.replay;
  const runId = run.runId!;
  const leaseToken = run.leaseToken!;

  try {
    const scopedTasks = await getScopedTasks(repository, scope);
    const taskIds = new Set(scopedTasks.map((task) => task.id));
    const cutoff = now.getTime() - request.lookbackHours * 60 * 60 * 1000;
    const eligibleSignals = request.signals.filter((signal) => {
      const occurredAt = new Date(signal.occurredAt).getTime();
      return taskIds.has(signal.taskId) && occurredAt >= cutoff && occurredAt <= now.getTime();
    });
    const ignoredSignals = request.signals.length - eligibleSignals.length;
    const taskStateRows = scopedTasks.length === 0
      ? []
      : await repository.listTaskStates(scopedTasks.map((task) => task.id));
    const stateByTask = new Map(taskStateRows.map((state) => [state.taskId, state]));
    const signalsByTask = new Map<string, ReconciliationSignal[]>();
    for (const signal of eligibleSignals) {
      const current = signalsByTask.get(signal.taskId) ?? [];
      current.push(signal);
      signalsByTask.set(signal.taskId, current);
    }

    const connectorCache = new Map<
      string,
      { enabled: boolean; settings: ScoutConnectorSettings }
    >();
    const plans: EvaluationPlan[] = [];
    for (const task of scopedTasks) {
      const signals = signalsByTask.get(task.id) ?? [];
      const score = scoreReconciliationEvidence(signals);
      const resolutionSourceRefs = resolutionEvidenceSourceRefHashes(signals);
      const evidenceVerified = resolutionSourceRefs.length > 0
        && resolutionSourceRefs.every(
          (sourceRef) => options.verifiedSourceRefHashes?.has(sourceRef) === true,
        );
      let scoutConfiguration = connectorCache.get(task.connectorInstanceId);
      if (!scoutConfiguration) {
        scoutConfiguration = toScoutConfiguration(
          await repository.getConnectorConfiguration({
            connectorType: SCOUT_CONNECTOR_TYPE,
            connectorInstanceId: task.connectorInstanceId,
          }),
        );
        connectorCache.set(task.connectorInstanceId, scoutConfiguration);
      }
      const policy = evaluateReconciliationPolicy({
        task,
        score,
        neverAutoComplete: stateByTask.get(task.id)?.neverAutoComplete === true,
        connectorEnabled: scoutConfiguration.enabled,
        autonomy: scoutConfiguration.settings.autonomy,
        evidenceVerified,
        now,
      });
      const evidence = summarizeEvidence(signals);
      const evidenceHash = reconciliationHash(evidence);
      const proposedEffect = policy.action === 'escalate'
        ? { taskId: task.id, priority: score.suggestedPriority }
        : { taskId: task.id, status: 'done', statusReason: 'completed' };
      plans.push({
        runId,
        task,
        candidateAction: score.candidateAction,
        action: policy.action,
        confidence: score.confidence,
        signals,
        evidence,
        evidenceHash,
        policyDecision: policy.decision,
        policyReason: policy.reason,
        proposedEffect,
        evidenceVerified,
        dryRun: request.dryRun,
        now,
      });
    }

    const engineResult = await runResumableReconciliation({
      createSnapshot: async (): Promise<ScoutReconciliationSnapshot> => ({
        runId,
        leaseToken,
        plans: [],
        status: 'running',
        cursor: 0,
        total: plans.length,
        batchSize: Math.max(1, plans.length),
        failureCount: 0,
        nextAttemptAt: null,
      }),
      loadBatch: async (_snapshot, window) => plans.slice(window.start, window.end),
      executeBatch: async (_snapshot, batch) => batch,
      advanceCursor: async (snapshot, batch, window) => ({
        ...snapshot,
        cursor: window.end,
        plans: [...snapshot.plans, ...batch],
      }),
      classifyRetry: () => ({ retryable: false }),
      recordFailure: async (snapshot, failure) => ({
        ...snapshot,
        status: 'failed' as const,
        failureCount: failure.failureCount,
        nextAttemptAt: failure.nextAttemptAt,
      }),
      reportProgress: (snapshot) => ({
        runId: snapshot.runId,
        processed: snapshot.cursor,
        total: snapshot.total,
        status: snapshot.status,
      }),
      complete: async (snapshot) => {
        const envelopes: ScoutEvaluationPlanEnvelope<EvaluationPlan>[] = snapshot.plans.map(
          (plan) => ({
            plan,
            taskId: plan.task.id,
            connectorInstanceId: plan.task.connectorInstanceId,
            evidenceHash: plan.evidenceHash,
          }),
        );
        let completion;
        try {
          completion = await repository.commitRun<EvaluationPlan, ReconciledTaskResult>({
            runId,
            leaseToken,
            completedAt: now.toISOString(),
            plans: envelopes,
            decide: decideEvaluation,
            summarize: (results) => summaryFor(results, ignoredSignals),
            digest: (summary) => (request.dryRun
              ? null
              : digestNotification(runId, summary, now.toISOString())),
          });
        } catch (error) {
          throw asReconciliationError(error);
        }
        return {
          snapshot: { ...snapshot, status: 'completed' as const },
          result: {
            results: completion.results,
            summary: completion.summary as ReconciliationSummary,
          },
        };
      },
    }, {
      retryBaseMs: 1,
      retryMaxMs: 1,
      now: () => now,
    });
    if (engineResult.outcome !== 'completed') {
      throw new ScoutReconciliationError(
        'Atomic Scout reconciliation did not complete its single batch',
        500,
      );
    }
    const { results, summary } = engineResult.completion;

    for (const completed of results.filter(
      (result) => result.action === 'auto-complete' && result.applied,
    )) {
      emitEvent({
        type: 'task.completed',
        timestamp: now.toISOString(),
        payload: {
          id: completed.taskId,
          title: completed.title,
          connectorType: SCOUT_CONNECTOR_TYPE,
          completedAt: now.toISOString(),
        },
      }).catch(() => undefined);
    }

    return {
      runId,
      idempotentReplay: false,
      dryRun: request.dryRun,
      reconciled: results,
      summary,
    };
  } catch (error) {
    await repository.failRun({
      runId,
      leaseToken,
      error: error instanceof Error
        ? error.message.slice(0, 500)
        : 'Unknown reconciliation failure',
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export async function listReconciliationSuggestions(
  options: {
    persistence?: ScoutIngestionReconciliationPersistence;
    now?: Date;
    limit?: number;
  } = {},
): Promise<ReconciliationSuggestionDto[]> {
  const repository = options.persistence?.reconciliation
    ?? await selectedReconciliationRepository();
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const rows = await repository.listPendingSuggestions({
    now: now.toISOString(),
    limit,
    openStatuses: [...OPEN_TASK_STATUSES],
    terminalStatuses: [...TERMINAL_TASK_STATUSES],
  });
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    taskPriority: row.taskPriority,
    taskDueDate: row.taskDueDate,
    action: row.action,
    confidence: row.confidence,
    evidence: row.evidence as ReturnType<typeof summarizeEvidence>,
    policyReason: row.policyReason,
    payloadHash: row.payloadHash,
    proposedEffect: row.proposedEffect,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
}

export type ReconciliationSuggestionActionResult =
  | {
      suggestionId: string;
      status: 'accepted';
      taskId?: string;
      idempotentReplay: boolean;
    }
  | {
      suggestionId: string;
      status: 'dismissed';
      neverAutoComplete: boolean;
      idempotentReplay: boolean;
    };

export async function actOnReconciliationSuggestion(
  suggestionId: string,
  input: {
    action: 'accept' | 'dismiss' | 'never-auto-complete';
    payloadHash: string;
    actor: string;
  },
  options: {
    persistence?: ScoutIngestionReconciliationPersistence;
    now?: Date;
  } = {},
): Promise<ReconciliationSuggestionActionResult> {
  const repository = options.persistence?.reconciliation
    ?? await selectedReconciliationRepository();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const completionEvent: {
    current: {
      id: string;
      title: string;
      connectorType: string;
      priority: string;
    } | null;
  } = { current: null };

  const decide = (
    snapshot: ScoutSuggestionActionSnapshot,
  ): ScoutSuggestionActionDecision<ReconciliationSuggestionActionResult> => {
    const suggestion = snapshot.suggestion;
    if (!suggestion) {
      throw new ScoutReconciliationError('Reconciliation suggestion not found', 404);
    }
    if (suggestion.payloadHash !== input.payloadHash) {
      throw new ScoutReconciliationError('The suggestion changed; refresh before acting', 409);
    }
    if (suggestion.status === 'accepted' && input.action === 'accept') {
      return {
        kind: 'replay',
        result: { suggestionId, status: 'accepted', idempotentReplay: true },
      };
    }
    if (suggestion.status !== 'pending') {
      throw new ScoutReconciliationError(`Suggestion is already ${suggestion.status}`, 409);
    }
    if (new Date(suggestion.expiresAt).getTime() <= now.getTime()) {
      throw new ScoutReconciliationError('Suggestion expired; run reconciliation again', 409);
    }

    const task = snapshot.task;
    if (!task) throw new ScoutReconciliationError('Task not found', 404);

    if (input.action === 'accept') {
      if (suggestion.action !== 'suggest-complete') {
        throw new ScoutReconciliationError(
          'Escalation execution is not authorized by the Scout task ownership policy',
          409,
        );
      }
      if (!toScoutConfiguration(snapshot.connector).enabled) {
        throw new ScoutReconciliationError('The Scout connector is disabled', 403);
      }
      completionEvent.current = {
        id: task.id,
        title: task.title,
        connectorType: task.connectorType,
        priority: task.priority,
      };
      return {
        kind: 'accept',
        result: {
          suggestionId,
          status: 'accepted',
          taskId: task.id,
          idempotentReplay: false,
        },
        expectedPayloadHash: input.payloadHash,
        suggestionUpdate: {
          status: 'accepted',
          updatedAt: nowIso,
          actedAt: nowIso,
          actedBy: input.actor,
        },
        taskId: task.id,
        completion: taskCompletion(task, nowIso),
        evaluationId: suggestion.evaluationId,
        appliedResult: {
          status: 'done',
          completedAt: nowIso,
          confirmationActor: input.actor,
          suggestionId,
        },
      };
    }

    return {
      kind: 'dismiss',
      result: {
        suggestionId,
        status: 'dismissed',
        neverAutoComplete: input.action === 'never-auto-complete',
        idempotentReplay: false,
      },
      expectedPayloadHash: input.payloadHash,
      suggestionUpdate: {
        status: 'dismissed',
        updatedAt: nowIso,
        actedAt: nowIso,
        actedBy: input.actor,
      },
      taskState: input.action === 'never-auto-complete'
        ? {
            taskId: task.id,
            neverAutoComplete: true,
            reason: 'user_requested',
            sourceRunId: suggestion.runId,
            updatedAt: nowIso,
            updatedBy: input.actor,
          }
        : null,
    };
  };

  let result: ReconciliationSuggestionActionResult;
  try {
    result = await repository.actOnSuggestion({ suggestionId, decide });
  } catch (error) {
    throw asReconciliationError(error);
  }

  if (result.status === 'accepted' && !result.idempotentReplay && completionEvent.current) {
    emitEvent({
      type: 'task.completed',
      timestamp: nowIso,
      payload: {
        ...completionEvent.current,
        completedAt: nowIso,
      },
    }).catch(() => undefined);
  }
  return result;
}

export async function wasTaskAutoCompletedByReconciliation(
  taskId: string,
  options: { persistence?: ScoutIngestionReconciliationPersistence } = {},
): Promise<boolean> {
  const repository = options.persistence?.reconciliation
    ?? await selectedReconciliationRepository();
  return repository.hasAppliedAutoCompletion(taskId);
}
