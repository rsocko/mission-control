import { NextResponse } from 'next/server';
import { TyrionFinanceReviewError } from '@/lib/connectors/monarch-money/quick-review-client';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { financeQuickReviewRuleSuggestionRequestSchema } from '@/lib/finance/quick-review-contract';
import {
  previewQuickReviewMerchantRule,
  QuickReviewSessionError,
} from '@/lib/finance/quick-review-service';
import { ApiErrors } from '@/lib/api-error';

export async function POST(request: Request) {
  if (!trustedFinanceMutationActor(request)) {
    return ApiErrors.forbidden('Rule suggestions are restricted to trusted users.');
  }
  const parsed = financeQuickReviewRuleSuggestionRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid rule suggestion request',
      code: 'invalid_rule_suggestion_request',
    }, { status: 400 });
  }
  try {
    const result = await previewQuickReviewMerchantRule(parsed.data, request.signal);
    return NextResponse.json({
      contractVersion: result.contractVersion,
      suggestion: result.suggestion,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof TyrionFinanceReviewError || error instanceof QuickReviewSessionError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: 'retryable' in error ? error.retryable : false,
      }, { status: error.status });
    }
    return ApiErrors.internal('Failed to suggest a finance attribution rule', error);
  }
}
