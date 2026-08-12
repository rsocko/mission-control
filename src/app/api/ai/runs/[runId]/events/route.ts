import { z } from 'zod';
import { DurableAiRunStore } from '@/lib/ai/durable-runs';
import { ApiErrors } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const url = new URL(request.url);
  const parsed = paramsSchema.safeParse({
    runId: (await params).runId,
    after: url.searchParams.get('after') || undefined,
    limit: url.searchParams.get('limit') || undefined,
  });
  if (!parsed.success) {
    return ApiErrors.badRequest('Invalid durable AI run event query.');
  }

  try {
    const store = new DurableAiRunStore();
    const run = store.getRun(parsed.data.runId);
    if (!run) return ApiErrors.notFound('Durable AI run');
    const fetched = store.getEventsAfter(
      parsed.data.runId,
      parsed.data.after,
      parsed.data.limit + 1,
    );
    const hasMore = fetched.length > parsed.data.limit;
    const events = hasMore ? fetched.slice(0, parsed.data.limit) : fetched;
    return Response.json(
      {
        run,
        events,
        nextCursor: events.at(-1)?.cursor ?? parsed.data.after,
        hasMore,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return ApiErrors.internal('Failed to load durable AI run events.', error);
  }
}
