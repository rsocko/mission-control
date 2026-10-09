import { NextResponse } from 'next/server';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { financeReviewActionRequestSchema } from '@/lib/finance/quick-review-contract';
import {
  applyQuickReviewAction,
  QuickReviewSessionError,
} from '@/lib/finance/quick-review-service';
import { MonarchBridgeError } from '@/lib/connectors/monarch-money/client';
import { ApiErrors } from '@/lib/api-error';

export async function POST(request: Request) {
  const actorType = trustedFinanceMutationActor(request);
  if (!actorType) {
    return ApiErrors.forbidden('Finance review changes are restricted to trusted users.');
  }
  const parsed = financeReviewActionRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid finance review action',
      code: 'invalid_review_action',
    }, { status: 400 });
  }
  try {
    return NextResponse.json(await applyQuickReviewAction(parsed.data, actorType, request.signal));
  } catch (error) {
    if (error instanceof QuickReviewSessionError || error instanceof MonarchBridgeError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: 'retryable' in error ? error.retryable : false,
      }, { status: error.status ?? 500 });
    }
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message, code: 'review_not_configured' }, { status: 400 });
    }
    return ApiErrors.internal('Failed to apply finance review action', error);
  }
}
