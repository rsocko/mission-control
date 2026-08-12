import db, { sqlite } from '@/db';
import { connectorConfigs } from '@/db/schema/connectors';
import { notifications } from '@/db/schema';
import { inArray, eq } from 'drizzle-orm';
import {
  connectorRegistry,
  registerDefaultConnectorFactories,
} from '@/lib/connectors';
import {
  ConnectorWritebackError,
  type NotificationWritebackAction,
} from '@/lib/connectors/notification-writeback-contract';
import logger from '@/lib/logger';
import type { ConnectorConfig } from '@/types';
import type { ConnectorCapabilities } from '@/types';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
export { MAX_NOTIFICATION_BULK_IDS, normalizeNotificationBulkIds } from './bulk';

const WRITEBACK_BATCH_SIZE = 50;
const WRITEBACK_LEASE_MS = 60_000;
const WRITEBACK_RETRY_BASE_MS = 5_000;
const WRITEBACK_MAX_RETRY_MS = 5 * 60_000;
const WRITEBACK_MIN_REQUEST_INTERVAL_MS = 100;
const WRITEBACK_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRACKED_SINGLE_JOB_CONNECTORS = 1_000;

type WritebackRow = {
  id: string;
  notificationId: string;
  connectorInstanceId: string;
  connectorType: string;
  sourceId: string;
  actionType: NotificationWritebackAction;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: string;
};

export type NotificationMutationAction =
  | NotificationWritebackAction
  | 'dismiss';

export interface NotificationMutationItemResult {
  id: string;
  localStatus: 'updated' | 'not_found';
  writebackStatus: 'pending' | 'not_required';
}

export interface NotificationMutationResult {
  updatedCount: number;
  queuedCount: number;
  results: NotificationMutationItemResult[];
}

type WritebackSourceRow = {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
};

let dispatcherPromise: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const singleJobConnectorIds = new Set<string>();

export async function enqueueNotificationDismissalWritebacks(
  notificationIds: string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;
  const rows = await db.select({
    id: notifications.id,
    sourceId: notifications.sourceId,
    connectorType: notifications.connectorType,
    connectorInstanceId: notifications.connectorInstanceId,
  })
    .from(notifications)
    .where(inArray(notifications.id, notificationIds));

  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    return insertWritebackRows(rows, now);
  });
  return transaction.immediate();
}

export function mutateNotificationsAndEnqueueWritebacks(
  notificationIds: string[],
  action: NotificationMutationAction,
  changedAt: string,
): NotificationMutationResult {
  if (notificationIds.length === 0) {
    return { updatedCount: 0, queuedCount: 0, results: [] };
  }
  const placeholders = notificationIds.map(() => '?').join(',');
  const transaction = sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT
        id,
        source_id AS sourceId,
        connector_type AS connectorType,
        connector_instance_id AS connectorInstanceId
      FROM notifications
      WHERE id IN (${placeholders})
    `).all(...notificationIds) as WritebackSourceRow[];
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const queuedIds = new Set<string>();
    let queuedCount = 0;
    if (action !== 'dismiss') {
      for (const row of rows) {
        if (
          row.connectorType !== 'github-issues'
        ) continue;
        const writeback = insertTypedWritebackRow(row, action, changedAt);
        queuedCount += writeback.queued;
        if (writeback.pending) queuedIds.add(row.id);
      }
    }

    const update = mutationUpdateSql(action, placeholders);
    const updateResult = sqlite.prepare(update.sql).run(
      ...update.parameters(changedAt),
      ...notificationIds,
    );
    for (const row of rows) refreshNotificationSyncState(row.id);
    return {
      updatedCount: updateResult.changes,
      queuedCount,
      results: notificationIds.map((id) => {
        const row = rowById.get(id);
        return {
          id,
          localStatus: row ? 'updated' as const : 'not_found' as const,
          writebackStatus: row && queuedIds.has(id)
            ? 'pending' as const
            : 'not_required' as const,
        };
      }),
    };
  });
  return transaction.immediate();
}

export function dismissNotificationsAndEnqueueWritebacks(
  notificationIds: string[],
  dismissedAt: string,
): { updatedCount: number; queuedCount: number } {
  if (notificationIds.length === 0) return { updatedCount: 0, queuedCount: 0 };
  const placeholders = notificationIds.map(() => '?').join(',');
  const transaction = sqlite.transaction(() => {
    const rows = sqlite.prepare(`
      SELECT
        id,
        source_id AS sourceId,
        connector_type AS connectorType,
        connector_instance_id AS connectorInstanceId
      FROM notifications
      WHERE id IN (${placeholders})
    `).all(...notificationIds) as WritebackSourceRow[];
    const queuedCount = insertWritebackRows(rows, dismissedAt);
    const updateResult = sqlite.prepare(`
      UPDATE notifications
      SET state = 'dismissed',
          read_state = 'read',
          disposition = 'dismissed',
          sync_state = CASE
            WHEN EXISTS (
              SELECT 1 FROM notification_writeback_jobs jobs
              WHERE jobs.notification_id = notifications.id AND jobs.status = 'failed'
            ) THEN 'failed'
            WHEN EXISTS (
              SELECT 1 FROM notification_writeback_jobs jobs
              WHERE jobs.notification_id = notifications.id AND jobs.status IN ('pending', 'sending')
            ) THEN 'pending'
            ELSE 'synced'
          END,
          read_at = COALESCE(read_at, ?),
          dismissed_at = ?
      WHERE id IN (${placeholders})
    `).run(dismissedAt, dismissedAt, ...notificationIds);
    return { updatedCount: updateResult.changes, queuedCount };
  });
  return transaction.immediate();
}

export function wakeNotificationWritebackDispatcher(): void {
  if (dispatcherPromise) return;
  dispatcherPromise = Promise.resolve()
    .then(dispatchNotificationWritebacks)
    .catch((error) => {
      logger.error({ err: error }, 'Notification writeback dispatcher failed');
    })
    .finally(() => {
      dispatcherPromise = null;
      scheduleNextWriteback();
    });
}

export async function dispatchNotificationWritebacks(): Promise<void> {
  while (true) {
    const jobs = claimNextConnectorBatch();
    if (jobs.length === 0) return;
    await processWritebackBatch(jobs);
  }
}

function normalizeWritebackSourceId(sourceId: string): string {
  const separator = sourceId.indexOf(':');
  const connectorSourceId = separator === -1 ? sourceId : sourceId.slice(separator + 1);
  return connectorSourceId.replace(/^docintel-/, '');
}

function insertWritebackRows(rows: WritebackSourceRow[], now: string): number {
  const insert = sqlite.prepare(`
    INSERT INTO notification_writeback_jobs (
      id, notification_id, connector_instance_id, connector_type, source_id,
      action_type, dedupe_key, status, attempt_count, max_attempts, next_attempt_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'mark_done', ?, 'pending', 0, 3, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      status = 'pending',
      attempt_count = 0,
      next_attempt_at = excluded.next_attempt_at,
      lease_expires_at = NULL,
      last_error = NULL,
      completed_at = NULL,
      updated_at = excluded.updated_at
    WHERE notification_writeback_jobs.status = 'failed'
  `);
  let queued = 0;
  for (const row of rows) {
    const result = insert.run(
      crypto.randomUUID(),
      row.id,
      row.connectorInstanceId,
      row.connectorType,
      normalizeWritebackSourceId(row.sourceId),
      `dismiss:${row.id}`,
      now,
      now,
      now,
    );
    queued += result.changes;
  }
  return queued;
}

function insertTypedWritebackRow(
  row: WritebackSourceRow,
  action: NotificationWritebackAction,
  now: string,
): { queued: number; pending: boolean } {
  const baseDedupeKey = `${action}:${row.id}:${now}`;
  const existing = sqlite.prepare(`
    SELECT jobs.status
    FROM notification_writeback_jobs jobs
    WHERE jobs.dedupe_key = ?
      AND NOT EXISTS (
        SELECT 1
        FROM notification_writeback_jobs newer
        WHERE newer.notification_id = jobs.notification_id
          AND newer.rowid > jobs.rowid
          AND newer.status <> 'superseded'
      )
  `).get(baseDedupeKey) as { status: string } | undefined;
  if (existing && ['pending', 'sending', 'succeeded'].includes(existing.status)) {
    return {
      queued: 0,
      pending: existing.status === 'pending' || existing.status === 'sending',
    };
  }
  const dedupeKey = sqlite.prepare(`
    SELECT 1 FROM notification_writeback_jobs WHERE dedupe_key = ?
  `).get(baseDedupeKey)
    ? `${baseDedupeKey}:${crypto.randomUUID()}`
    : baseDedupeKey;
  if (action === 'mute' || action === 'unmute') {
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET status = 'superseded',
          retryable = 0,
          completed_at = ?,
          updated_at = ?,
          last_error = 'Superseded by a newer notification action'
      WHERE notification_id = ?
        AND status IN ('pending', 'failed')
        AND action_type IN ('mute', 'unmute')
        AND action_type <> ?
    `).run(now, now, row.id, action);
  }
  const queued = sqlite.prepare(`
    INSERT INTO notification_writeback_jobs (
      id, notification_id, connector_instance_id, connector_type, source_id,
      action_type, dedupe_key, status, retryable, attempt_count, max_attempts,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 0, 5, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    crypto.randomUUID(),
    row.id,
    row.connectorInstanceId,
    row.connectorType,
    normalizeWritebackSourceId(row.sourceId),
    action,
    dedupeKey,
    now,
    now,
    now,
  ).changes;
  return { queued, pending: queued === 1 };
}

function mutationUpdateSql(
  action: NotificationMutationAction,
  placeholders: string,
): { sql: string; parameters: (changedAt: string) => string[] } {
  switch (action) {
    case 'mark_read':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'read'
              END
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt],
      };
    case 'mark_done':
      return {
        sql: `UPDATE notifications
          SET disposition = 'handled',
              handled_at = ?,
              archived_at = ?,
              handled_source_activity_at = last_source_activity_at,
              handled_source_activity_key = last_source_activity_key,
              state = CASE
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                ELSE 'archived'
              END
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
    case 'mute':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              disposition = 'dismissed',
              dismissed_at = ?,
              muted_at = ?,
              state = 'dismissed'
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt, changedAt, changedAt],
      };
    case 'unmute':
      return {
        sql: `UPDATE notifications
          SET disposition = 'inbox',
              dismissed_at = NULL,
              muted_at = NULL,
              state = CASE
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                WHEN read_state = 'unread' THEN 'unread'
                ELSE 'read'
              END
          WHERE id IN (${placeholders})`,
        parameters: () => [],
      };
    case 'dismiss':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              disposition = 'dismissed',
              dismissed_at = ?,
              state = 'dismissed'
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
  }
}

function claimNextConnectorBatch(): WritebackRow[] {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + WRITEBACK_LEASE_MS).toISOString();
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET status = 'pending', lease_expires_at = NULL, updated_at = ?
      WHERE status = 'sending' AND lease_expires_at <= ?
    `).run(nowIso, nowIso);

    const candidate = sqlite.prepare(`
      SELECT jobs.connector_instance_id AS connectorInstanceId
      FROM notification_writeback_jobs jobs
      INNER JOIN notifications notification
        ON notification.id = jobs.notification_id
        AND notification.connector_instance_id = jobs.connector_instance_id
        AND notification.connector_type = jobs.connector_type
      WHERE jobs.status = 'pending' AND jobs.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM notification_writeback_jobs earlier
          WHERE earlier.notification_id = jobs.notification_id
            AND earlier.rowid < jobs.rowid
            AND earlier.status IN ('pending', 'sending')
        )
      ORDER BY jobs.next_attempt_at, jobs.created_at
      LIMIT 1
    `).get(nowIso) as { connectorInstanceId: string } | undefined;
    if (!candidate) return [];

    const claimLimit = singleJobConnectorIds.has(candidate.connectorInstanceId)
      ? 1
      : WRITEBACK_BATCH_SIZE;
    const rows = sqlite.prepare(`
      SELECT
        jobs.id,
        jobs.notification_id AS notificationId,
        jobs.connector_instance_id AS connectorInstanceId,
        jobs.connector_type AS connectorType,
        jobs.source_id AS sourceId,
        jobs.action_type AS actionType,
        jobs.attempt_count AS attemptCount,
        jobs.max_attempts AS maxAttempts,
        jobs.lease_expires_at AS leaseExpiresAt
      FROM notification_writeback_jobs jobs
      INNER JOIN notifications notification
        ON notification.id = jobs.notification_id
        AND notification.connector_instance_id = jobs.connector_instance_id
        AND notification.connector_type = jobs.connector_type
      WHERE jobs.connector_instance_id = ?
        AND jobs.status = 'pending'
        AND jobs.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM notification_writeback_jobs earlier
          WHERE earlier.notification_id = jobs.notification_id
            AND earlier.rowid < jobs.rowid
            AND earlier.status IN ('pending', 'sending')
        )
      ORDER BY jobs.created_at
      LIMIT ?
    `).all(candidate.connectorInstanceId, nowIso, claimLimit) as WritebackRow[];
    if (rows.length === 0) return [];

    const placeholders = rows.map(() => '?').join(',');
    sqlite.prepare(`
      UPDATE notification_writeback_jobs
      SET status = 'sending',
          attempt_count = attempt_count + 1,
          lease_expires_at = ?,
          last_error = NULL,
          updated_at = ?
      WHERE id IN (${placeholders}) AND status = 'pending'
    `).run(leaseExpiresAt, nowIso, ...rows.map((row) => row.id));
    return rows.map((row) => ({
      ...row,
      attemptCount: row.attemptCount + 1,
      leaseExpiresAt,
    }));
  });
  return transaction.immediate();
}

async function processWritebackBatch(jobs: WritebackRow[]): Promise<void> {
  let connector: Awaited<ReturnType<typeof loadConnector>>;
  try {
    connector = await withWritebackTimeout(
      loadConnector(jobs[0]!.connectorInstanceId),
      'Connector initialization',
    );
  } catch (error) {
    failJobs(jobs, error);
    return;
  }
  jobs = renewJobLeases(jobs);
  if (jobs.length === 0) return;
  if (
    !connector?.writeNotificationAction
    && !connector?.dismissAlert
    && !connector?.dismissAlerts
  ) {
    failJobs(jobs, new ConnectorWritebackError(
      connector
        ? 'Connector does not support notification writeback'
        : 'Connector is unavailable or has been removed',
      false,
    ));
    return;
  }

  if (
    connector.dismissAlerts
    && jobs.every((job) => job.actionType === 'mark_done')
  ) {
    try {
      await withWritebackTimeout(
        connector.dismissAlerts(jobs.map((job) => job.sourceId)),
        'Notification dismissal batch',
      );
      completeJobs(jobs);
    } catch (error) {
      failJobs(jobs, error);
    }
    return;
  }

  rememberSingleJobConnector(jobs[0]!.connectorInstanceId);
  releaseUnattemptedJobs(jobs.slice(1));
  const job = jobs[0]!;
  try {
    if (connector.writeNotificationAction) {
      await withAbortableWritebackTimeout(
        (signal) => connector.writeNotificationAction!(job.sourceId, job.actionType, signal),
        `Notification ${job.actionType}`,
      );
    } else {
      await withWritebackTimeout(
        connector.dismissAlert!(job.sourceId),
        `Notification ${job.actionType}`,
      );
    }
    completeJobs([job]);
  } catch (error) {
    failJobs([job], error);
  }
  await new Promise((resolve) => setTimeout(resolve, WRITEBACK_MIN_REQUEST_INTERVAL_MS));
}

async function loadConnector(instanceId: string) {
  registerDefaultConnectorFactories();
  const registered = connectorRegistry.getConnector(instanceId);
  if (registered) return registered;

  const [config] = await db.select()
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, instanceId))
    .limit(1);
  if (!config || config.deletedAt) return null;

  const storedCapabilities = parseRecord(config.capabilities);
  const capabilities = {
    ...(CAPABILITY_DEFAULTS[config.type] ?? {}),
    ...storedCapabilities,
  } as ConnectorCapabilities;
  return connectorRegistry.createConnector({
    id: config.id,
    type: config.type,
    name: config.name,
    enabled: !!config.enabled,
    syncMode: (config.syncMode as ConnectorConfig['syncMode']) || 'poll',
    capabilities,
    settings: parseRecord(config.settings),
    credentials: parseRecord(config.credentials) as Record<string, string>,
    syncedLists: parseStringArray(config.syncedLists),
  });
}

function completeJobs(jobs: WritebackRow[]): void {
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    for (const job of jobs) {
      const completed = sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = 'succeeded',
            completed_at = ?,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(now, now, job.id, job.leaseExpiresAt);
      if (completed.changes === 1) {
        refreshNotificationSyncState(job.notificationId);
      }
    }
  });
  transaction.immediate();
}

function renewJobLeases(jobs: WritebackRow[]): WritebackRow[] {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + WRITEBACK_LEASE_MS).toISOString();
  const renewed: WritebackRow[] = [];
  const transaction = sqlite.transaction(() => {
    for (const job of jobs) {
      const result = sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(leaseExpiresAt, nowIso, job.id, job.leaseExpiresAt);
      if (result.changes === 1) {
        job.leaseExpiresAt = leaseExpiresAt;
        renewed.push(job);
      }
    }
  });
  transaction.immediate();
  return renewed;
}

function releaseUnattemptedJobs(jobs: WritebackRow[]): void {
  if (jobs.length === 0) return;
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    for (const job of jobs) {
      sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = 'pending',
            attempt_count = MAX(0, attempt_count - 1),
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(now, job.id, job.leaseExpiresAt);
    }
  });
  transaction.immediate();
}

function failJobs(jobs: WritebackRow[], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date();
  const retryable = !(error instanceof ConnectorWritebackError) || error.retryable;
  const providerRetryAt = error instanceof ConnectorWritebackError
    ? error.retryAt
    : undefined;
  const transaction = sqlite.transaction(() => {
    for (const job of jobs) {
      const hasNewerAction = (job.actionType === 'mute' || job.actionType === 'unmute')
        && sqlite.prepare(`
        SELECT 1
        FROM notification_writeback_jobs newer
        WHERE newer.notification_id = ?
          AND newer.rowid > (
            SELECT current.rowid
            FROM notification_writeback_jobs current
            WHERE current.id = ?
          )
          AND newer.status <> 'superseded'
          AND newer.action_type IN ('mute', 'unmute')
          AND newer.action_type <> ?
        LIMIT 1
      `).get(job.notificationId, job.id, job.actionType);
      if (hasNewerAction) {
        const superseded = sqlite.prepare(`
          UPDATE notification_writeback_jobs
          SET status = 'superseded',
              retryable = 0,
              lease_expires_at = NULL,
              last_error = 'Superseded by a newer notification action',
              completed_at = ?,
              updated_at = ?
          WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
        `).run(now.toISOString(), now.toISOString(), job.id, job.leaseExpiresAt);
        if (superseded.changes === 1) refreshNotificationSyncState(job.notificationId);
        continue;
      }
      const terminal = !retryable || job.attemptCount >= job.maxAttempts;
      const delay = Math.min(
        WRITEBACK_MAX_RETRY_MS,
        WRITEBACK_RETRY_BASE_MS * 2 ** Math.max(0, job.attemptCount - 1),
      );
      const nextAttemptAt = providerRetryAt && providerRetryAt > now
        ? providerRetryAt
        : new Date(now.getTime() + delay);
      const failed = sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = ?,
            retryable = ?,
            next_attempt_at = ?,
            lease_expires_at = NULL,
            last_error = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(
        terminal ? 'failed' : 'pending',
        retryable ? 1 : 0,
        terminal ? now.toISOString() : nextAttemptAt.toISOString(),
        message.slice(0, 1_000),
        terminal ? now.toISOString() : null,
        now.toISOString(),
        job.id,
        job.leaseExpiresAt,
      );
      if (failed.changes === 1) {
        refreshNotificationSyncState(job.notificationId);
      }
    }
  });
  transaction.immediate();
  logger.warn(
    { err: error, connectorId: jobs[0]?.connectorInstanceId, jobCount: jobs.length },
    'Notification writeback batch failed',
  );
}

function refreshNotificationSyncState(notificationId: string): void {
  sqlite.prepare(`
    UPDATE notifications
    SET sync_state = CASE
      WHEN EXISTS (
        SELECT 1 FROM notification_writeback_jobs jobs
        WHERE jobs.notification_id = notifications.id AND jobs.status = 'failed'
      ) THEN 'failed'
      WHEN EXISTS (
        SELECT 1 FROM notification_writeback_jobs jobs
        WHERE jobs.notification_id = notifications.id
          AND jobs.status IN ('pending', 'sending')
      ) THEN 'pending'
      ELSE 'synced'
    END
    WHERE id = ?
  `).run(notificationId);
}

function scheduleNextWriteback(): void {
  if (retryTimer) clearTimeout(retryTimer);
  const nextPending = sqlite.prepare(`
    SELECT jobs.next_attempt_at AS nextAttemptAt
    FROM notification_writeback_jobs jobs
    WHERE jobs.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM notification_writeback_jobs earlier
        WHERE earlier.notification_id = jobs.notification_id
          AND earlier.rowid < jobs.rowid
          AND earlier.status IN ('pending', 'sending')
      )
    ORDER BY jobs.next_attempt_at
    LIMIT 1
  `).get() as { nextAttemptAt: string } | undefined;
  const nextLease = sqlite.prepare(`
    SELECT lease_expires_at AS nextAttemptAt
    FROM notification_writeback_jobs
    WHERE status = 'sending' AND lease_expires_at IS NOT NULL
    ORDER BY lease_expires_at
    LIMIT 1
  `).get() as { nextAttemptAt: string } | undefined;
  const next = [nextPending, nextLease]
    .filter((value): value is { nextAttemptAt: string } => !!value)
    .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))[0];
  if (!next) return;
  const delay = Math.max(0, Math.min(
    WRITEBACK_MAX_RETRY_MS,
    Date.parse(next.nextAttemptAt) - Date.now(),
  ));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    wakeNotificationWritebackDispatcher();
  }, delay);
  retryTimer.unref?.();
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return value as string[];
}

async function withWritebackTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${WRITEBACK_REQUEST_TIMEOUT_MS}ms`));
    }, WRITEBACK_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortableWritebackTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(
    new Error(`${label} timed out after ${WRITEBACK_REQUEST_TIMEOUT_MS}ms`),
  ), WRITEBACK_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function rememberSingleJobConnector(connectorInstanceId: string): void {
  if (
    !singleJobConnectorIds.has(connectorInstanceId)
    && singleJobConnectorIds.size >= MAX_TRACKED_SINGLE_JOB_CONNECTORS
  ) {
    const oldest = singleJobConnectorIds.values().next().value;
    if (oldest) singleJobConnectorIds.delete(oldest);
  }
  singleJobConnectorIds.add(connectorInstanceId);
}

/** @deprecated Dismissals are queued; use enqueueNotificationDismissalWritebacks. */
export async function writebackNotificationDismissals(notificationIds: string[]): Promise<number> {
  const queued = await enqueueNotificationDismissalWritebacks(notificationIds);
  if (queued > 0) wakeNotificationWritebackDispatcher();
  return queued;
}

/** @deprecated Dismissals are queued; use enqueueNotificationDismissalWritebacks. */
export const writebackAlertDismissals = writebackNotificationDismissals;
