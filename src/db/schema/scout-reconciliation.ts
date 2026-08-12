import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ReconciliationSignalKind } from '@/lib/connectors/scout/reconciliation-domain';
import type { ScoutSourceType } from '@/lib/connectors/scout/settings';

export type ReconciliationEvidenceSummary = Array<{
  signalId: string;
  sourceType: ScoutSourceType;
  kind: ReconciliationSignalKind;
  occurredAt: string;
  summary: string;
  sourceRefHash: string;
}>;

export const scoutReconciliationRuns = sqliteTable('scout_reconciliation_runs', {
  id: text('id').primaryKey(),
  scopeKey: text('scope_key').notNull(),
  scopeType: text('scope_type').$type<'all' | 'project' | 'task'>().notNull(),
  scopeId: text('scope_id'),
  lookbackHours: integer('lookback_hours').notNull(),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
  source: text('source').$type<'api' | 'automation'>().notNull(),
  sourceIdentity: text('source_identity').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  leaseToken: text('lease_token').notNull(),
  status: text('status').$type<'running' | 'completed' | 'failed'>().notNull(),
  summary: text('summary', { mode: 'json' }).$type<Record<string, number>>(),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  uniqueIndex('idx_scout_reconciliation_run_idempotency').on(table.idempotencyKey),
  uniqueIndex('idx_scout_reconciliation_active_scope')
    .on(table.scopeKey)
    .where(sql`${table.status} = 'running'`),
  index('idx_scout_reconciliation_run_scope_time').on(table.scopeKey, table.startedAt),
]);

export const scoutReconciliationEvaluations = sqliteTable('scout_reconciliation_evaluations', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull()
    .references(() => scoutReconciliationRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  candidateAction: text('candidate_action')
    .$type<'auto-complete' | 'suggest-complete' | 'escalate' | 'no-change'>()
    .notNull(),
  action: text('action')
    .$type<'auto-complete' | 'suggest-complete' | 'escalate' | 'no-change'>()
    .notNull(),
  confidence: real('confidence').notNull(),
  evidenceHash: text('evidence_hash').notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<ReconciliationEvidenceSummary>().notNull(),
  policyDecision: text('policy_decision')
    .$type<'allow' | 'require-confirmation' | 'deny' | 'not-applicable'>()
    .notNull(),
  policyReason: text('policy_reason').notNull(),
  payloadHash: text('payload_hash').notNull(),
  applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
  appliedResult: text('applied_result', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_scout_reconciliation_evaluation_run_task').on(table.runId, table.taskId),
  index('idx_scout_reconciliation_evaluation_task_time').on(table.taskId, table.createdAt),
  index('idx_scout_reconciliation_evaluation_action_time').on(table.action, table.createdAt),
]);

export const scoutReconciliationSuggestions = sqliteTable('scout_reconciliation_suggestions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  runId: text('run_id').notNull()
    .references(() => scoutReconciliationRuns.id, { onDelete: 'cascade' }),
  evaluationId: text('evaluation_id').notNull()
    .references(() => scoutReconciliationEvaluations.id, { onDelete: 'cascade' }),
  action: text('action').$type<'suggest-complete' | 'escalate'>().notNull(),
  status: text('status').$type<'pending' | 'accepted' | 'dismissed' | 'superseded'>().notNull(),
  confidence: real('confidence').notNull(),
  evidenceHash: text('evidence_hash').notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<ReconciliationEvidenceSummary>().notNull(),
  policyDecision: text('policy_decision').notNull(),
  policyReason: text('policy_reason').notNull(),
  payloadHash: text('payload_hash').notNull(),
  proposedEffect: text('proposed_effect', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  actedAt: text('acted_at'),
  actedBy: text('acted_by'),
}, (table) => [
  uniqueIndex('idx_scout_reconciliation_pending_task')
    .on(table.taskId)
    .where(sql`${table.status} = 'pending'`),
  index('idx_scout_reconciliation_suggestion_status_time').on(table.status, table.createdAt),
  index('idx_scout_reconciliation_suggestion_evidence').on(table.taskId, table.evidenceHash),
]);

export const scoutReconciliationTaskState = sqliteTable('scout_reconciliation_task_state', {
  taskId: text('task_id').primaryKey(),
  neverAutoComplete: integer('never_auto_complete', { mode: 'boolean' }).notNull().default(false),
  reason: text('reason').notNull(),
  sourceRunId: text('source_run_id'),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});
