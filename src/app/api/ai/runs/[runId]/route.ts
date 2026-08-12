import { z } from 'zod';
import { DurableAiRunStore } from '@/lib/ai/durable-runs';
import { ApiErrors } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

const runIdSchema = z.string().trim().min(1).max(200);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const parsed = runIdSchema.safeParse((await params).runId);
  if (!parsed.success) return ApiErrors.badRequest('Invalid durable AI run ID.');

  try {
    const run = new DurableAiRunStore().getRun(parsed.data);
    if (!run) return ApiErrors.notFound('Durable AI run');
    return Response.json(
      { run },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return ApiErrors.internal('Failed to load durable AI run status.', error);
  }
}
