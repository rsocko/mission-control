import { ApiErrors } from '@/lib/api-error';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { OutboundWebhookPatch } from '@/db/persistence/webhook-integrations';

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
    const patch: OutboundWebhookPatch = {};

    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.url === 'string') {
      const url = body.url.trim();
      try {
        new URL(url);
      } catch {
        return Response.json({ error: 'Webhook URL must be valid' }, { status: 400 });
      }
      patch.url = url;
    }
    if (typeof body.secret === 'string') patch.secret = body.secret.trim() || null;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

    const eventTypes = normalizeEventTypes(body.eventTypes);
    if (eventTypes) patch.eventTypes = eventTypes;

    if (!Object.keys(patch).length) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    const repositories = await getWorkerPersistenceRepositories();
    await repositories.webhookIntegrations.outbound.update(id, patch);
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
    const repositories = await getWorkerPersistenceRepositories();
    await repositories.webhookIntegrations.outbound.delete(id);
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete webhook', error);
  }
}
