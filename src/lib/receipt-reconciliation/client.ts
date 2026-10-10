import {
  paymentReviewActionResultSchema,
  paymentReviewPageSchema,
  type PaymentReviewActionRequest,
  type PaymentReviewActionResult,
  type PaymentReviewPage,
} from './contract';

const ENDPOINT = '/api/finance/receipt-reconciliation';

export class ReceiptReconciliationClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly current: PaymentReviewActionResult['item'] | null = null,
  ) {
    super(message);
  }
}

async function responseError(response: Response): Promise<ReceiptReconciliationClientError> {
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    code?: unknown;
    current?: unknown;
  } | null;
  return new ReceiptReconciliationClientError(
    typeof body?.error === 'string' ? body.error : 'Receipt reconciliation request failed.',
    response.status,
    typeof body?.code === 'string' ? body.code : 'receipt_reconciliation_failed',
    body?.current ? paymentReviewActionResultSchema.shape.item.parse(body.current) : null,
  );
}

export interface ReceiptReconciliationClient {
  list(offset?: number): Promise<PaymentReviewPage>;
  act(
    reviewId: string,
    request: PaymentReviewActionRequest,
    idempotencyKey: string,
  ): Promise<PaymentReviewActionResult>;
}

export const httpReceiptReconciliationClient: ReceiptReconciliationClient = {
  async list(offset = 0) {
    const response = await fetch(`${ENDPOINT}?offset=${offset}`, { cache: 'no-store' });
    if (!response.ok) throw await responseError(response);
    return paymentReviewPageSchema.parse(await response.json());
  },

  async act(reviewId, request, idempotencyKey) {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(reviewId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await responseError(response);
    return paymentReviewActionResultSchema.parse(await response.json());
  },
};
