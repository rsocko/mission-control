import { ApiErrors } from '@/lib/api-error';
import { BUILT_IN_NOTIFICATION_VIEWS } from '@/lib/notifications/views';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (BUILT_IN_NOTIFICATION_VIEWS.some(view => view.id === id)) {
      return ApiErrors.badRequest('Built-in views cannot be deleted');
    }
    const web = await getNotificationWebPersistence();
    const deleted = await web.deleteSavedView(id);
    if (!deleted) return ApiErrors.notFound('Notification view');
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete notification view', error);
  }
}
