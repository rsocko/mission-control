import type { IConnector } from '@/lib/connectors';
import type { HomeAssistantImage } from '@/lib/connectors/home-assistant/ha-client';
import {
  getHomeAssistantBrandImagePath,
  getHomeAssistantPublicBrandImageUrl,
} from '@/lib/connectors/home-assistant/notification-icons';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { connectorLogger } from '@/lib/logger';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';

export const runtime = 'nodejs';

interface HomeAssistantIconConnector extends IConnector {
  readonly type: 'home-assistant';
  fetchNotificationImage(path: string): Promise<HomeAssistantImage>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isHomeAssistantIconConnector(
  connector: IConnector | null,
): connector is HomeAssistantIconConnector {
  return connector?.type === 'home-assistant'
    && 'fetchNotificationImage' in connector
    && typeof connector.fetchNotificationImage === 'function';
}

function notFound() {
  return Response.json({ error: 'Notification icon not found' }, { status: 404 });
}

async function fetchPublicBrandImage(url: string): Promise<HomeAssistantImage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Home Assistant brand image request failed (${response.status})`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim();
  if (contentType !== 'image/png') {
    throw new Error('Home Assistant returned an unsupported brand image type');
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
    throw new Error('Home Assistant brand image exceeds the 2 MB limit');
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > 2 * 1024 * 1024) {
    throw new Error('Home Assistant brand image exceeds the 2 MB limit');
  }
  return { body, contentType };
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
  const publicBrandUrl = getHomeAssistantPublicBrandImageUrl(metadata);
  const path = getHomeAssistantBrandImagePath(metadata);
  if (!path) return notFound();

  try {
    let image: HomeAssistantImage;
    if (publicBrandUrl) {
      image = await fetchPublicBrandImage(publicBrandUrl);
    } else {
      const connector = await getOrInitializeConnector(notification.connectorInstanceId);
      if (!isHomeAssistantIconConnector(connector)) {
        return Response.json({ error: 'Home Assistant connector is unavailable' }, { status: 503 });
      }
      image = await connector.fetchNotificationImage(path);
    }
    return new Response(image.body, {
      headers: {
        'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
        'Content-Disposition': 'inline; filename="home-assistant-icon.png"',
        'Content-Length': String(image.body.byteLength),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': image.contentType,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    connectorLogger.warn({
      err: error,
      connectorId: notification.connectorInstanceId,
      notificationId: notification.id,
    }, 'Home Assistant notification icon fetch failed');
    return Response.json({ error: 'Home Assistant icon is unavailable' }, { status: 503 });
  }
}
