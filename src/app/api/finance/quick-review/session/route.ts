import { NextResponse } from 'next/server';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { financeReviewSessionRequestSchema } from '@/lib/finance/quick-review-contract';
import {
  QuickReviewSessionError,
  startQuickReviewSession,
} from '@/lib/finance/quick-review-service';
import {
  MonarchBridgeError,
} from '@/lib/connectors/monarch-money/client';
import {
  TyrionFinanceReviewError,
} from '@/lib/connectors/monarch-money/quick-review-client';
import { ApiErrors } from '@/lib/api-error';

export async function POST(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return ApiErrors.forbidden('Finance review is restricted to trusted users.');
  }
  const parsed = financeReviewSessionRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid finance review request',
      code: 'invalid_review_request',
    }, { status: 400 });
  }
  try {
    return NextResponse.json(await startQuickReviewSession(parsed.data, request.signal));
  } catch (error) {
    if (
      error instanceof QuickReviewSessionError
      || error instanceof TyrionFinanceReviewError
      || error instanceof MonarchBridgeError
    ) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: 'retryable' in error ? error.retryable : false,
      }, { status: error.status ?? 500 });
    }
    if (error instanceof Error && /not configured|required when multiple/.test(error.message)) {
      return NextResponse.json({ error: error.message, code: 'review_not_configured' }, { status: 400 });
    }
    return ApiErrors.internal('Failed to start finance quick review', error);
  }
}
