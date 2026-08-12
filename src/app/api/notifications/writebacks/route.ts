import { sqlite } from '@/db';
import { wakeNotificationWritebackDispatcher } from '@/lib/notifications/notification-writeback';
import { ApiErrors } from '@/lib/api-error';

export async function GET(request: Request) {
  const notificationId = new URL(request.url).searchParams.get('notificationId');
  const where = notificationId ? 'AND notification_id = ?' : '';
  const parameters = notificationId ? [notificationId] : [];
  const counts = sqlite.prepare(`
    SELECT status, COUNT(*) AS count
    FROM notification_writeback_jobs
    GROUP BY status
  `).all() as Array<{ status: string; count: number }>;
  const jobs = sqlite.prepare(`
    SELECT
      id,
      notification_id AS notificationId,
      connector_instance_id AS connectorInstanceId,
      action_type AS action,
      status,
      retryable,
      attempt_count AS attemptCount,
      max_attempts AS maxAttempts,
      next_attempt_at AS nextAttemptAt,
      last_error AS lastError,
      updated_at AS updatedAt
    FROM notification_writeback_jobs
    WHERE status IN ('pending', 'sending', 'failed')
      ${where}
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(...parameters);
  const syncState = jobs.some((job) => (job as { status: string }).status === 'failed')
    ? 'failed'
    : jobs.length > 0
      ? 'pending'
      : 'synced';

  return Response.json({
    counts: Object.fromEntries(counts.map((row) => [row.status, row.count])),
    jobs,
    failed: jobs.filter((job) => (job as { status: string }).status === 'failed'),
    syncState,
    retryable: jobs.some((job) =>
      (job as { status: string; retryable: number }).status === 'failed'
      && (job as { retryable: number }).retryable === 1),
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('A JSON body is required');
  }
  const ids = (body as { ids?: unknown }).ids;
  const notificationIds = (body as { notificationIds?: unknown }).notificationIds;
  const selected = Array.isArray(ids) ? ids : notificationIds;
  if (
    !Array.isArray(selected)
    || selected.length === 0
    || selected.length > 50
    || selected.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    return ApiErrors.badRequest(
      'ids or notificationIds must contain between 1 and 50 identifiers',
    );
  }
  const uniqueIds = [...new Set(selected.map((id) => id.trim()))];
  const placeholders = uniqueIds.map(() => '?').join(',');
  const selector = Array.isArray(ids) ? 'id' : 'notification_id';
  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    const retryable = sqlite.prepare(`
      SELECT jobs.id, jobs.notification_id AS notificationId
      FROM notification_writeback_jobs jobs
      WHERE jobs.${selector} IN (${placeholders})
        AND jobs.status = 'failed'
        AND jobs.retryable = 1
        AND NOT EXISTS (
          SELECT 1
          FROM notification_writeback_jobs newer
          WHERE newer.notification_id = jobs.notification_id
            AND newer.rowid > jobs.rowid
            AND newer.status <> 'superseded'
        )
    `).all(...uniqueIds) as Array<{ id: string; notificationId: string }>;
    for (const job of retryable) {
      sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = 'pending',
            attempt_count = 0,
            next_attempt_at = ?,
            lease_expires_at = NULL,
            last_error = NULL,
            completed_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, now, job.id);
      sqlite.prepare(`
        UPDATE notifications SET sync_state = 'pending' WHERE id = ?
      `).run(job.notificationId);
    }
    return retryable;
  });
  const retried = transaction.immediate();
  if (retried.length > 0) wakeNotificationWritebackDispatcher();
  return Response.json({
    success: retried.length > 0,
    outcome: retried.length > 0 ? 'pending' : 'not_retryable',
    retried: retried.map((job) => job.id),
  });
}
