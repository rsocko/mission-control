import { z } from 'zod';
import { getDurableAiRunRepository } from '@/lib/ai/durable-runs';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';

const paramsSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(300),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  if (!isTrustedMutationRequest(request)) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => null) as {
    idempotencyKey?: unknown;
  } | null;
  const parsed = paramsSchema.safeParse({
    runId: (await params).runId,
    idempotencyKey:
      request.headers.get('idempotency-key') ?? body?.idempotencyKey,
  });
  if (!parsed.success) {
    return ApiErrors.badRequest(
      'A valid durable AI run ID and retry idempotency key are required.',
    );
  }

  try {
    const run = await (await getDurableAiRunRepository()).retryRun(
      parsed.data.runId,
      parsed.data.idempotencyKey,
    );
    if (!run) return ApiErrors.notFound('Durable AI run');
    return Response.json({ run });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message.startsWith('Only failed or timed-out')
        || error.message.includes('cleanup is running')
      )
    ) {
      return ApiErrors.conflict(error.message);
    }
    return ApiErrors.internal('Failed to retry durable AI run.', error);
  }
}
