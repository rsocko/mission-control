import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from '@/lib/api/bounded-body';
import { trustedFinanceMutationActor } from '@/lib/connectors/monarch-money/finance-request';
import { TyrionFinanceReviewError } from '@/lib/connectors/monarch-money/quick-review-client';
import { financeMerchantRuleCreateRequestSchema } from '@/lib/finance/quick-review-contract';
import {
  createQuickReviewMerchantRule,
  QuickReviewSessionError,
} from '@/lib/finance/quick-review-service';

const MAX_BODY_BYTES = 65_536;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: Request) {
  if (!trustedFinanceMutationActor(request)) {
    return noStore(ApiErrors.forbidden('Merchant rule creation is restricted to trusted users.'));
  }
  if (request.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json') {
    return NextResponse.json({
      error: 'Merchant rule requests must use application/json',
      code: 'unsupported_media_type',
    }, { status: 415, headers: NO_STORE_HEADERS });
  }
  let body: unknown;
  try {
    const bytes = await readBoundedRequestBody(request, MAX_BODY_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({
        error: 'Merchant rule request is too large',
        code: 'payload_too_large',
      }, { status: 413, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({
      error: 'Merchant rule request must contain valid JSON',
      code: 'invalid_merchant_rule_request',
    }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const parsed = financeMerchantRuleCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid merchant rule request',
      code: 'invalid_merchant_rule_request',
    }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    return NextResponse.json(
      await createQuickReviewMerchantRule(parsed.data, request.signal),
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof TyrionFinanceReviewError || error instanceof QuickReviewSessionError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: 'retryable' in error ? error.retryable : false,
      }, {
        status: error.status,
        headers: NO_STORE_HEADERS,
      });
    }
    logger.error({ err: error }, 'Failed to create finance attribution rule');
    return NextResponse.json({
      error: 'Failed to create finance attribution rule',
      code: 'merchant_rule_creation_failed',
    }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
