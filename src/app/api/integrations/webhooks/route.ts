import { ApiErrors } from '@/lib/api-error';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

function normalizeEventTypes(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export async function GET() {
  try {
    const repositories = await getWorkerPersistenceRepositories();
    const webhooks = await repositories.webhookIntegrations.outbound.list();

    return Response.json({ webhooks });
  } catch (error) {
    return ApiErrors.internal('Failed to load webhooks', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const eventTypes = normalizeEventTypes(body.eventTypes);

    if (!name || !url || !eventTypes.length) {
      return Response.json({ error: 'name, url, and eventTypes are required' }, { status: 400 });
    }

    try {
      new URL(url);
    } catch {
      return Response.json({ error: 'Webhook URL must be valid' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const repositories = await getWorkerPersistenceRepositories();

    await repositories.webhookIntegrations.outbound.create({
      id,
      name,
      url,
      secret: secret || null,
      eventTypes,
      createdAt,
    });

    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create webhook', error);
  }
}
