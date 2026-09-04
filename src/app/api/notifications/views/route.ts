import { ApiErrors } from '@/lib/api-error';
import { parseNotificationQuery } from '@/lib/notifications/query';
import { BUILT_IN_NOTIFICATION_VIEWS, type NotificationView } from '@/lib/notifications/views';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import type { SavedViewRow } from '@/db/persistence/notification-web';

function customView(row: SavedViewRow): NotificationView {
  const stored = typeof row.query === 'string' ? JSON.parse(row.query) : row.query;
  return {
    id: row.id,
    name: row.name,
    query: parseNotificationQuery(stored as Record<string, unknown>),
    builtIn: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET() {
  try {
    const web = await getNotificationWebPersistence();
    const rows = await web.listSavedViews();
    return Response.json({
      views: [...BUILT_IN_NOTIFICATION_VIEWS, ...rows.map(customView)],
    });
  } catch (error) {
    return ApiErrors.internal('Failed to load notification views', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) {
      return ApiErrors.badRequest('View name must be between 1 and 80 characters');
    }
    if (!body.query || typeof body.query !== 'object' || Array.isArray(body.query)) {
      return ApiErrors.badRequest('query must be an object');
    }

    const now = new Date().toISOString();
    const web = await getNotificationWebPersistence();
    const row = await web.createSavedView({
      id: crypto.randomUUID(),
      name,
      query: parseNotificationQuery(body.query as Record<string, unknown>),
      now,
    });
    return Response.json({ view: customView(row) }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error
      && error.message.includes('UNIQUE constraint failed: notification_saved_views.name')
    ) {
      return ApiErrors.badRequest('A notification view with that name already exists');
    }
    return ApiErrors.internal('Failed to save notification view', error);
  }
}
