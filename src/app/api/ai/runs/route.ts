import { z } from 'zod';
import { DurableAiRunStore } from '@/lib/ai/durable-runs';
import { ApiErrors } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z.enum([
    'queued',
    'running',
    'cancelling',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
  ]).optional(),
  featureId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().trim().min(1).max(500).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get('status') || undefined,
    featureId: url.searchParams.get('featureId') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    before: url.searchParams.get('before') || undefined,
  });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid durable AI run history query.');
  }

  try {
    const runs = new DurableAiRunStore().listRuns(parsed.data);
    return Response.json(
      {
        runs,
        nextBefore: runs.length === parsed.data.limit
          ? `${runs.at(-1)?.createdAt}|${runs.at(-1)?.id}`
          : null,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return ApiErrors.internal('Failed to load durable AI run history.', error);
  }
}
