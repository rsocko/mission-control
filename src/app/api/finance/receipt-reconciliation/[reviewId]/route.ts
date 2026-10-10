import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';
import { paymentReviewActionRequestSchema } from '@/lib/receipt-reconciliation/contract';
import {
  OwlReceiptReconciliationAdapter,
  ReceiptReconciliationAdapterError,
} from '@/lib/receipt-reconciliation/server-adapter';

const reviewIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const idempotencySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

function adapterError(error: ReceiptReconciliationAdapterError) {
  return NextResponse.json({
    error: error.message,
    code: error.code,
    ...(error.current ? { current: error.current } : {}),
  }, { status: error.status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
) {
  if (!isTrustedFinanceReadRequest(request)) {
    return NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 });
  }
  const reviewId = reviewIdSchema.safeParse((await params).reviewId);
  if (!reviewId.success) {
    return NextResponse.json({ error: 'Invalid receipt review ID', code: 'invalid_review_id' }, { status: 400 });
  }
  try {
    return NextResponse.json(await new OwlReceiptReconciliationAdapter().get(reviewId.data));
  } catch (error) {
    if (error instanceof ReceiptReconciliationAdapterError) return adapterError(error);
    return NextResponse.json({ error: 'Receipt review could not be loaded.', code: 'receipt_review_failed' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reviewId: string }> },
) {
  if (!trustedFinanceMutationActor(request)) {
    return NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 });
  }
  const reviewId = reviewIdSchema.safeParse((await params).reviewId);
  const idempotencyKey = idempotencySchema.safeParse(request.headers.get('idempotency-key'));
  const body = paymentReviewActionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!reviewId.success || !idempotencyKey.success || !body.success) {
    return NextResponse.json({ error: 'Invalid receipt review action', code: 'invalid_request' }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await new OwlReceiptReconciliationAdapter().act(
        reviewId.data,
        body.data,
        idempotencyKey.data,
      ),
    );
  } catch (error) {
    if (error instanceof ReceiptReconciliationAdapterError) return adapterError(error);
    return NextResponse.json({ error: 'Receipt review action failed.', code: 'receipt_action_failed' }, { status: 500 });
  }
}
