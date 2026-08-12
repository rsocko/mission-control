import db, { runTransaction } from '@/db';
import { externalAgents, inboundWebhooks, notificationPushRules } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
    const body = await request.json();
    const updates: Record<string, unknown> = {};

    if (typeof body.name === 'string') updates.name = body.name.trim();
    if (typeof body.sourceLabel === 'string') updates.sourceLabel = body.sourceLabel.trim();
    if (typeof body.secret === 'string') {
      const secret = body.secret.trim() || null;
      if (!secret) {
        const [referencingAgent] = await db.select({ id: externalAgents.id })
          .from(externalAgents)
          .where(and(
            eq(externalAgents.inboundWebhookId, id),
            isNull(externalAgents.deletedAt),
          ))
          .limit(1);
        if (referencingAgent) {
          return ApiErrors.conflict('Cannot remove a secret used by an external agent');
        }
      }
      updates.secret = secret;
    }
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
    if (['task', 'alert', 'auto'].includes(body.defaultAction)) {
      updates.defaultAction = body.defaultAction;
    }
    if (body.fieldMappings && typeof body.fieldMappings === 'object') {
      updates.fieldMappings = body.fieldMappings;
    }

    if (!Object.keys(updates).length) {
      return Response.json({ error: 'No updates provided' }, { status: 400 });
    }

    updates.updatedAt = new Date().toISOString();

    await db.update(inboundWebhooks).set(updates).where(eq(inboundWebhooks.id, id));
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
    const [referencingAgent] = await db.select({ id: externalAgents.id })
      .from(externalAgents)
      .where(and(
        eq(externalAgents.inboundWebhookId, id),
        isNull(externalAgents.deletedAt),
      ))
      .limit(1);
    if (referencingAgent) {
      return ApiErrors.conflict('Cannot delete a webhook used by an external agent');
    }
    runTransaction(transaction => {
      transaction.delete(notificationPushRules)
        .where(eq(notificationPushRules.connectorInstanceId, id))
        .run();
      transaction.delete(inboundWebhooks).where(eq(inboundWebhooks.id, id)).run();
    });
    return Response.json({ success: true });
  } catch (error) {
    return ApiErrors.internal('Failed to delete inbound webhook', error);
  }
}
