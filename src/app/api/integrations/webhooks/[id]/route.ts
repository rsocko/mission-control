import db from '@/db';
import { outboundWebhooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

function normalizeEventTypes(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (typeof body.name === 'string') updates.name = body.name.trim();
    if (typeof body.url === 'string') {
      const url = body.url.trim();
      try {
        new URL(url);
      } catch {
        return Response.json({ error: 'Webhook URL must be valid' }, { status: 400 });
      }
      updates.url = url;
    }
    if (typeof body.secret === 'string') updates.secret = body.secret.trim() || null;
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;

    const eventTypes = normalizeEventTypes(body.eventTypes);
    if (eventTypes) updates.eventTypes = eventTypes;

    if (!Object.keys(updates).length) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    await db.update(outboundWebhooks).set(updates).where(eq(outboundWebhooks.id, id));
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update webhook', error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await db.delete(outboundWebhooks).where(eq(outboundWebhooks.id, id));
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete webhook', error);
  }
}
