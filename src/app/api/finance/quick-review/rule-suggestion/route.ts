import { NextResponse } from 'next/server';
import {
  TyrionFinanceReviewClient,
  TyrionFinanceReviewError,
} from '@/lib/connectors/monarch-money/quick-review-client';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { tyrionQuickReviewRuleRequestSchema } from '@/lib/finance/quick-review-contract';
import { ApiErrors } from '@/lib/api-error';

export async function POST(request: Request) {
  if (!trustedFinanceMutationActor(request)) {
    return ApiErrors.forbidden('Rule suggestions are restricted to trusted users.');
  }
  const parsed = tyrionQuickReviewRuleRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid rule suggestion request',
      code: 'invalid_rule_suggestion_request',
    }, { status: 400 });
  }
  try {
    const result = await new TyrionFinanceReviewClient().suggestRule(parsed.data, request.signal);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof TyrionFinanceReviewError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status: error.status });
    }
    return ApiErrors.internal('Failed to suggest a finance attribution rule', error);
  }
}
