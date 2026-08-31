import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ConnectorNotificationCommand } from '@/db/persistence/connector-execution';
import {
  ingestPostgresConnectorNotificationInTransaction,
} from './connector-execution-repositories';
import type { InboundNotification } from '@/types';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import {
  compareFinanceAttentionMyDayCandidates,
  compareFinanceAttentionSignalsForRouting,
  financeAttentionAttributionSignal,
  FINANCE_ATTENTION_MAX_REPAIR_SCOPE,
  financeAttentionMetadata,
  financeAttentionMyDayCandidateRank,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  financeAttentionRepairedMetadata,
  financeAttentionNotificationInput,
  financeAttentionRecord,
  financeAttentionRequiresTaskPromotion,
  FINANCE_ATTENTION_SOURCE_BATCH_SIZE,
  FINANCE_ATTENTION_SOURCE_LOOKBACK_MS,
  financeAttentionSourceId,
  financeAttentionTaskId,
  FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID,
  FINANCE_ATTENTION_TASK_CONNECTOR_TYPE,
  financeAttentionValidTimestamp,
  financeAttentionWriteBackSignal,
  FINANCE_MY_DAY_DAILY_CAP,
  FINANCE_TASK_PROMOTION_DAILY_CAP,
  FinanceAttentionRepairError,
  resolveFinanceAttentionNotificationPresentation,
  selectFinanceAttentionRoute,
  type FinanceAttentionAttributionExceptionRow,
  type FinanceAttentionMyDayTaskCandidate,
  type FinanceAttentionRepairConnector,
  type FinanceAttentionRepairCounts,
  type FinanceAttentionRepairPersistence,
  type FinanceAttentionRepairResult,
  type FinanceAttentionRoutingOutcome,
  type FinanceAttentionRoutingPersistence,
  type FinanceAttentionRoutingResult,
  type FinanceAttentionSignal,
  type FinanceAttentionSourceCursor,
  type FinanceAttentionWriteBackRow,
} from '@/db/persistence/finance-attention';

/**
 * PostgreSQL equivalent of `sqlite-finance-attention-repositories.ts`. It
 * reuses every pure decision helper from the shared contract so route
 * ordering, daily caps, dedupe, and metadata shapes cannot drift from the
 * SQLite adapter; only table access differs. Finance-manager connector
 * execution is still rejected on PostgreSQL by the existing
 * `connector-execution-repositories.ts` gate, so this adapter is exercised
 * today only by tests and by whatever composition root later registers it.
 *
 * Notification creation reuses both the shared provider registry and the
 * generic PostgreSQL notification ingestion transaction primitive, including
 * its push-rule, channel-availability, dedupe, and outbox behavior.
 */

type Client = Pool | PoolClient;

interface PostgresRepairExceptionRow {
  id: string;
  status: string;
  reviewState: string;
}

interface PostgresRepairNotificationRow {
  id: string;
  state: string;
  disposition: string;
  sourceState: string;
  sourceResolvedAt: string | null;
  isActionable: boolean;
  primaryActionId: string | null;
  autoResolveReason: string | null;
  metadata: unknown;
}

interface PostgresRepairActionRow {
  id: string;
  executionState: string;
}

interface PostgresRepairDeliveryRow {
  id: string;
  status: string;
  leaseExpiresAt: string | null;
}

interface PostgresRepairTaskRow {
  id: string;
  status: string;
  localDisposition: string;
  completedAt: string | null;
  metadata: unknown;
}

interface PostgresRepairMyDayRow {
  id: string;
}

interface PostgresRepairTarget {
  exception: PostgresRepairExceptionRow;
  sourceId: string;
  notification: PostgresRepairNotificationRow | null;
  actions: PostgresRepairActionRow[];
  deliveries: PostgresRepairDeliveryRow[];
  task: PostgresRepairTaskRow | null;
  myDayItems: PostgresRepairMyDayRow[];
}

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function lockFinanceAttentionScope(
  client: PoolClient,
  connectorId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-attention:${connectorId}`],
  );
}

async function lockFinanceAttentionCapacity(client: PoolClient): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    ['finance-attention:global-capacity'],
  );
}

async function loadAttributionBatch(
  client: PoolClient,
  connectorId: string,
  since: string,
  cursor: FinanceAttentionSourceCursor | null,
): Promise<FinanceAttentionAttributionExceptionRow[]> {
  if (!cursor) {
    return query<FinanceAttentionAttributionExceptionRow>(client, `
      SELECT id, status, review_state AS "reviewState", reason_code AS "reasonCode",
             CASE WHEN retryable THEN 1 ELSE 0 END AS retryable,
             source_fingerprint AS "sourceFingerprint",
             policy_version AS "policyVersion", first_observed_at AS "firstObservedAt",
             last_observed_at AS "lastObservedAt", resolved_at AS "resolvedAt",
             updated_at AS "updatedAt"
      FROM finance_attribution_exceptions
      WHERE connector_id = $1 AND updated_at >= $2
      ORDER BY updated_at, id
      LIMIT $3
    `, [connectorId, since, FINANCE_ATTENTION_SOURCE_BATCH_SIZE]);
  }
  return query<FinanceAttentionAttributionExceptionRow>(client, `
    SELECT id, status, review_state AS "reviewState", reason_code AS "reasonCode",
           CASE WHEN retryable THEN 1 ELSE 0 END AS retryable,
           source_fingerprint AS "sourceFingerprint",
           policy_version AS "policyVersion", first_observed_at AS "firstObservedAt",
           last_observed_at AS "lastObservedAt", resolved_at AS "resolvedAt",
           updated_at AS "updatedAt"
    FROM finance_attribution_exceptions
    WHERE connector_id = $1 AND (updated_at, id) > ($2, $3)
    ORDER BY updated_at, id
    LIMIT $4
  `, [connectorId, cursor.updatedAt, cursor.id, FINANCE_ATTENTION_SOURCE_BATCH_SIZE]);
}

async function loadWriteBackBatch(
  client: PoolClient,
  connectorId: string,
  since: string,
  cursor: FinanceAttentionSourceCursor | null,
): Promise<FinanceAttentionWriteBackRow[]> {
  if (!cursor) {
    return query<FinanceAttentionWriteBackRow>(client, `
      SELECT id, status, attempt_count AS "attemptCount", created_at AS "createdAt",
             updated_at AS "updatedAt", completed_at AS "completedAt"
      FROM finance_mutation_audit
      WHERE connector_id = $1 AND updated_at >= $2
        AND status IN ('pending', 'processing', 'succeeded', 'failed')
      ORDER BY updated_at, id
      LIMIT $3
    `, [connectorId, since, FINANCE_ATTENTION_SOURCE_BATCH_SIZE]);
  }
  return query<FinanceAttentionWriteBackRow>(client, `
    SELECT id, status, attempt_count AS "attemptCount", created_at AS "createdAt",
           updated_at AS "updatedAt", completed_at AS "completedAt"
    FROM finance_mutation_audit
    WHERE connector_id = $1 AND (updated_at, id) > ($2, $3)
      AND status IN ('pending', 'processing', 'succeeded', 'failed')
    ORDER BY updated_at, id
    LIMIT $4
  `, [connectorId, cursor.updatedAt, cursor.id, FINANCE_ATTENTION_SOURCE_BATCH_SIZE]);
}

interface PgTaskRow {
  id: string;
  status: string;
  statusReason: string | null;
  localDisposition: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  completedAt: string | null;
  metadata: unknown;
}

interface PgNotificationRow {
  id: string;
  disposition: string;
  sourceResolvedAt: string | null;
  staleSince: string | null;
  metadata: unknown;
}

async function findTask(
  client: PoolClient,
  sourceId: string,
): Promise<PgTaskRow | undefined> {
  const rows = await query<PgTaskRow>(client, `
    SELECT id, status, status_reason AS "statusReason",
           local_disposition AS "localDisposition", priority, due_date AS "dueDate",
           created_at AS "createdAt", completed_at AS "completedAt", metadata
    FROM tasks
    WHERE source_id = $1 AND connector_instance_id = $2
  `, [sourceId, FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID]);
  return rows[0];
}

async function findNotification(
  client: PoolClient,
  sourceId: string,
): Promise<PgNotificationRow | undefined> {
  const rows = await query<PgNotificationRow>(client, `
    SELECT id, disposition, source_resolved_at AS "sourceResolvedAt",
           stale_since AS "staleSince", metadata
    FROM notifications
    WHERE source_id = $1
  `, [sourceId]);
  return rows[0];
}

function notificationSettleState(disposition: string): string {
  return disposition === 'dismissed'
    ? 'dismissed'
    : disposition === 'handled'
      ? 'archived'
      : 'resolved';
}

async function settleNotification(
  client: PoolClient,
  notification: PgNotificationRow | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
  taskId: string | null,
): Promise<boolean> {
  if (!notification) return false;
  const promoted = taskId !== null && signal.sourceLifecycle === 'open';
  const state = notificationSettleState(notification.disposition);
  const metadata = financeAttentionMetadata(
    signal,
    promoted ? 'task' : 'settled',
    decisionAt,
    notification.metadata,
  );
  const now = decisionAt.toISOString();
  await query(client, `
    UPDATE notifications
    SET state = $1, source_state = 'resolved',
        source_resolved_at = COALESCE(source_resolved_at, $2),
        last_source_activity_at = $3, last_source_activity_key = $4,
        last_source_synced_at = $5,
        auto_resolve_reason = $6, related_task_id = $7,
        is_actionable = false, primary_action_id = NULL, metadata = $8::jsonb
    WHERE id = $9
  `, [
    state,
    now,
    signal.sourceAsOf,
    signal.activityKey,
    now,
    signal.settlementReason ?? (taskId ? 'promoted_to_task' : 'condition_cleared'),
    taskId,
    JSON.stringify(metadata),
    notification.id,
  ]);
  await query(client, `
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [notification.id]);
  return true;
}

async function settleTask(
  client: PoolClient,
  task: PgTaskRow | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): Promise<boolean> {
  if (!task) return false;
  const superseded = signal.sourceLifecycle === 'superseded';
  const now = decisionAt.toISOString();
  const metadata = financeAttentionMetadata(signal, 'settled', decisionAt, task.metadata);
  await query(client, `
    UPDATE tasks
    SET status = $1, status_reason = $2,
        completed_at = COALESCE(completed_at, $3), updated_at = $4,
        last_synced_at = $5, metadata = $6::jsonb
    WHERE id = $7
  `, [
    superseded ? 'cancelled' : 'done',
    superseded ? 'not_planned' : 'completed',
    now,
    now,
    now,
    JSON.stringify(metadata),
    task.id,
  ]);
  await query(client, `DELETE FROM my_day_items WHERE task_id = $1`, [task.id]);
  return true;
}

async function preserveStale(
  client: PoolClient,
  notification: PgNotificationRow | undefined,
  task: PgTaskRow | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): Promise<void> {
  const now = decisionAt.toISOString();
  if (notification) {
    const state = notificationSettleState(notification.disposition);
    await query(client, `
      UPDATE notifications
      SET state = $1, source_state = 'resolved',
          source_resolved_at = COALESCE(source_resolved_at, $2),
          auto_resolve_reason = 'source_stale',
          stale_since = COALESCE(stale_since, $3),
          last_source_synced_at = $4,
          is_actionable = false, primary_action_id = NULL, metadata = $5::jsonb
      WHERE id = $6
    `, [
      state,
      now,
      now,
      now,
      JSON.stringify(financeAttentionMetadata(signal, 'stale', decisionAt, notification.metadata)),
      notification.id,
    ]);
    await query(client, `
      DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
    `, [notification.id]);
  }
  if (task) {
    await query(client, `
      UPDATE tasks SET last_synced_at = $1, metadata = $2::jsonb WHERE id = $3
    `, [
      now,
      JSON.stringify(financeAttentionMetadata(signal, 'stale', decisionAt, task.metadata)),
      task.id,
    ]);
  }
}

async function preserveStatusOnly(
  client: PoolClient,
  notification: PgNotificationRow | undefined,
  task: PgTaskRow | undefined,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): Promise<void> {
  const now = decisionAt.toISOString();
  if (notification) {
    const state = notification.disposition === 'dismissed' ? 'dismissed' : 'archived';
    await query(client, `
      UPDATE notifications
      SET state = $1, source_state = 'resolved',
          source_resolved_at = COALESCE(source_resolved_at, $2),
          auto_resolve_reason = 'status_only',
          last_source_activity_at = $3, last_source_activity_key = $4,
          last_source_synced_at = $5,
          is_actionable = false, primary_action_id = NULL, metadata = $6::jsonb
      WHERE id = $7
    `, [
      state,
      now,
      signal.sourceAsOf,
      signal.activityKey,
      now,
      JSON.stringify(financeAttentionMetadata(signal, 'statusOnly', decisionAt, notification.metadata)),
      notification.id,
    ]);
    await query(client, `
      DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
    `, [notification.id]);
  }
  if (task) {
    await query(client, `
      UPDATE tasks
      SET status = 'cancelled', status_reason = 'not_planned',
          completed_at = COALESCE(completed_at, $1), updated_at = $2,
          last_synced_at = $3, metadata = $4::jsonb
      WHERE id = $5
    `, [
      now,
      now,
      now,
      JSON.stringify(financeAttentionMetadata(signal, 'statusOnly', decisionAt, task.metadata)),
      task.id,
    ]);
    await query(client, `DELETE FROM my_day_items WHERE task_id = $1`, [task.id]);
  }
}

async function createOrUpdateTask(
  client: PoolClient,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): Promise<{ task: PgTaskRow; created: boolean; promoted: boolean }> {
  const sourceId = financeAttentionSourceId(signal);
  const existing = await findTask(client, sourceId);
  const now = decisionAt.toISOString();
  if (existing) {
    const wasCompleted = existing.status === 'done' || existing.status === 'cancelled';
    const previousAttention = financeAttentionRecord(
      financeAttentionRecord(existing.metadata).financeAttention,
    );
    const resurface = wasCompleted
      && (
        previousAttention.route === 'settled'
        || previousAttention.route === 'statusOnly'
        || previousAttention.sourceLifecycle !== 'open'
      );
    const metadata = financeAttentionMetadata(signal, 'task', decisionAt, existing.metadata);
    if (wasCompleted && !resurface) {
      metadata.verificationPending = true;
    } else {
      delete metadata.verificationPending;
      if (resurface) {
        financeAttentionRecord(metadata.financeAttention).promotedAt = now;
      }
    }
    if (resurface) {
      await query(client, `
        UPDATE tasks
        SET status = 'todo', status_reason = NULL, completed_at = NULL,
            local_disposition = 'active',
            last_synced_at = $1, updated_at = $2, metadata = $3::jsonb
        WHERE id = $4
      `, [now, now, JSON.stringify(metadata), existing.id]);
    } else {
      await query(client, `
        UPDATE tasks SET last_synced_at = $1, updated_at = $2, metadata = $3::jsonb WHERE id = $4
      `, [now, now, JSON.stringify(metadata), existing.id]);
    }
    return { task: (await findTask(client, sourceId))!, created: false, promoted: resurface };
  }
  const metadata = financeAttentionMetadata(signal, 'task', decisionAt);
  financeAttentionRecord(metadata.financeAttention).promotedAt = now;
  const id = financeAttentionTaskId(signal);
  const inserted = await query(client, `
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, local_disposition, priority, created_at, updated_at, last_synced_at,
      source_list_id, source_list_name, metadata, sync_status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, 'todo', 'active', $7, $8, $9, $10,
      'local', 'Local', $11::jsonb, 'synced'
    )
    ON CONFLICT (source_id, connector_instance_id) DO NOTHING
    RETURNING id
  `, [
    id,
    sourceId,
    FINANCE_ATTENTION_TASK_CONNECTOR_TYPE,
    FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID,
    signal.signalKind === 'writeBackFailed'
      ? 'Resolve a failed finance write-back'
      : 'Review a finance attribution exception',
    signal.signalKind === 'writeBackFailed'
      ? 'A confirmed Finance change could not be verified. Review it in Finance.'
      : 'An unresolved attribution decision requires review in Finance.',
    signal.signalKind === 'writeBackFailed' ? 'high' : 'medium',
    now,
    now,
    now,
    JSON.stringify(metadata),
  ]);
  return {
    task: (await findTask(client, sourceId))!,
    created: inserted.length > 0,
    promoted: inserted.length > 0,
  };
}

async function promotionCountForDay(client: PoolClient, decisionAt: Date): Promise<number> {
  const date = formatDateInLocalTimezone(decisionAt);
  const rows = await query<{ createdAt: string; metadata: unknown }>(client, `
    SELECT created_at AS "createdAt", metadata
    FROM tasks
    WHERE source_id LIKE 'finance-attention:%'
  `);
  return rows.filter((task) => {
    const attention = financeAttentionRecord(financeAttentionRecord(task.metadata).financeAttention);
    const promotedAt = typeof attention.promotedAt === 'string' ? attention.promotedAt : task.createdAt;
    return financeAttentionValidTimestamp(promotedAt) !== null
      && formatDateInLocalTimezone(new Date(promotedAt)) === date;
  }).length;
}

interface PgFinanceTaskRow {
  id: string;
  status: string;
  localDisposition: string;
  metadata: unknown;
  dueDate: string | null;
  priority: string;
  createdAt: string;
}

interface PgMyDayItemRow {
  id: string;
  taskId: string;
  isAutoIncluded: boolean;
  order: number;
}

async function rebuildFinanceMyDay(
  client: PoolClient,
  decisionAt: Date,
): Promise<{ autoIncluded: number; deferred: number }> {
  const date = formatDateInLocalTimezone(decisionAt);
  const financeTasks = await query<PgFinanceTaskRow>(client, `
    SELECT id, status, local_disposition AS "localDisposition", metadata,
           due_date AS "dueDate", priority, created_at AS "createdAt"
    FROM tasks
    WHERE source_id LIKE 'finance-attention:%'
  `);
  const financeTaskIds = new Set(financeTasks.map((task) => task.id));
  const dayItems = await query<PgMyDayItemRow>(client, `
    SELECT id, task_id AS "taskId", is_auto_included AS "isAutoIncluded", "order"
    FROM my_day_items
    WHERE date = $1
  `, [date]);

  for (const item of dayItems) {
    if (item.isAutoIncluded && financeTaskIds.has(item.taskId)) {
      await query(client, `DELETE FROM my_day_items WHERE id = $1`, [item.id]);
    }
  }

  const manualTaskIds = new Set(
    dayItems.filter((item) => !item.isAutoIncluded).map((item) => item.taskId),
  );
  const excludedRows = await query<{ taskId: string }>(client, `
    SELECT task_id AS "taskId" FROM my_day_exclusions WHERE date = $1
  `, [date]);
  const excludedTaskIds = new Set(excludedRows.map((row) => row.taskId));

  const candidates = financeTasks.flatMap((task) => {
    if (manualTaskIds.has(task.id) || excludedTaskIds.has(task.id)) return [];
    const candidate: FinanceAttentionMyDayTaskCandidate = {
      id: task.id,
      status: task.status,
      localDisposition: task.localDisposition,
      metadata: task.metadata,
      dueDate: task.dueDate,
      priority: task.priority,
      createdAt: task.createdAt,
    };
    const rank = financeAttentionMyDayCandidateRank(candidate, date);
    return rank ? [{ task, policyRank: rank.policyRank, conditionSince: rank.conditionSince }] : [];
  }).sort(compareFinanceAttentionMyDayCandidates);

  const selected = candidates.slice(0, FINANCE_MY_DAY_DAILY_CAP);
  const maxOrder = dayItems
    .filter((item) => !item.isAutoIncluded || !financeTaskIds.has(item.taskId))
    .reduce((maximum, item) => Math.max(maximum, item.order), 0);
  for (const [index, { task }] of selected.entries()) {
    const digest = createHash('sha256').update(`${task.id}\0${date}`).digest('hex').slice(0, 24);
    await query(client, `
      INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
      VALUES ($1, $2, $3, $4, true, $5)
      ON CONFLICT (id) DO NOTHING
    `, [`finance-myday-${digest}`, task.id, date, decisionAt.toISOString(), maxOrder + index + 1]);
  }
  return {
    autoIncluded: selected.length,
    deferred: Math.max(0, candidates.length - selected.length),
  };
}

async function createPendingNotification(
  client: PoolClient,
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): Promise<{ created: boolean; notificationId: string; pendingDelivery: boolean }> {
  const input = financeAttentionNotificationInput(signal, decisionAt);
  const id = input.id!;
  const inbound: InboundNotification = {
    id,
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    body: input.body ?? undefined,
    level: input.level,
    category: input.category,
    isRead: input.readState === 'read',
    isActionable: input.isActionable,
    receivedAt: input.receivedAt,
    sourceState: input.sourceState,
    hubProjectIds: [],
    tags: [],
    metadata: input.metadata,
  };
  const resolved = resolveFinanceAttentionNotificationPresentation({
    notification: inbound,
    existingPresentation: input.presentation,
  });
  const command: ConnectorNotificationCommand = {
    input: {
      id,
      sourceId: input.sourceId,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title: resolved.title,
      body: resolved.body,
      level: input.level,
      category: input.category,
      templateKey: input.templateKey ?? null,
      readState: input.readState,
      sourceState: input.sourceState,
      sourceActivityAt: input.sourceActivityAt ?? null,
      sourceActivityKey: input.sourceActivityKey ?? null,
      reopenPolicy: input.reopenPolicy,
      occurrenceKey: input.occurrenceKey ?? 'initial',
      isActionable: resolved.isActionable,
      primaryActionId: resolved.primaryActionId,
      receivedAt: input.receivedAt,
      sortAt: input.sortAt,
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      navigationTarget: input.navigationTarget ?? null,
      metadata: input.metadata,
      presentation: resolved.presentation,
    },
    actions: resolved.actions,
  };
  const result = await ingestPostgresConnectorNotificationInTransaction(client, command);
  await syncFinanceAttentionNotificationPresentation(client, result.id, resolved);
  return {
    created: result.created,
    notificationId: result.id,
    pendingDelivery: result.pendingDelivery,
  };
}

async function syncFinanceAttentionNotificationPresentation(
  client: PoolClient,
  notificationId: string,
  resolved: ReturnType<typeof resolveFinanceAttentionNotificationPresentation>,
): Promise<void> {
  await query(client, `
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [notificationId]);
  for (const action of resolved.actions) {
    await query(client, `
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, icon, variant, is_primary,
        sort_order, payload, opens_external, requires_confirmation, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
    `, [
      action.id,
      action.notificationId,
      action.actionType,
      action.label,
      action.icon,
      action.variant,
      action.isPrimary,
      action.sortOrder,
      JSON.stringify(action.payload),
      action.opensExternal,
      action.requiresConfirmation,
      action.createdBy,
    ]);
  }
  await query(client, `
    UPDATE notifications
    SET title = $1, body = $2, presentation = $3::jsonb, is_actionable = $4,
        primary_action_id = $5
    WHERE id = $6
  `, [
    resolved.title,
    resolved.body,
    JSON.stringify(resolved.presentation),
    resolved.isActionable,
    resolved.primaryActionId,
    notificationId,
  ]);
}

export function createPostgresFinanceAttentionRoutingPersistence(
  pool: Pool,
): FinanceAttentionRoutingPersistence {
  return {
    async reconcile(input): Promise<FinanceAttentionRoutingOutcome> {
      const decisionAt = input.decisionAt;
      let hasPendingDelivery = false;
      const summary = await transaction(pool, async (client) => {
        await lockFinanceAttentionScope(client, input.connectorId);
        await lockFinanceAttentionCapacity(client);
        const result: FinanceAttentionRoutingResult = {
          evaluated: 0,
          notificationsCreated: 0,
          notificationsUpdated: 0,
          tasksCreated: 0,
          tasksUpdated: 0,
          tasksSettled: 0,
          taskPromoted: 0,
          autoIncluded: 0,
          deferred: 0,
          settled: 0,
          stalePreserved: 0,
          statusOnly: 0,
        };
        const signals: FinanceAttentionSignal[] = [];
        const since = new Date(
          decisionAt.getTime() - FINANCE_ATTENTION_SOURCE_LOOKBACK_MS,
        ).toISOString();
        let attributionCursor: FinanceAttentionSourceCursor | null = null;
        while (true) {
          const rows = await loadAttributionBatch(client, input.connectorId, since, attributionCursor);
          result.evaluated += rows.length;
          signals.push(...rows.map((row) => financeAttentionAttributionSignal(
            input.connectorId,
            row,
          )));
          if (rows.length < FINANCE_ATTENTION_SOURCE_BATCH_SIZE) break;
          const last = rows.at(-1)!;
          attributionCursor = { updatedAt: last.updatedAt, id: last.id };
        }
        let writeBackCursor: FinanceAttentionSourceCursor | null = null;
        while (true) {
          const rows = await loadWriteBackBatch(client, input.connectorId, since, writeBackCursor);
          result.evaluated += rows.length;
          signals.push(...rows.map((row) => financeAttentionWriteBackSignal(
            input.connectorId,
            row,
          )));
          if (rows.length < FINANCE_ATTENTION_SOURCE_BATCH_SIZE) break;
          const last = rows.at(-1)!;
          writeBackCursor = { updatedAt: last.updatedAt, id: last.id };
        }

        let promotionsRemaining = Math.max(
          0,
          FINANCE_TASK_PROMOTION_DAILY_CAP - await promotionCountForDay(client, decisionAt),
        );
        signals.sort((left, right) => (
          compareFinanceAttentionSignalsForRouting(left, right, decisionAt)
        ));

        for (const signal of signals) {
          const sourceId = financeAttentionSourceId(signal);
          const task = await findTask(client, sourceId);
          const decidedRoute = selectFinanceAttentionRoute(signal, decisionAt);
          if (decidedRoute === 'settled') {
            const notification = await findNotification(client, sourceId);
            result.settled++;
            if (await settleTask(client, task, signal, decisionAt)) result.tasksSettled++;
            if (await settleNotification(client, notification, signal, decisionAt, task?.id ?? null)) {
              result.notificationsUpdated++;
            }
            continue;
          }
          if (decidedRoute === 'stale') {
            const notification = await findNotification(client, sourceId);
            await preserveStale(client, notification, task, signal, decisionAt);
            result.stalePreserved++;
            continue;
          }
          if (decidedRoute === 'statusOnly') {
            const notification = await findNotification(client, sourceId);
            await preserveStatusOnly(client, notification, task, signal, decisionAt);
            result.statusOnly++;
            continue;
          }
          if (decidedRoute === 'actionableNotification' && !task) {
            const created = await createPendingNotification(client, signal, decisionAt);
            hasPendingDelivery ||= created.pendingDelivery;
            if (created.created) {
              result.notificationsCreated++;
            } else {
              result.notificationsUpdated++;
            }
            continue;
          }
          if (financeAttentionRequiresTaskPromotion(task, signal)) {
            if (promotionsRemaining === 0) {
              result.deferred++;
              continue;
            }
            promotionsRemaining--;
          }
          const routedTask = await createOrUpdateTask(client, signal, decisionAt);
          if (routedTask.created) result.tasksCreated++;
          else result.tasksUpdated++;
          if (routedTask.promoted) result.taskPromoted++;
          const notification = await findNotification(client, sourceId);
          await settleNotification(client, notification, signal, decisionAt, routedTask.task.id);
        }
        const myDay = await rebuildFinanceMyDay(client, decisionAt);
        result.autoIncluded = myDay.autoIncluded;
        result.deferred += myDay.deferred;
        return result;
      });
      return { summary, hasPendingDelivery };
    },
  };
}

function repairCountsFor(targets: PostgresRepairTarget[]): FinanceAttentionRepairCounts {
  return {
    occurrences: targets.length,
    notifications: targets.filter((target) => target.notification).length,
    connectorActions: targets.reduce((sum, target) => sum + target.actions.length, 0),
    pendingDeliveries: targets.reduce((sum, target) => sum + target.deliveries.length, 0),
    tasks: targets.filter((target) => target.task).length,
    myDayItems: targets.reduce((sum, target) => sum + target.myDayItems.length, 0),
  };
}

function repairDigestTargets(targets: PostgresRepairTarget[]): string {
  const evidence = targets.map((target) => ({
    exception: [target.exception.id, target.exception.status, target.exception.reviewState],
    sourceId: target.sourceId,
    notification: target.notification
      ? [
          target.notification.id,
          target.notification.state,
          target.notification.disposition,
          target.notification.sourceState,
          target.notification.isActionable ? 1 : 0,
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
      ? [target.task.id, target.task.status, target.task.localDisposition, target.task.completedAt]
      : null,
    myDayItems: target.myDayItems.map((item) => item.id),
  }));
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

async function loadRepairConnector(
  client: PoolClient,
  connectorId: string,
): Promise<FinanceAttentionRepairConnector> {
  const rows = await query<{ type: string; enabled: boolean }>(client, `
    SELECT type, enabled FROM connector_configs WHERE id = $1 AND deleted_at IS NULL
  `, [connectorId]);
  const connector = rows[0];
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

async function loadRepairTargets(
  client: PoolClient,
  connectorId: string,
): Promise<PostgresRepairTarget[]> {
  const exceptions = await query<PostgresRepairExceptionRow>(client, `
    SELECT id, status, review_state AS "reviewState"
    FROM finance_attribution_exceptions
    WHERE connector_id = $1 AND reason_code = $2
      AND first_observed_at >= $3 AND last_observed_at < $4
    ORDER BY id
    LIMIT $5
  `, [
    connectorId,
    FINANCE_ATTENTION_REPAIR_REASON,
    FINANCE_ATTENTION_REPAIR_WINDOW_START,
    FINANCE_ATTENTION_REPAIR_CUTOVER,
    FINANCE_ATTENTION_MAX_REPAIR_SCOPE + 1,
  ]);
  if (exceptions.length > FINANCE_ATTENTION_MAX_REPAIR_SCOPE) {
    throw new FinanceAttentionRepairError(
      'repair_scope_too_large',
      `Repair scope exceeds the ${FINANCE_ATTENTION_MAX_REPAIR_SCOPE}-occurrence safety bound`,
      409,
    );
  }

  const targets: PostgresRepairTarget[] = [];
  for (const exception of exceptions) {
    const signal = {
      connectorId,
      signalKind: 'attributionReviewRequired' as const,
      sourceRef: exception.id,
    };
    const sourceId = financeAttentionSourceId(signal);
    const notificationRows = await query<PostgresRepairNotificationRow>(client, `
      SELECT id, state, disposition, source_state AS "sourceState",
             source_resolved_at AS "sourceResolvedAt",
             is_actionable AS "isActionable", primary_action_id AS "primaryActionId",
             auto_resolve_reason AS "autoResolveReason", metadata
      FROM notifications
      WHERE source_id = $1
        AND connector_type = 'finance-manager'
        AND connector_instance_id = $2
        AND level = 'heads_up'
        AND category = 'finance'
        AND template_key = 'finance-attribution-review'
        AND related_entity_type = 'finance-attribution-exception'
        AND related_entity_id = $3
        AND received_at >= $4
        AND received_at < $5
        AND metadata->>'notificationType' = 'financeAttributionReview'
        AND metadata->'financeAttention'->>'signalKind' = 'attributionReviewRequired'
    `, [
      sourceId,
      connectorId,
      exception.id,
      FINANCE_ATTENTION_REPAIR_WINDOW_START,
      FINANCE_ATTENTION_REPAIR_CUTOVER,
    ]);
    const rawNotification = notificationRows[0];
    const actions = rawNotification
      ? await query<PostgresRepairActionRow>(client, `
          SELECT id, execution_state AS "executionState"
          FROM notification_actions
          WHERE notification_id = $1 AND created_by = 'connector'
          ORDER BY id
        `, [rawNotification.id])
      : [];
    const deliveries = rawNotification
      ? await query<PostgresRepairDeliveryRow>(client, `
          SELECT id, status, lease_expires_at AS "leaseExpiresAt"
          FROM notification_delivery_events
          WHERE notification_id = $1 AND status IN ('pending', 'sending')
          ORDER BY id
          FOR UPDATE
        `, [rawNotification.id])
      : [];
    const taskRows = await query<PostgresRepairTaskRow>(client, `
      SELECT id, status, local_disposition AS "localDisposition",
             completed_at AS "completedAt", metadata
      FROM tasks
      WHERE id = $1 AND source_id = $2
        AND connector_type = 'mission-control' AND connector_instance_id = 'mission-control'
    `, [financeAttentionTaskId(signal), sourceId]);
    const rawTask = taskRows[0];
    const taskAttention = rawTask
      ? financeAttentionRecord(financeAttentionRecord(rawTask.metadata).financeAttention)
      : {};
    const task = rawTask
      && taskAttention.connectorRef === connectorId
      && taskAttention.sourceRef === exception.id
      && taskAttention.signalKind === 'attributionReviewRequired'
      ? rawTask
      : null;
    const myDayItemsForTask = task
      ? await query<PostgresRepairMyDayRow>(client, `
          SELECT id FROM my_day_items WHERE task_id = $1 ORDER BY id
        `, [task.id])
      : [];

    const notificationNeedsRepair = Boolean(rawNotification && (
      rawNotification.sourceState !== 'resolved'
      || rawNotification.isActionable !== false
      || rawNotification.primaryActionId !== null
      || rawNotification.autoResolveReason !== 'status_only'
      || actions.length > 0
      || deliveries.length > 0
    ));
    const taskNeedsRepair = Boolean(task && (
      task.status !== 'cancelled'
      || taskAttention.route !== 'statusOnly'
      || myDayItemsForTask.length > 0
    ));
    if (!notificationNeedsRepair && !taskNeedsRepair) continue;
    targets.push({
      exception,
      sourceId,
      notification: notificationNeedsRepair ? rawNotification! : null,
      actions: notificationNeedsRepair ? actions : [],
      deliveries: notificationNeedsRepair ? deliveries : [],
      task: taskNeedsRepair ? task : null,
      myDayItems: taskNeedsRepair ? myDayItemsForTask : [],
    });
  }
  return targets;
}

interface PostgresRepairAuditRow {
  id: string;
  mode: 'dry-run' | 'apply';
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

async function findRepairAudit(
  client: PoolClient,
  connectorId: string,
  idempotencyKey: string,
): Promise<PostgresRepairAuditRow | undefined> {
  const rows = await query<PostgresRepairAuditRow>(client, `
    SELECT id, mode, dry_run_id AS "dryRunId", target_digest AS "targetDigest",
           occurrence_count AS "occurrenceCount", notification_count AS "notificationCount",
           action_count AS "actionCount", delivery_count AS "deliveryCount",
           task_count AS "taskCount", my_day_count AS "myDayCount",
           created_at AS "createdAt", completed_at AS "completedAt"
    FROM finance_attention_repair_audit
    WHERE connector_id = $1 AND idempotency_key = $2
  `, [connectorId, idempotencyKey]);
  return rows[0];
}

async function insertRepairAudit(
  client: PoolClient,
  input: {
    id: string;
    connectorId: string;
    mode: 'dry-run' | 'apply';
    actorType: string;
    idempotencyKey: string;
    dryRunId: string | null;
    targetDigest: string;
    counts: FinanceAttentionRepairCounts;
    now: string;
  },
): Promise<void> {
  await query(client, `
    INSERT INTO finance_attention_repair_audit (
      id, connector_id, mode, actor_type, idempotency_key, dry_run_id,
      reason_code, target_digest, occurrence_count, notification_count,
      action_count, delivery_count, task_count, my_day_count, created_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  `, [
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
  ]);
}

function assertNoInFlightDeliveries(targets: PostgresRepairTarget[]): void {
  if (targets.some((target) => target.deliveries.some((delivery) => delivery.status === 'sending'))) {
    throw new FinanceAttentionRepairError(
      'repair_delivery_in_flight',
      'A targeted push delivery is currently in flight; retry after delivery workers drain',
      409,
    );
  }
}

async function applyRepairTargets(
  client: PoolClient,
  targets: PostgresRepairTarget[],
  now: string,
  runId: string,
): Promise<void> {
  for (const target of targets) {
    if (target.notification) {
      const state = target.notification.disposition === 'dismissed' ? 'dismissed' : 'archived';
      const metadataJson = financeAttentionRepairedMetadata(
        JSON.stringify(financeAttentionRecord(target.notification.metadata)),
        now,
        runId,
      );
      await query(client, `
        UPDATE notifications
        SET state = $1, source_state = 'resolved',
            source_resolved_at = COALESCE(source_resolved_at, $2),
            last_source_synced_at = $3, auto_resolve_reason = 'status_only',
            is_actionable = false, primary_action_id = NULL, metadata = $4::jsonb
        WHERE id = $5
      `, [state, now, now, metadataJson, target.notification.id]);
      for (const action of target.actions) {
        await query(client, `
          DELETE FROM notification_actions WHERE id = $1 AND created_by = 'connector'
        `, [action.id]);
      }
      for (const delivery of target.deliveries) {
        await query(client, `
          UPDATE notification_delivery_events
          SET status = 'suppressed', suppression_reason = 'finance_attention_projection_repair',
              next_attempt_at = NULL, lease_expires_at = NULL
          WHERE id = $1 AND status = 'pending'
        `, [delivery.id]);
      }
    }
    if (target.task) {
      const metadataJson = financeAttentionRepairedMetadata(
        JSON.stringify(financeAttentionRecord(target.task.metadata)),
        now,
        runId,
      );
      await query(client, `
        UPDATE tasks
        SET status = 'cancelled', status_reason = 'not_planned',
            completed_at = COALESCE(completed_at, $1), updated_at = $2,
            last_synced_at = $3, metadata = $4::jsonb
        WHERE id = $5
      `, [now, now, now, metadataJson, target.task.id]);
      await query(client, `DELETE FROM my_day_items WHERE task_id = $1`, [target.task.id]);
    }
  }
}

export function createPostgresFinanceAttentionRepairPersistence(
  pool: Pool,
): FinanceAttentionRepairPersistence {
  return {
    async repair(input): Promise<FinanceAttentionRepairResult> {
      return transaction(pool, async (client) => {
        await lockFinanceAttentionScope(client, input.connectorId);
        await lockFinanceAttentionCapacity(client);
        const connector = await loadRepairConnector(client, input.connectorId);
        const replay = await findRepairAudit(client, input.connectorId, input.idempotencyKey);
        if (replay) {
          if (
            replay.mode !== input.mode
            || (input.mode === 'apply' && replay.dryRunId !== input.dryRunId)
          ) {
            throw new FinanceAttentionRepairError(
              'repair_idempotency_conflict',
              'Idempotency key was already used for a different repair request',
              409,
            );
          }
          return {
            runId: replay.id,
            mode: replay.mode,
            connectorId: input.connectorId,
            connectorEnabled: connector.enabled,
            reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
            targetDigest: replay.targetDigest,
            counts: {
              occurrences: replay.occurrenceCount,
              notifications: replay.notificationCount,
              connectorActions: replay.actionCount,
              pendingDeliveries: replay.deliveryCount,
              tasks: replay.taskCount,
              myDayItems: replay.myDayCount,
            },
            dryRunId: replay.dryRunId,
            applied: replay.mode === 'apply',
            replayed: true,
            completedAt: replay.completedAt,
          };
        }

        const targets = await loadRepairTargets(client, input.connectorId);
        const targetDigest = repairDigestTargets(targets);
        const counts = repairCountsFor(targets);
        let dryRunId: string | null = null;
        if (input.mode === 'apply') {
          dryRunId = input.dryRunId;
          const dryRunRows = dryRunId
            ? await query<{ id: string; targetDigest: string }>(client, `
                SELECT id, target_digest AS "targetDigest"
                FROM finance_attention_repair_audit
                WHERE id = $1 AND connector_id = $2 AND mode = 'dry-run'
              `, [dryRunId, input.connectorId])
            : [];
          const dryRun = dryRunRows[0];
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

        if (input.mode === 'apply') await applyRepairTargets(client, targets, input.now, input.runId);
        await insertRepairAudit(client, {
          id: input.runId,
          connectorId: input.connectorId,
          mode: input.mode,
          actorType: input.actorType,
          idempotencyKey: input.idempotencyKey,
          dryRunId,
          targetDigest,
          counts,
          now: input.now,
        });

        return {
          runId: input.runId,
          mode: input.mode,
          connectorId: input.connectorId,
          connectorEnabled: connector.enabled,
          reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
          targetDigest,
          counts,
          dryRunId,
          applied: input.mode === 'apply',
          replayed: false,
          completedAt: input.now,
        };
      });
    },
  };
}
