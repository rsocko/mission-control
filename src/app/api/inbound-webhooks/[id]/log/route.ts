import { ApiErrors } from '@/lib/api-error';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/**
 * GET /api/inbound-webhooks/[id]/log
 *
 * Returns the most recent delivery log entries for an inbound webhook.
 * Query params: ?limit=25 (default 25, max 100)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') || '25', 10) || 25, 1),
    100,
  );

  try {
    const repositories = await getWorkerPersistenceRepositories();
    const entries = await repositories.webhookIntegrations.inbound.listLog({
      webhookId: id,
      limit,
    });

    return Response.json({ entries });
  } catch (error) {
    return ApiErrors.internal('Failed to load log', error);
  }
}
