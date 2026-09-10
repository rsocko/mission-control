import type { IConnector } from '@/lib/connectors';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { connectorLogger } from '@/lib/logger';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

export const runtime = 'nodejs';

interface HomeAssistantReleaseNotesConnector extends IConnector {
  readonly type: 'home-assistant';
  fetchNotificationReleaseNotes(entityId: string): Promise<string | null>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isReleaseNotesConnector(
  connector: IConnector | null,
): connector is HomeAssistantReleaseNotesConnector {
  return connector?.type === 'home-assistant'
    && 'fetchNotificationReleaseNotes' in connector
    && typeof connector.fetchNotificationReleaseNotes === 'function';
}

function notFound() {
  return Response.json({ error: 'Release notes not found' }, { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const persistence = await getNotificationWebPersistence();
  const notification = await persistence.findNotificationForAction(id);
  if (!notification || notification.connectorType !== 'home-assistant') {
    return notFound();
  }

  const metadata = record(notification.metadata);
  const entityId = typeof metadata.entityId === 'string' ? metadata.entityId : '';
  if (
    metadata.haSource !== 'updates'
    || metadata.supportsReleaseNotes !== true
    || !entityId.startsWith('update.')
  ) {
    return notFound();
  }

  try {
    const connector = await getOrInitializeConnector(notification.connectorInstanceId);
    if (!isReleaseNotesConnector(connector)) {
      return Response.json({ error: 'Home Assistant connector is unavailable' }, { status: 503 });
    }
    const releaseNotes = await connector.fetchNotificationReleaseNotes(entityId);
    return Response.json(
      { releaseNotes },
      {
        headers: {
          'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
        },
      },
    );
  } catch (error) {
    connectorLogger.warn({
      err: error,
      connectorId: notification.connectorInstanceId,
      notificationId: notification.id,
    }, 'Home Assistant release notes fetch failed');
    return Response.json({ error: 'Release notes are temporarily unavailable' }, { status: 503 });
  }
}
