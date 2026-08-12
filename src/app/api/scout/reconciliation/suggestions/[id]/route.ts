import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  actOnReconciliationSuggestion,
  ScoutReconciliationError,
} from '@/lib/connectors/scout/reconciliation-service';
import { ApiErrors } from '@/lib/api-error';

const actionSchema = z.object({
  action: z.enum(['accept', 'dismiss', 'never-auto-complete']),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues[0]?.message ?? 'Invalid suggestion action');
    }
    const { id } = await params;
    const actor = request.headers.get('x-mc-actor')?.trim().slice(0, 120) || 'user';
    const result = await actOnReconciliationSuggestion(id, { ...parsed.data, actor });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ScoutReconciliationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SyntaxError) {
      return ApiErrors.badRequest('Request body must be valid JSON');
    }
    return ApiErrors.internal('Failed to apply reconciliation suggestion', error);
  }
}
