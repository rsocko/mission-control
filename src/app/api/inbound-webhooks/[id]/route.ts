import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { InboundWebhookPatch } from '@/db/persistence/webhook-integrations';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
    const body = await request.json();
    const patch: InboundWebhookPatch = {};

    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.sourceLabel === 'string') patch.sourceLabel = body.sourceLabel.trim();
    if (typeof body.secret === 'string') patch.secret = body.secret.trim() || null;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (['task', 'alert', 'auto'].includes(body.defaultAction)) {
      patch.defaultAction = body.defaultAction;
    }
    if (body.fieldMappings && typeof body.fieldMappings === 'object') {
      patch.fieldMappings = body.fieldMappings;
    }

    if (!Object.keys(patch).length) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    const repositories = await getWorkerPersistenceRepositories();
    const outcome = await repositories.webhookIntegrations.inbound.update({
      id,
      patch,
      updatedAt: new Date().toISOString(),
    });
    if (outcome === 'secret-referenced') {
      return ApiErrors.conflict('Cannot remove a secret used by an external agent');
    }
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to update inbound webhook', error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
    const repositories = await getWorkerPersistenceRepositories();
    const outcome = await repositories.webhookIntegrations.inbound.delete(id);
    if (outcome === 'agent-referenced') {
      return ApiErrors.conflict('Cannot delete a webhook used by an external agent');
    }
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete inbound webhook', error);
  }
}
