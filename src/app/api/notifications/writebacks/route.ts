import { ApiErrors } from '@/lib/api-error';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

export async function GET(request: Request) {
  const notificationId = new URL(request.url).searchParams.get('notificationId');
  const web = await getNotificationWebPersistence();
  const status = await web.listWritebackStatus(notificationId);

  return Response.json({
    counts: status.counts,
    jobs: status.jobs,
    failed: status.failed,
    syncState: status.syncState,
    retryable: status.retryable,
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
  const selector = Array.isArray(ids) ? 'id' as const : 'notification_id' as const;
  const now = new Date().toISOString();

  const web = await getNotificationWebPersistence();
  const { retried } = await web.retryWritebacks(selector, uniqueIds, now);

  if (retried.length > 0) web.wakeWritebackDispatcher();
  return Response.json({
    success: retried.length > 0,
    outcome: retried.length > 0 ? 'pending' : 'not_retryable',
    retried: retried.map((job) => job.id),
  });
}
