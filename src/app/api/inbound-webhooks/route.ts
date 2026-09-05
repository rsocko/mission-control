import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export async function GET() {
  try {
    const repositories = await getWorkerPersistenceRepositories();
    const webhooks = await repositories.webhookIntegrations.inbound.list();

    return Response.json({ webhooks });
  } catch (error) {
    return ApiErrors.internal('Failed to load inbound webhooks', error);
  }
}

export async function POST(request: Request) {
  try {
    if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const sourceLabel = typeof body.sourceLabel === 'string' ? body.sourceLabel.trim() : 'webhook';
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const defaultAction = ['task', 'alert', 'auto'].includes(body.defaultAction)
      ? body.defaultAction
      : 'auto';
    const fieldMappings = body.fieldMappings && typeof body.fieldMappings === 'object'
      ? body.fieldMappings
      : {};

    if (!name) {
      return ApiErrors.badRequest('name is required');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const repositories = await getWorkerPersistenceRepositories();

    await repositories.webhookIntegrations.inbound.create({
      id,
      name,
      sourceLabel,
      secret: secret || null,
      defaultAction,
      fieldMappings,
      createdAt: now,
      updatedAt: now,
    });

    return Response.json({ id, receiveUrl: `/api/inbound-webhooks/${id}/receive` }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to create inbound webhook', error);
  }
}
