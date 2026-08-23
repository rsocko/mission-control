import db from '@/db';
import { notificationSavedViews } from '@/db/schema';
import { ApiErrors } from '@/lib/api-error';
import { BUILT_IN_NOTIFICATION_VIEWS } from '@/lib/notifications/views';
import { eq } from 'drizzle-orm';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (BUILT_IN_NOTIFICATION_VIEWS.some(view => view.id === id)) {
      return ApiErrors.badRequest('Built-in views cannot be deleted');
    }
    const result = await db.delete(notificationSavedViews)
      .where(eq(notificationSavedViews.id, id));
    if (result.changes === 0) return ApiErrors.notFound('Notification view');
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete notification view', error);
  }
}
