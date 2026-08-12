import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import { resolveRetainedItems } from '@/lib/sync/retention-resolution';

const requestSchema = z.object({
  items: z.array(z.object({
    syncLogId: z.string().min(1),
    detailIndex: z.number().int().min(0),
    resolution: z.enum([
      'retry_push',
      'keep_local',
      'archive_local',
      'discard_local_changes',
      'delete_local',
    ]),
    confirmed: z.boolean().default(false),
  })).min(1).max(50),
});

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return ApiErrors.unauthorized();
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return ApiErrors.validation('Invalid retained-item resolution request');
  }

  try {
    const results = await resolveRetainedItems(parsed.data.items);
    const succeeded = results.filter((result) => result.success).length;
    const failed = results.length - succeeded;
    return NextResponse.json(
      { succeeded, failed, results },
      { status: failed > 0 && succeeded > 0 ? 207 : failed > 0 ? 409 : 200 },
    );
  } catch (error) {
    return ApiErrors.internal('Failed to resolve retained sync items', error);
  }
}
