import { NextResponse } from 'next/server';
import {
  TyrionFinanceReviewClient,
  TyrionFinanceReviewError,
} from '@/lib/connectors/monarch-money/quick-review-client';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import { financeVendorResearchRequestSchema } from '@/lib/finance/quick-review-contract';
import { ApiErrors } from '@/lib/api-error';
import {
  getQuickReviewResearchContext,
  QuickReviewSessionError,
} from '@/lib/finance/quick-review-service';
import {
  researchVendor,
  VendorResearchError,
} from '@/lib/finance/vendor-research';

export async function POST(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return ApiErrors.forbidden('Vendor research is restricted to trusted users.');
  }
  const parsed = financeVendorResearchRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid vendor research request',
      code: 'invalid_research_request',
    }, { status: 400 });
  }
  try {
    const context = getQuickReviewResearchContext(parsed.data);
    const prepared = await new TyrionFinanceReviewClient().prepareResearch(
      {
        contractVersion: '1.0',
        vendorName: context.vendorName,
        coarseLocation: context.coarseLocation,
        sensitiveContext: parsed.data.publicContext.sensitiveContextApproved
          ? {
              amount: context.amount,
              occurredOn: context.occurredOn,
            }
          : null,
        disclosure: {
          shown: parsed.data.publicContext.sensitiveContextApproved,
          confirmedAt: parsed.data.publicContext.sensitiveContextApproved
            ? new Date().toISOString()
            : null,
        },
      },
      request.signal,
    );
    return NextResponse.json(await researchVendor({
      reviewRef: parsed.data.reviewRef,
      prepared,
      signal: request.signal,
    }));
  } catch (error) {
    if (error instanceof QuickReviewSessionError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: false,
      }, { status: error.status });
    }
    if (error instanceof TyrionFinanceReviewError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status: error.status });
    }
    if (error instanceof VendorResearchError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
      }, { status: error.status });
    }
    return ApiErrors.internal('Failed to research finance vendor', error);
  }
}
