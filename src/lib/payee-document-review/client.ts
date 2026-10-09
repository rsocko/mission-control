import {
  payeeDocumentReviewDecisionResultSchema,
  payeeDocumentReviewSnapshotSchema,
  type PayeeDocumentReviewDecision,
  type PayeeDocumentReviewDecisionResult,
  type PayeeDocumentReviewSnapshot,
} from './contract';

const REVIEW_ENDPOINT = '/api/finance/payee-document-review';

export class PayeeDocumentReviewClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PayeeDocumentReviewClient {
  load(): Promise<PayeeDocumentReviewSnapshot>;
  decide(decision: PayeeDocumentReviewDecision): Promise<PayeeDocumentReviewDecisionResult>;
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : 'Payee document review request failed.';
}

export const httpPayeeDocumentReviewClient: PayeeDocumentReviewClient = {
  async load() {
    const response = await fetch(REVIEW_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new PayeeDocumentReviewClientError(await errorMessage(response), response.status);
    }
    return payeeDocumentReviewSnapshotSchema.parse(await response.json());
  },

  async decide(decision) {
    const response = await fetch(REVIEW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
    });
    if (!response.ok) {
      throw new PayeeDocumentReviewClientError(await errorMessage(response), response.status);
    }
    return payeeDocumentReviewDecisionResultSchema.parse(await response.json());
  },
};
