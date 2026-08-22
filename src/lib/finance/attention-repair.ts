import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import logger from '@/lib/logger';
import {
  financeAttentionSourceId,
  financeAttentionTaskId,
} from './attention-routing';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';

export const FINANCE_ATTENTION_REPAIR_REASON = 'attribution_not_configured';
export const FINANCE_ATTENTION_REPAIR_CONFIRMATION =
  'repair-attribution-not-configured-projections';
export const FINANCE_ATTENTION_REPAIR_WINDOW_START = '2026-08-11T00:00:00.000Z';
export const FINANCE_ATTENTION_REPAIR_CUTOVER = '2026-08-13T00:00:00.000Z';
const MAX_REPAIR_SCOPE = 10_000;

type RepairMode = 'dry-run' | 'apply';

interface ConnectorRow {
  enabled: number;
  type: string;
}

interface ExceptionRow {
  id: string;
  status: string;
  reviewState: string;
}

interface NotificationRow {
  id: string;
  state: string;
  disposition: string;
  sourceState: string;
  sourceResolvedAt: string | null;
  isActionable: number;
  primaryActionId: string | null;
  autoResolveReason: string | null;
  metadata: string;
}

interface ActionRow {
  id: string;
  executionState: string;
}

interface DeliveryRow {
  id: string;
  status: string;
  leaseExpiresAt: string | null;
}

interface TaskRow {
  id: string;
  status: string;
  localDisposition: string;
  completedAt: string | null;
  metadata: string;
}

interface MyDayRow {
  id: string;
}

interface RepairTarget {
  exception: ExceptionRow;
  sourceId: string;
  notification: NotificationRow | null;
  actions: ActionRow[];
  deliveries: DeliveryRow[];
  task: TaskRow | null;
  myDayItems: MyDayRow[];
}

export interface FinanceAttentionRepairCounts {
  occurrences: number;
  notifications: number;
  connectorActions: number;
  pendingDeliveries: number;
  tasks: number;
  myDayItems: number;
}

interface AuditRow {
  id: string;
  mode: RepairMode;
  actorType: FinanceActorType;
  idempotencyKey: string;
  dryRunId: string | null;
  targetDigest: string;
  occurrenceCount: number;
  notificationCount: number;
  actionCount: number;
  deliveryCount: number;
  taskCount: number;
  myDayCount: number;
  createdAt: string;
  completedAt: string;
}

export interface FinanceAttentionRepairResult {
  runId: string;
  mode: RepairMode;
  connectorId: string;
  connectorEnabled: boolean;
  reasonCode: typeof FINANCE_ATTENTION_REPAIR_REASON;
  targetDigest: string;
  counts: FinanceAttentionRepairCounts;
  dryRunId: string | null;
  applied: boolean;
  replayed: boolean;
  completedAt: string;
}

export class FinanceAttentionRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FinanceAttentionRepairError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function repairedMetadata(value: string, repairedAt: string, runId: string): string {
  const metadata = parseMetadata(value);
  const attention = record(metadata.financeAttention);
  metadata.financeAttention = {
    ...attention,
    route: 'statusOnly',
    decisionAt: repairedAt,
    freshness: 'fresh',
    repair: {
      contractVersion: '1.0',
      reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
      runId,
      repairedAt,
    },
  };
  return JSON.stringify(metadata);
}

function countsFor(targets: RepairTarget[]): FinanceAttentionRepairCounts {
  return {
    occurrences: targets.length,
    notifications: targets.filter((target) => target.notification).length,
    connectorActions: targets.reduce((sum, target) => sum + target.actions.length, 0),
    pendingDeliveries: targets.reduce((sum, target) => sum + target.deliveries.length, 0),
    tasks: targets.filter((target) => target.task).length,
    myDayItems: targets.reduce((sum, target) => sum + target.myDayItems.length, 0),
  };
}

function digestTargets(targets: RepairTarget[]): string {
  const evidence = targets.map((target) => ({
    exception: [
      target.exception.id,
      target.exception.status,
      target.exception.reviewState,
    ],
    sourceId: target.sourceId,
    notification: target.notification
      ? [
          target.notification.id,
          target.notification.state,
          target.notification.disposition,
          target.notification.sourceState,
          target.notification.isActionable,
          target.notification.primaryActionId,
          target.notification.autoResolveReason,
        ]
      : null,
    actions: target.actions.map((action) => [action.id, action.executionState]),
    deliveries: target.deliveries.map((delivery) => [
      delivery.id,
      delivery.status,
      delivery.leaseExpiresAt,
    ]),
    task: target.task
      ? [
          target.task.id,
          target.task.status,
          target.task.localDisposition,
          target.task.completedAt,
        ]
      : null,
    myDayItems: target.myDayItems.map((item) => item.id),
  }));
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function loadConnector(connectorId: string): ConnectorRow {
  const connector = sqlite.prepare(`
    SELECT type, enabled
    FROM connector_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(connectorId) as ConnectorRow | undefined;
  if (!connector) {
    throw new FinanceAttentionRepairError(
      'finance_connector_not_found',
      'Finance connector not found',
      404,
    );
  }
  if (connector.type !== 'finance-manager') {
    throw new FinanceAttentionRepairError(
      'invalid_finance_connector_type',
      'Connector is not a finance-manager connector',
      409,
    );
  }
  return connector;
}

function loadTargets(connectorId: string): RepairTarget[] {
  const exceptions = sqlite.prepare(`
    SELECT id, status, review_state AS reviewState
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND reason_code = ?
      AND first_observed_at >= ? AND last_observed_at < ?
    ORDER BY id
    LIMIT ?
  `).all(
    connectorId,
    FINANCE_ATTENTION_REPAIR_REASON,
    FINANCE_ATTENTION_REPAIR_WINDOW_START,
    FINANCE_ATTENTION_REPAIR_CUTOVER,
    MAX_REPAIR_SCOPE + 1,
  ) as ExceptionRow[];
  if (exceptions.length > MAX_REPAIR_SCOPE) {
    throw new FinanceAttentionRepairError(
      'repair_scope_too_large',
      `Repair scope exceeds the ${MAX_REPAIR_SCOPE}-occurrence safety bound`,
      409,
    );
  }

  const notificationStatement = sqlite.prepare(`
    SELECT id, state, disposition, source_state AS sourceState,
           source_resolved_at AS sourceResolvedAt,
           is_actionable AS isActionable, primary_action_id AS primaryActionId,
           auto_resolve_reason AS autoResolveReason, metadata
    FROM notifications
    WHERE source_id = ?
      AND connector_type = 'finance-manager'
      AND connector_instance_id = ?
      AND level = 'heads_up'
      AND category = 'finance'
      AND template_key = 'finance-attribution-review'
      AND related_entity_type = 'finance-attribution-exception'
      AND related_entity_id = ?
      AND received_at >= ?
      AND received_at < ?
      AND json_extract(metadata, '$.notificationType') = 'financeAttributionReview'
      AND json_extract(metadata, '$.financeAttention.signalKind') = 'attributionReviewRequired'
  `);
  const actionStatement = sqlite.prepare(`
    SELECT id, execution_state AS executionState
    FROM notification_actions
    WHERE notification_id = ? AND created_by = 'connector'
    ORDER BY id
  `);
  const taskStatement = sqlite.prepare(`
    SELECT id, status, local_disposition AS localDisposition,
           completed_at AS completedAt, metadata
    FROM tasks
    WHERE id = ? AND source_id = ?
      AND connector_type = 'mission-control'
      AND connector_instance_id = 'mission-control'
  `);
  const deliveryStatement = sqlite.prepare(`
    SELECT id, status, lease_expires_at AS leaseExpiresAt
    FROM notification_delivery_events
    WHERE notification_id = ? AND status IN ('pending', 'sending')
    ORDER BY id
  `);
  const myDayStatement = sqlite.prepare(`
    SELECT id FROM my_day_items WHERE task_id = ? ORDER BY id
  `);

  const targets: RepairTarget[] = [];
  for (const exception of exceptions) {
    const signal = {
      connectorId,
      signalKind: 'attributionReviewRequired' as const,
      sourceRef: exception.id,
    };
    const sourceId = financeAttentionSourceId(signal);
    const rawNotification = notificationStatement.get(
      sourceId,
      connectorId,
      exception.id,
      FINANCE_ATTENTION_REPAIR_WINDOW_START,
      FINANCE_ATTENTION_REPAIR_CUTOVER,
    ) as NotificationRow | undefined;
    const actions = rawNotification
      ? actionStatement.all(rawNotification.id) as ActionRow[]
      : [];
    const deliveries = rawNotification
      ? deliveryStatement.all(rawNotification.id) as DeliveryRow[]
      : [];
    const rawTask = taskStatement.get(
      financeAttentionTaskId(signal),
      sourceId,
    ) as TaskRow | undefined;
    const taskAttention = rawTask ? record(parseMetadata(rawTask.metadata).financeAttention) : {};
    const task = rawTask
      && taskAttention.connectorRef === connectorId
      && taskAttention.sourceRef === exception.id
      && taskAttention.signalKind === 'attributionReviewRequired'
      ? rawTask
      : null;
    const myDayItems = task
      ? myDayStatement.all(task.id) as MyDayRow[]
      : [];

    const notificationNeedsRepair = Boolean(rawNotification && (
      rawNotification.sourceState !== 'resolved'
      || rawNotification.isActionable !== 0
      || rawNotification.primaryActionId !== null
      || rawNotification.autoResolveReason !== 'status_only'
      || actions.length > 0
      || deliveries.length > 0
    ));
    const taskNeedsRepair = Boolean(task && (
      task.status !== 'cancelled'
      || taskAttention.route !== 'statusOnly'
      || myDayItems.length > 0
    ));
    if (!notificationNeedsRepair && !taskNeedsRepair) continue;
    targets.push({
      exception,
      sourceId,
      notification: notificationNeedsRepair ? rawNotification! : null,
      actions: notificationNeedsRepair ? actions : [],
      deliveries: notificationNeedsRepair ? deliveries : [],
      task: taskNeedsRepair ? task : null,
      myDayItems: taskNeedsRepair ? myDayItems : [],
    });
  }
  return targets;
}

function auditResult(
  connectorId: string,
  connector: ConnectorRow,
  audit: AuditRow,
  replayed: boolean,
): FinanceAttentionRepairResult {
  return {
    runId: audit.id,
    mode: audit.mode,
    connectorId,
    connectorEnabled: connector.enabled === 1,
    reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
    targetDigest: audit.targetDigest,
    counts: {
      occurrences: audit.occurrenceCount,
      notifications: audit.notificationCount,
      connectorActions: audit.actionCount,
      pendingDeliveries: audit.deliveryCount,
      tasks: audit.taskCount,
      myDayItems: audit.myDayCount,
    },
    dryRunId: audit.dryRunId,
    applied: audit.mode === 'apply',
    replayed,
    completedAt: audit.completedAt,
  };
}

function findAudit(connectorId: string, idempotencyKey: string): AuditRow | undefined {
  return sqlite.prepare(`
    SELECT id, mode, actor_type AS actorType, idempotency_key AS idempotencyKey,
           dry_run_id AS dryRunId, target_digest AS targetDigest,
           occurrence_count AS occurrenceCount,
           notification_count AS notificationCount, action_count AS actionCount,
           delivery_count AS deliveryCount, task_count AS taskCount,
           my_day_count AS myDayCount,
           created_at AS createdAt, completed_at AS completedAt
    FROM finance_attention_repair_audit
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as AuditRow | undefined;
}

function insertAudit(input: {
  id: string;
  connectorId: string;
  mode: RepairMode;
  actorType: FinanceActorType;
  idempotencyKey: string;
  dryRunId: string | null;
  targetDigest: string;
  counts: FinanceAttentionRepairCounts;
  now: string;
}): void {
  sqlite.prepare(`
    INSERT INTO finance_attention_repair_audit (
      id, connector_id, mode, actor_type, idempotency_key, dry_run_id,
      reason_code, target_digest, occurrence_count, notification_count,
      action_count, delivery_count, task_count, my_day_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.connectorId,
    input.mode,
    input.actorType,
    input.idempotencyKey,
    input.dryRunId,
    FINANCE_ATTENTION_REPAIR_REASON,
    input.targetDigest,
    input.counts.occurrences,
    input.counts.notifications,
    input.counts.connectorActions,
    input.counts.pendingDeliveries,
    input.counts.tasks,
    input.counts.myDayItems,
    input.now,
    input.now,
  );
}

function assertNoInFlightDeliveries(targets: RepairTarget[]): void {
  if (targets.some((target) => (
    target.deliveries.some((delivery) => delivery.status === 'sending')
  ))) {
    throw new FinanceAttentionRepairError(
      'repair_delivery_in_flight',
      'A targeted push delivery is currently in flight; retry after delivery workers drain',
      409,
    );
  }
}

function applyTargets(targets: RepairTarget[], now: string, runId: string): void {
  const updateNotification = sqlite.prepare(`
    UPDATE notifications
    SET state = ?, source_state = 'resolved',
        source_resolved_at = COALESCE(source_resolved_at, ?),
        last_source_synced_at = ?, auto_resolve_reason = 'status_only',
        is_actionable = 0, primary_action_id = NULL, metadata = ?
    WHERE id = ?
  `);
  const deleteAction = sqlite.prepare(`
    DELETE FROM notification_actions WHERE id = ? AND created_by = 'connector'
  `);
  const suppressDelivery = sqlite.prepare(`
    UPDATE notification_delivery_events
    SET status = 'suppressed',
        suppression_reason = 'finance_attention_projection_repair',
        next_attempt_at = NULL, lease_expires_at = NULL
    WHERE id = ? AND status IN ('pending', 'sending')
  `);
  const updateTask = sqlite.prepare(`
    UPDATE tasks
    SET status = 'cancelled', status_reason = 'not_planned',
        completed_at = COALESCE(completed_at, ?), updated_at = ?,
        last_synced_at = ?, metadata = ?
    WHERE id = ?
  `);
  const deleteMyDay = sqlite.prepare(`DELETE FROM my_day_items WHERE task_id = ?`);

  for (const target of targets) {
    if (target.notification) {
      const state = target.notification.disposition === 'dismissed'
        ? 'dismissed'
        : 'archived';
      updateNotification.run(
        state,
        now,
        now,
        repairedMetadata(target.notification.metadata, now, runId),
        target.notification.id,
      );
      for (const action of target.actions) deleteAction.run(action.id);
      for (const delivery of target.deliveries) suppressDelivery.run(delivery.id);
    }
    if (target.task) {
      updateTask.run(
        now,
        now,
        now,
        repairedMetadata(target.task.metadata, now, runId),
        target.task.id,
      );
      deleteMyDay.run(target.task.id);
    }
  }
}

export function repairAttributionNotConfiguredAttention(input: {
  connectorId: string;
  mode: RepairMode;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  dryRunId?: string;
  confirmation?: string;
  now?: Date;
}): FinanceAttentionRepairResult {
  const idempotencyKey = input.idempotencyKey?.trim() ?? '';
  if (idempotencyKey.length < 8 || idempotencyKey.length > 192) {
    throw new FinanceAttentionRepairError(
      'invalid_repair_idempotency_key',
      'A valid idempotency-key header is required',
      400,
    );
  }
  if (
    input.mode === 'apply'
    && input.confirmation !== FINANCE_ATTENTION_REPAIR_CONFIRMATION
  ) {
    throw new FinanceAttentionRepairError(
      'repair_confirmation_required',
      'Exact repair confirmation is required',
      400,
    );
  }

  try {
    return sqlite.transaction(() => {
      const connector = loadConnector(input.connectorId);
      const replay = findAudit(input.connectorId, idempotencyKey);
      if (replay) {
        if (replay.mode !== input.mode) {
          throw new FinanceAttentionRepairError(
            'repair_idempotency_conflict',
            'Idempotency key was already used for a different repair mode',
            409,
          );
        }
        return auditResult(input.connectorId, connector, replay, true);
      }

      const targets = loadTargets(input.connectorId);
      const targetDigest = digestTargets(targets);
      const counts = countsFor(targets);
      let dryRunId: string | null = null;
      if (input.mode === 'apply') {
        dryRunId = input.dryRunId?.trim() || null;
        const dryRun = dryRunId
          ? sqlite.prepare(`
              SELECT id, target_digest AS targetDigest
              FROM finance_attention_repair_audit
              WHERE id = ? AND connector_id = ? AND mode = 'dry-run'
            `).get(dryRunId, input.connectorId) as
              | { id: string; targetDigest: string }
              | undefined
          : undefined;
        if (!dryRun) {
          throw new FinanceAttentionRepairError(
            'repair_dry_run_not_found',
            'A completed dry-run for this connector is required',
            409,
          );
        }
        assertNoInFlightDeliveries(targets);
        if (dryRun.targetDigest !== targetDigest) {
          throw new FinanceAttentionRepairError(
            'repair_scope_changed',
            'Repair scope changed after dry-run; run a new dry-run',
            409,
          );
        }
      }

      const runId = randomUUID();
      const now = (input.now ?? new Date()).toISOString();
      if (input.mode === 'apply') applyTargets(targets, now, runId);
      insertAudit({
        id: runId,
        connectorId: input.connectorId,
        mode: input.mode,
        actorType: input.actorType,
        idempotencyKey,
        dryRunId,
        targetDigest,
        counts,
        now,
      });
      const result: FinanceAttentionRepairResult = {
        runId,
        mode: input.mode,
        connectorId: input.connectorId,
        connectorEnabled: connector.enabled === 1,
        reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
        targetDigest,
        counts,
        dryRunId,
        applied: input.mode === 'apply',
        replayed: false,
        completedAt: now,
      };
      return result;
    }).immediate();
  } catch (error) {
    if (error instanceof FinanceAttentionRepairError) throw error;
    logger.error(
      {
        err: error,
        code: 'finance_attention_repair_failed',
        connectorId: input.connectorId,
        mode: input.mode,
      },
      'Finance attention projection repair failed',
    );
    throw new FinanceAttentionRepairError(
      'finance_attention_repair_failed',
      'Finance attention projection repair failed',
      500,
    );
  }
}
