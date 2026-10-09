import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';
import { payeeDocumentReviewDecisionSchema } from '@/lib/payee-document-review/contract';
import {
  getPayeeDocumentReviewAdapter,
  PayeeDocumentReviewAdapterUnavailableError,
  PayeeDocumentReviewUpstreamError,
} from '@/lib/payee-document-review/server-adapter';

export async function GET(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    return NextResponse.json(await getPayeeDocumentReviewAdapter().load());
  } catch (error) {
    return ApiErrors.internal('Failed to load payee document review', error);
  }
}

export async function POST(request: Request) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return ApiErrors.badRequest('Request body must be valid JSON');
  }

  const decision = payeeDocumentReviewDecisionSchema.safeParse(body);
  if (!decision.success) {
    return ApiErrors.validation('Invalid payee document review decision');
  }

  try {
    return NextResponse.json(
      await getPayeeDocumentReviewAdapter().decide(decision.data),
    );
  } catch (error) {
    if (error instanceof PayeeDocumentReviewAdapterUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503 },
      );
    }
    if (error instanceof PayeeDocumentReviewUpstreamError) {
      return NextResponse.json(
        { error: error.message, code: `${error.source}_upstream_error` },
        { status: error.status === 404 ? 409 : 502 },
      );
    }
    return ApiErrors.internal('Failed to save payee document review decision', error);
  }
}
