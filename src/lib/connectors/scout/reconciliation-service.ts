import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import db from '@/db';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  notifications,
  scoutReconciliationEvaluations,
  scoutReconciliationRuns,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
  taskProjects,
  tasks,
} from '@/db/schema';
import { emitEvent } from '@/lib/events';
import {
  runResumableReconciliation,
  type ResumableReconciliationSnapshot,
} from '@/lib/reconciliation';
import { getStatusLifecycleUpdates } from '@/lib/tasks/status-lifecycle';
import {
  DEFAULT_SCOUT_SETTINGS,
  parseScoutSettings,
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

type ReconciliationDatabase = BetterSQLite3Database<typeof schema>;

interface ScoutReconciliationSnapshot extends ResumableReconciliationSnapshot {
  runId: string;
  leaseToken: string;
  plans: Parameters<typeof persistEvaluation>[1][];
}

const MAX_TASKS_PER_RUN = 200;
const RUN_LOCK_MINUTES = 15;
const FULL_RUN_RATE_LIMIT_MINUTES = 60;
const SUGGESTION_TTL_DAYS = 14;

type ScoutTask = Pick<
  typeof tasks.$inferSelect,
  'id' | 'title' | 'connectorType' | 'connectorInstanceId' | 'sourceId' | 'status'
  | 'priority' | 'dueDate' | 'completedAt' | 'statusReason'
>;

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

function dateBefore(now: Date, amount: number, unit: 'hours' | 'minutes'): string {
  const milliseconds = amount * (unit === 'hours' ? 60 * 60 * 1000 : 60 * 1000);
  return new Date(now.getTime() - milliseconds).toISOString();
}

function dateAfter(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function getScoutConfiguration(
  database: ReconciliationDatabase,
  connectorInstanceId?: string,
) {
  const [connector] = await database.select({
    enabled: connectorConfigs.enabled,
    settings: connectorConfigs.settings,
  })
    .from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.type, 'scout'),
      isNull(connectorConfigs.deletedAt),
      ...(connectorInstanceId ? [eq(connectorConfigs.id, connectorInstanceId)] : []),
    ))
    .limit(1);

  return {
    enabled: connector?.enabled === true,
    settings: connector
      ? parseScoutSettings(connector.settings, DEFAULT_SCOUT_SETTINGS)
      : DEFAULT_SCOUT_SETTINGS,
  };
}

async function getScopedTasks(
  database: ReconciliationDatabase,
  scope: ReturnType<typeof parseReconciliationScope>,
): Promise<ScoutTask[]> {
  const fields = {
    id: tasks.id,
    title: tasks.title,
    connectorType: tasks.connectorType,
    connectorInstanceId: tasks.connectorInstanceId,
    sourceId: tasks.sourceId,
    status: tasks.status,
    priority: tasks.priority,
    dueDate: tasks.dueDate,
    completedAt: tasks.completedAt,
    statusReason: tasks.statusReason,
  };
  const openScout = and(
    eq(tasks.connectorType, 'scout'),
    inArray(tasks.status, ['todo', 'in_progress']),
  );

  const rows = scope.type === 'project'
    ? await database.select(fields)
        .from(tasks)
        .innerJoin(taskProjects, eq(taskProjects.taskId, tasks.id))
        .where(and(openScout, eq(taskProjects.projectId, scope.id!)))
        .limit(MAX_TASKS_PER_RUN + 1)
    : await database.select(fields)
        .from(tasks)
        .where(and(
          openScout,
          ...(scope.type === 'task' ? [eq(tasks.id, scope.id!)] : []),
        ))
        .limit(MAX_TASKS_PER_RUN + 1);

  if (rows.length > MAX_TASKS_PER_RUN) {
    throw new ScoutReconciliationError(
      `Scope contains more than ${MAX_TASKS_PER_RUN} open Scout tasks; narrow the scope`,
      413,
    );
  }
  return rows;
}

async function loadRunResult(
  database: ReconciliationDatabase,
  run: typeof scoutReconciliationRuns.$inferSelect,
  idempotentReplay: boolean,
): Promise<ReconcileScoutResult> {
  const rows = await database.select({
    taskId: scoutReconciliationEvaluations.taskId,
    title: tasks.title,
    candidateAction: scoutReconciliationEvaluations.candidateAction,
    action: scoutReconciliationEvaluations.action,
    confidence: scoutReconciliationEvaluations.confidence,
    evidence: scoutReconciliationEvaluations.evidence,
    policyDecision: scoutReconciliationEvaluations.policyDecision,
    policyReason: scoutReconciliationEvaluations.policyReason,
    applied: scoutReconciliationEvaluations.applied,
    appliedResult: scoutReconciliationEvaluations.appliedResult,
  })
    .from(scoutReconciliationEvaluations)
    .innerJoin(tasks, eq(tasks.id, scoutReconciliationEvaluations.taskId))
    .where(eq(scoutReconciliationEvaluations.runId, run.id));

  return {
    runId: run.id,
    idempotentReplay,
    dryRun: run.dryRun,
    reconciled: rows.map((row) => ({
      ...row,
      signals: row.evidence,
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
  database: ReconciliationDatabase,
  idempotencyKey: string,
  requestHash: string,
) {
  const [run] = await database.select()
    .from(scoutReconciliationRuns)
    .where(eq(scoutReconciliationRuns.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!run) return {};
  if (run.requestHash !== requestHash) {
    throw new ScoutReconciliationError('The idempotency key belongs to a different reconciliation request', 409);
  }
  if (run.status === 'completed') return { replay: await loadRunResult(database, run, true) };
  if (run.status === 'running') {
    throw new ScoutReconciliationError('An identical reconciliation request is already running', 409);
  }
  return { retryRunId: run.id };
}

async function expireStaleRuns(
  database: ReconciliationDatabase,
  scope: ReturnType<typeof parseReconciliationScope>,
  now: Date,
) {
  await database.update(scoutReconciliationRuns)
    .set({
      status: 'failed',
      error: 'Run lock expired before completion',
      completedAt: now.toISOString(),
    })
    .where(and(
      eq(scoutReconciliationRuns.scopeKey, scope.key),
      eq(scoutReconciliationRuns.status, 'running'),
      lte(scoutReconciliationRuns.startedAt, dateBefore(now, RUN_LOCK_MINUTES, 'minutes')),
    ));
}

async function createRun(
  database: ReconciliationDatabase,
  request: ReconcileRequest,
  scope: ReturnType<typeof parseReconciliationScope>,
  idempotencyKey: string,
  requestHash: string,
  now: Date,
  retryRunId?: string,
) {
  const nowIso = now.toISOString();

  if (scope.type === 'all' && !request.dryRun) {
    const [recent] = await database.select({
      startedAt: scoutReconciliationRuns.startedAt,
    })
      .from(scoutReconciliationRuns)
      .where(and(
        eq(scoutReconciliationRuns.scopeKey, scope.key),
        eq(scoutReconciliationRuns.dryRun, false),
        eq(scoutReconciliationRuns.status, 'completed'),
        gte(scoutReconciliationRuns.startedAt, dateBefore(now, FULL_RUN_RATE_LIMIT_MINUTES, 'minutes')),
      ))
      .orderBy(desc(scoutReconciliationRuns.startedAt))
      .limit(1);
    if (recent) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(recent.startedAt).getTime() + 60 * 60 * 1000 - now.getTime()) / 1000),
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
  try {
    if (retryRunId) {
      const resumed = database.update(scoutReconciliationRuns).set({
        leaseToken,
        status: 'running',
        error: null,
        summary: null,
        startedAt: nowIso,
        completedAt: null,
      }).where(and(
        eq(scoutReconciliationRuns.id, retryRunId),
        eq(scoutReconciliationRuns.status, 'failed'),
      )).run();
      if (resumed.changes !== 1) {
        throw new ScoutReconciliationError('The failed reconciliation could not be claimed for retry', 409);
      }
    } else {
      await database.insert(scoutReconciliationRuns).values({
        id: runId,
        scopeKey: scope.key,
        scopeType: scope.type,
        scopeId: scope.id,
        lookbackHours: request.lookbackHours,
        dryRun: request.dryRun,
        source: request.source,
        sourceIdentity: request.sourceIdentity,
        idempotencyKey,
        requestHash,
        leaseToken,
        status: 'running',
        startedAt: nowIso,
      });
    }
  } catch (error) {
    if (error instanceof ScoutReconciliationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('UNIQUE constraint failed')) throw error;
    const existing = await findIdempotentRun(database, idempotencyKey, requestHash);
    if (existing.replay) return { replay: existing.replay };
    throw new ScoutReconciliationError('Another reconciliation is already running for this scope', 409);
  }
  return { runId, leaseToken };
}

function summaryFor(results: ReconciledTaskResult[], ignoredSignals: number): ReconciliationSummary {
  return {
    autoCompleted: results.filter((result) => result.action === 'auto-complete' && result.applied).length,
    suggestedComplete: results.filter((result) => result.action === 'suggest-complete').length,
    escalated: results.filter((result) => result.action === 'escalate').length,
    unchanged: results.filter((result) => result.action === 'no-change').length,
    ignoredSignals,
  };
}

function getScoutConfigurationSync(
  database: ReconciliationDatabase,
  connectorInstanceId: string,
) {
  const connector = database.select({
    enabled: connectorConfigs.enabled,
    settings: connectorConfigs.settings,
  })
    .from(connectorConfigs)
    .where(and(
      eq(connectorConfigs.id, connectorInstanceId),
      eq(connectorConfigs.type, 'scout'),
      isNull(connectorConfigs.deletedAt),
    ))
    .limit(1)
    .get();
  return {
    enabled: connector?.enabled === true,
    settings: connector
      ? parseScoutSettings(connector.settings, DEFAULT_SCOUT_SETTINGS)
      : DEFAULT_SCOUT_SETTINGS,
  };
}

function persistEvaluation(
  database: ReconciliationDatabase,
  input: {
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
  },
): ReconciledTaskResult {
  const evaluationId = randomUUID();
  const nowIso = input.now.toISOString();
  let task = input.task;
  let action = input.action;
  let policyDecision = input.policyDecision;
  let policyReason = input.policyReason;
  let applied = false;
  let appliedResult: Record<string, unknown> | null = null;

  if (!input.dryRun && action !== 'no-change') {
    const currentTask = database.select().from(tasks)
      .where(eq(tasks.id, input.task.id))
      .limit(1)
      .get();
    if (!currentTask || !['todo', 'in_progress'].includes(currentTask.status)) {
      action = 'no-change';
      policyDecision = 'deny';
      policyReason = 'The task is no longer open';
    } else {
      task = currentTask;
      if (action === 'auto-complete') {
        const taskState = database.select().from(scoutReconciliationTaskState)
          .where(eq(scoutReconciliationTaskState.taskId, task.id))
          .limit(1)
          .get();
        const scoutConfiguration = getScoutConfigurationSync(database, task.connectorInstanceId);
        const currentPolicy = evaluateReconciliationPolicy({
          task,
          score: scoreReconciliationEvidence(input.signals),
          neverAutoComplete: taskState?.neverAutoComplete === true,
          connectorEnabled: scoutConfiguration.enabled,
          autonomy: scoutConfiguration.settings.autonomy,
          evidenceVerified: input.evidenceVerified,
          now: input.now,
        });
        action = currentPolicy.action;
        policyDecision = currentPolicy.decision;
        policyReason = currentPolicy.reason;
      }
    }
  }

  if (!input.dryRun && (action === 'suggest-complete' || action === 'escalate')) {
    const dismissed = database.select({ id: scoutReconciliationSuggestions.id })
      .from(scoutReconciliationSuggestions)
      .where(and(
        eq(scoutReconciliationSuggestions.taskId, input.task.id),
        eq(scoutReconciliationSuggestions.evidenceHash, input.evidenceHash),
        eq(scoutReconciliationSuggestions.status, 'dismissed'),
      ))
      .limit(1)
      .get();
    if (dismissed) {
      action = 'no-change';
      policyDecision = 'deny';
      policyReason = 'The user previously dismissed this exact evidence';
      appliedResult = { suppressedBySuggestionId: dismissed.id };
    }
  }

  const payloadHash = reconciliationHash({
    taskId: task.id,
    action,
    confidence: input.confidence,
    evidenceHash: input.evidenceHash,
    proposedEffect: input.proposedEffect,
  });
  database.insert(scoutReconciliationEvaluations).values({
    id: evaluationId,
    runId: input.runId,
    taskId: input.task.id,
    candidateAction: input.candidateAction,
    action,
    confidence: input.confidence,
    evidenceHash: input.evidenceHash,
    evidence: input.evidence,
    policyDecision,
    policyReason,
    payloadHash,
    applied: false,
    appliedResult,
    createdAt: nowIso,
  }).run();

  if (!input.dryRun && action === 'auto-complete') {
    const updates = {
      ...getStatusLifecycleUpdates({
        status: 'done',
        explicitReason: 'completed',
        completedAt: nowIso,
        currentStatus: task.status,
        currentCompletedAt: task.completedAt,
        currentStatusReason: task.statusReason,
      }),
      microStatus: null,
      snoozedUntil: null,
      reminderAt: null,
      updatedAt: nowIso,
    };
    const completion = database.update(tasks).set(updates).where(and(
        eq(tasks.id, task.id),
        inArray(tasks.status, ['todo', 'in_progress']),
      )).run();
    if (completion.changes !== 1) {
      throw new ScoutReconciliationError('Task changed before completion could be applied', 409);
    }
    database.update(scoutReconciliationSuggestions).set({
      status: 'superseded',
      updatedAt: nowIso,
      actedAt: nowIso,
      actedBy: 'reconciliation',
    }).where(and(
      eq(scoutReconciliationSuggestions.taskId, task.id),
      eq(scoutReconciliationSuggestions.status, 'pending'),
    )).run();
    applied = true;
    appliedResult = { status: 'done', completedAt: nowIso };
  } else if (!input.dryRun && (action === 'suggest-complete' || action === 'escalate')) {
    const existingPending = database.select({
      id: scoutReconciliationSuggestions.id,
      evidenceHash: scoutReconciliationSuggestions.evidenceHash,
    })
      .from(scoutReconciliationSuggestions)
      .where(and(
        eq(scoutReconciliationSuggestions.taskId, input.task.id),
        eq(scoutReconciliationSuggestions.status, 'pending'),
      ))
      .limit(1)
      .get();

    if (existingPending?.evidenceHash === input.evidenceHash) {
      appliedResult = { suggestionId: existingPending.id, existing: true };
    } else {
      const suggestionId = randomUUID();
      if (existingPending) {
        database.update(scoutReconciliationSuggestions).set({
          status: 'superseded',
          updatedAt: nowIso,
          actedAt: nowIso,
          actedBy: 'reconciliation',
        }).where(and(
          eq(scoutReconciliationSuggestions.id, existingPending.id),
          eq(scoutReconciliationSuggestions.status, 'pending'),
        )).run();
      }
      database.insert(scoutReconciliationSuggestions).values({
        id: suggestionId,
        taskId: task.id,
        runId: input.runId,
        evaluationId,
        action,
        status: 'pending',
        confidence: input.confidence,
        evidenceHash: input.evidenceHash,
        evidence: input.evidence,
        policyDecision,
        policyReason,
        payloadHash,
        proposedEffect: input.proposedEffect,
        createdAt: nowIso,
        updatedAt: nowIso,
        expiresAt: dateAfter(input.now, SUGGESTION_TTL_DAYS),
      }).run();
      appliedResult = { suggestionId };
    }
  }

  if (appliedResult) {
    database.update(scoutReconciliationEvaluations)
      .set({ applied, appliedResult })
      .where(eq(scoutReconciliationEvaluations.id, evaluationId))
      .run();
  }

  return {
    taskId: task.id,
    title: task.title,
    candidateAction: input.candidateAction,
    action,
    confidence: input.confidence,
    signals: input.evidence,
    policyDecision,
    policyReason,
    applied,
    appliedResult,
  };
}

function createDigestNotification(
  database: ReconciliationDatabase,
  runId: string,
  summary: ReconciliationSummary,
  now: Date,
) {
  if (summary.autoCompleted + summary.suggestedComplete + summary.escalated === 0) return;
  const nowIso = now.toISOString();
  database.insert(notifications).values({
    id: randomUUID(),
    sourceId: `scout-reconciliation:${runId}`,
    connectorType: 'scout',
    connectorInstanceId: 'scout-primary',
    title: 'Scout reconciliation finished',
    body: `${summary.autoCompleted} completed, ${summary.suggestedComplete} ready for completion review, ${summary.escalated} escalation${summary.escalated === 1 ? '' : 's'}.`,
    level: summary.suggestedComplete + summary.escalated > 0 ? 'heads_up' : 'fyi',
    levelRank: summary.suggestedComplete + summary.escalated > 0 ? 2 : 3,
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
      subtitle: summary.suggestedComplete + summary.escalated > 0 ? 'Review requested' : 'No review required',
    },
  }).run();
}

export async function reconcileScoutTasks(
  rawRequest: unknown,
  options: {
    database?: ReconciliationDatabase;
    now?: Date;
    verifiedSourceRefHashes?: ReadonlySet<string>;
  } = {},
): Promise<ReconcileScoutResult> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const parsed = reconcileRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new ScoutReconciliationError(parsed.error.issues[0]?.message ?? 'Invalid reconciliation request', 400);
  }
  const request = parsed.data;
  let scope: ReturnType<typeof parseReconciliationScope>;
  try {
    scope = parseReconciliationScope(request.scope);
  } catch (error) {
    throw new ScoutReconciliationError(error instanceof Error ? error.message : 'Invalid scope', 400);
  }
  if (new Set(request.signals.map((signal) => signal.signalId)).size !== request.signals.length) {
    throw new ScoutReconciliationError('signalId values must be unique within a run', 400);
  }
  const evidenceIdentities = request.signals.map(
    (signal) => `${signal.taskId}:${signal.sourceRefHash}:${signal.kind}`,
  );
  if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
    throw new ScoutReconciliationError('Duplicate evidence artifacts are not allowed within a run', 400);
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
  await expireStaleRuns(database, scope, now);
  const existing = await findIdempotentRun(database, idempotencyKey, requestHash);
  if (existing.replay) return existing.replay;

  const run = await createRun(
    database,
    request,
    scope,
    idempotencyKey,
    requestHash,
    now,
    existing.retryRunId,
  );
  if (run.replay) return run.replay;
  const runId = run.runId;
  const leaseToken = run.leaseToken!;

  try {
    const scopedTasks = await getScopedTasks(database, scope);
    const taskIds = new Set(scopedTasks.map((task) => task.id));
    const cutoff = now.getTime() - request.lookbackHours * 60 * 60 * 1000;
    const eligibleSignals = request.signals.filter((signal) => {
      const occurredAt = new Date(signal.occurredAt).getTime();
      return taskIds.has(signal.taskId) && occurredAt >= cutoff && occurredAt <= now.getTime();
    });
    const ignoredSignals = request.signals.length - eligibleSignals.length;
    const taskStateRows = scopedTasks.length === 0
      ? []
      : await database.select()
          .from(scoutReconciliationTaskState)
          .where(inArray(scoutReconciliationTaskState.taskId, scopedTasks.map((task) => task.id)));
    const stateByTask = new Map(taskStateRows.map((state) => [state.taskId, state]));
    const signalsByTask = new Map<string, ReconciliationSignal[]>();
    for (const signal of eligibleSignals) {
      const current = signalsByTask.get(signal.taskId) ?? [];
      current.push(signal);
      signalsByTask.set(signal.taskId, current);
    }

    const plans: Parameters<typeof persistEvaluation>[1][] = [];
    for (const task of scopedTasks) {
      const signals = signalsByTask.get(task.id) ?? [];
      const score = scoreReconciliationEvidence(signals);
      const resolutionSourceRefs = resolutionEvidenceSourceRefHashes(signals);
      const evidenceVerified = resolutionSourceRefs.length > 0
        && resolutionSourceRefs.every((sourceRef) => options.verifiedSourceRefHashes?.has(sourceRef) === true);
      const scoutConfiguration = await getScoutConfiguration(database, task.connectorInstanceId);
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
        const completionResult = database.transaction((tx) => {
          const results = snapshot.plans.map((plan) => persistEvaluation(tx, plan));
          const summary = summaryFor(results, ignoredSignals);
          if (!request.dryRun) createDigestNotification(tx, runId, summary, now);
          const completion = tx.update(scoutReconciliationRuns).set({
            status: 'completed',
            summary,
            completedAt: now.toISOString(),
          }).where(and(
            eq(scoutReconciliationRuns.id, runId),
            eq(scoutReconciliationRuns.status, 'running'),
            eq(scoutReconciliationRuns.leaseToken, leaseToken),
          )).run();
          if (completion.changes !== 1) {
            throw new ScoutReconciliationError('Reconciliation run lost its active claim', 409);
          }
          return { results, summary };
        });
        return {
          snapshot: { ...snapshot, status: 'completed' as const },
          result: completionResult,
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

    for (const completed of results.filter((result) => result.action === 'auto-complete' && result.applied)) {
      emitEvent({
        type: 'task.completed',
        timestamp: now.toISOString(),
        payload: {
          id: completed.taskId,
          title: completed.title,
          connectorType: 'scout',
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
    await database.update(scoutReconciliationRuns).set({
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown reconciliation failure',
      completedAt: new Date().toISOString(),
    }).where(and(
      eq(scoutReconciliationRuns.id, runId),
      eq(scoutReconciliationRuns.status, 'running'),
      eq(scoutReconciliationRuns.leaseToken, leaseToken),
    ));
    throw error;
  }
}

export async function listReconciliationSuggestions(
  options: { database?: ReconciliationDatabase; now?: Date; limit?: number } = {},
): Promise<ReconciliationSuggestionDto[]> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  await database.update(scoutReconciliationSuggestions).set({
    status: 'superseded',
    updatedAt: now.toISOString(),
    actedAt: now.toISOString(),
    actedBy: 'expiration',
  }).where(and(
    eq(scoutReconciliationSuggestions.status, 'pending'),
    lte(scoutReconciliationSuggestions.expiresAt, now.toISOString()),
  ));
  await database.update(scoutReconciliationSuggestions).set({
    status: 'superseded',
    updatedAt: now.toISOString(),
    actedAt: now.toISOString(),
    actedBy: 'task-terminal',
  }).where(and(
    eq(scoutReconciliationSuggestions.status, 'pending'),
    sql`EXISTS (
      SELECT 1 FROM ${tasks}
      WHERE ${tasks.id} = ${scoutReconciliationSuggestions.taskId}
        AND ${tasks.status} IN ('done', 'cancelled')
    )`,
  ));

  const rows = await database.select({
    id: scoutReconciliationSuggestions.id,
    taskId: scoutReconciliationSuggestions.taskId,
    taskTitle: tasks.title,
    taskPriority: tasks.priority,
    taskDueDate: tasks.dueDate,
    action: scoutReconciliationSuggestions.action,
    confidence: scoutReconciliationSuggestions.confidence,
    evidence: scoutReconciliationSuggestions.evidence,
    policyReason: scoutReconciliationSuggestions.policyReason,
    payloadHash: scoutReconciliationSuggestions.payloadHash,
    proposedEffect: scoutReconciliationSuggestions.proposedEffect,
    createdAt: scoutReconciliationSuggestions.createdAt,
    expiresAt: scoutReconciliationSuggestions.expiresAt,
  })
    .from(scoutReconciliationSuggestions)
    .innerJoin(tasks, eq(tasks.id, scoutReconciliationSuggestions.taskId))
    .where(and(
      eq(scoutReconciliationSuggestions.status, 'pending'),
      inArray(tasks.status, ['todo', 'in_progress']),
    ))
    .orderBy(desc(scoutReconciliationSuggestions.confidence), desc(scoutReconciliationSuggestions.createdAt))
    .limit(limit);
  return rows;
}

export async function actOnReconciliationSuggestion(
  suggestionId: string,
  input: {
    action: 'accept' | 'dismiss' | 'never-auto-complete';
    payloadHash: string;
    actor: string;
  },
  options: { database?: ReconciliationDatabase; now?: Date } = {},
) {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const completionEvent: { current: {
    id: string;
    title: string;
    connectorType: string;
    priority: string;
  } | null } = { current: null };

  const result = database.transaction((tx) => {
    const suggestion = tx.select()
      .from(scoutReconciliationSuggestions)
      .where(eq(scoutReconciliationSuggestions.id, suggestionId))
      .limit(1)
      .get();
    if (!suggestion) throw new ScoutReconciliationError('Reconciliation suggestion not found', 404);
    if (suggestion.payloadHash !== input.payloadHash) {
      throw new ScoutReconciliationError('The suggestion changed; refresh before acting', 409);
    }
    if (suggestion.status === 'accepted' && input.action === 'accept') {
      return { suggestionId, status: 'accepted' as const, idempotentReplay: true };
    }
    if (suggestion.status !== 'pending') {
      throw new ScoutReconciliationError(`Suggestion is already ${suggestion.status}`, 409);
    }
    if (new Date(suggestion.expiresAt).getTime() <= now.getTime()) {
      throw new ScoutReconciliationError('Suggestion expired; run reconciliation again', 409);
    }

    const task = tx.select().from(tasks).where(eq(tasks.id, suggestion.taskId)).limit(1).get();
    if (!task) throw new ScoutReconciliationError('Task not found', 404);

    if (input.action === 'accept') {
      if (suggestion.action !== 'suggest-complete') {
        throw new ScoutReconciliationError('Escalation execution is not authorized by the Scout task ownership policy', 409);
      }
      const scoutConfiguration = getScoutConfigurationSync(tx, task.connectorInstanceId);
      if (!scoutConfiguration.enabled) {
        throw new ScoutReconciliationError('The Scout connector is disabled', 403);
      }
      const claimed = tx.update(scoutReconciliationSuggestions).set({
        status: 'accepted',
        updatedAt: nowIso,
        actedAt: nowIso,
        actedBy: input.actor,
      }).where(and(
        eq(scoutReconciliationSuggestions.id, suggestionId),
        eq(scoutReconciliationSuggestions.status, 'pending'),
        eq(scoutReconciliationSuggestions.payloadHash, input.payloadHash),
      )).run();
      if (claimed.changes !== 1) {
        throw new ScoutReconciliationError('Suggestion was acted on concurrently', 409);
      }
      const completed = tx.update(tasks).set({
        ...getStatusLifecycleUpdates({
          status: 'done',
          explicitReason: 'completed',
          completedAt: nowIso,
          currentStatus: task.status,
          currentCompletedAt: task.completedAt,
          currentStatusReason: task.statusReason,
        }),
        microStatus: null,
        snoozedUntil: null,
        reminderAt: null,
        updatedAt: nowIso,
      }).where(and(
        eq(tasks.id, task.id),
        inArray(tasks.status, ['todo', 'in_progress']),
      )).run();
      if (completed.changes !== 1) {
        throw new ScoutReconciliationError('Task changed before confirmation could be applied', 409);
      }
      tx.update(scoutReconciliationEvaluations).set({
        applied: true,
        appliedResult: {
          status: 'done',
          completedAt: nowIso,
          confirmationActor: input.actor,
          suggestionId,
        },
      }).where(eq(scoutReconciliationEvaluations.id, suggestion.evaluationId)).run();
      completionEvent.current = {
        id: task.id,
        title: task.title,
        connectorType: task.connectorType,
        priority: task.priority,
      };
      return {
        suggestionId,
        status: 'accepted' as const,
        taskId: task.id,
        idempotentReplay: false,
      };
    }

    const claimed = tx.update(scoutReconciliationSuggestions).set({
      status: 'dismissed',
      updatedAt: nowIso,
      actedAt: nowIso,
      actedBy: input.actor,
    }).where(and(
      eq(scoutReconciliationSuggestions.id, suggestionId),
      eq(scoutReconciliationSuggestions.status, 'pending'),
      eq(scoutReconciliationSuggestions.payloadHash, input.payloadHash),
    )).run();
    if (claimed.changes !== 1) {
      throw new ScoutReconciliationError('Suggestion was acted on concurrently', 409);
    }
    if (input.action === 'never-auto-complete') {
      tx.insert(scoutReconciliationTaskState).values({
        taskId: task.id,
        neverAutoComplete: true,
        reason: 'user_requested',
        sourceRunId: suggestion.runId,
        updatedAt: nowIso,
        updatedBy: input.actor,
      }).onConflictDoUpdate({
        target: scoutReconciliationTaskState.taskId,
        set: {
          neverAutoComplete: true,
          reason: 'user_requested',
          sourceRunId: suggestion.runId,
          updatedAt: nowIso,
          updatedBy: input.actor,
        },
      }).run();
    }
    return {
      suggestionId,
      status: 'dismissed' as const,
      neverAutoComplete: input.action === 'never-auto-complete',
      idempotentReplay: false,
    };
  });

  if (completionEvent.current) {
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
  database: ReconciliationDatabase = db,
) {
  const [evaluation] = await database.select({ id: scoutReconciliationEvaluations.id })
    .from(scoutReconciliationEvaluations)
    .where(and(
      eq(scoutReconciliationEvaluations.taskId, taskId),
      eq(scoutReconciliationEvaluations.action, 'auto-complete'),
      eq(scoutReconciliationEvaluations.applied, true),
    ))
    .limit(1);
  return Boolean(evaluation);
}

export function supersedePendingReconciliationSuggestions(
  database: ReconciliationDatabase,
  taskId: string,
  nowIso: string,
  actor = 'task-terminal',
) {
  database.update(scoutReconciliationSuggestions).set({
    status: 'superseded',
    updatedAt: nowIso,
    actedAt: nowIso,
    actedBy: actor,
  }).where(and(
    eq(scoutReconciliationSuggestions.taskId, taskId),
    eq(scoutReconciliationSuggestions.status, 'pending'),
  )).run();
}

type ReconciliationWriter = Pick<ReconciliationDatabase, 'insert' | 'update'>;

export function suppressAutoCompletionAfterReopen(
  writer: ReconciliationWriter,
  taskId: string,
  now: string,
) {
  writer.insert(scoutReconciliationTaskState).values({
    taskId,
    neverAutoComplete: true,
    reason: 'reopened_after_auto_completion',
    updatedAt: now,
    updatedBy: 'task-reopen',
  }).onConflictDoUpdate({
    target: scoutReconciliationTaskState.taskId,
    set: {
      neverAutoComplete: true,
      reason: 'reopened_after_auto_completion',
      updatedAt: now,
      updatedBy: 'task-reopen',
    },
  }).run();
  writer.update(scoutReconciliationSuggestions).set({
    status: 'dismissed',
    updatedAt: now,
    actedAt: now,
    actedBy: 'task-reopen',
  }).where(and(
    eq(scoutReconciliationSuggestions.taskId, taskId),
    eq(scoutReconciliationSuggestions.status, 'pending'),
  )).run();
}
