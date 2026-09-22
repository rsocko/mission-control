import { z } from 'zod';
import { getDurableAiRunRepository } from '@/lib/ai/durable-runs';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';

const runIdSchema = z.string().trim().min(1).max(200);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
  const parsed = runIdSchema.safeParse((await params).runId);
  if (!parsed.success) return ApiErrors.badRequest('Invalid durable AI run ID.');

  try {
    const run = await (await getDurableAiRunRepository())
      .requestCancellation(parsed.data);
    if (!run) return ApiErrors.notFound('Durable AI run');
    return Response.json({ run });
  } catch (error) {
    return ApiErrors.internal(
      'Failed to request durable AI run cancellation.',
      error,
    );
  }
}
