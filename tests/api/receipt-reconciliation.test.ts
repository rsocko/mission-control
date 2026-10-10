import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trustedRead: vi.fn(),
  trustedMutation: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  act: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/finance-request', () => ({
  isTrustedFinanceReadRequest: mocks.trustedRead,
  trustedFinanceMutationActor: mocks.trustedMutation,
}));

vi.mock('@/lib/receipt-reconciliation/server-adapter', () => ({
  ReceiptReconciliationAdapterError: class ReceiptReconciliationAdapterError extends Error {},
  OwlReceiptReconciliationAdapter: class OwlReceiptReconciliationAdapter {
    list = mocks.list;
    get = mocks.get;
    act = mocks.act;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustedRead.mockReturnValue(true);
  mocks.trustedMutation.mockReturnValue('parent-admin');
  mocks.list.mockResolvedValue({
    contractVersion: '1.0',
    state: 'empty',
    items: [],
    offset: 0,
    nextOffset: null,
    unavailableReason: null,
  });
});

describe('receipt reconciliation API boundary', () => {
  it('requires a trusted finance read and bounds the offset', async () => {
    const { GET } = await import('@/app/api/finance/receipt-reconciliation/route');
    mocks.trustedRead.mockReturnValueOnce(false);
    expect((await GET(new Request('https://mc.example/api/finance/receipt-reconciliation'))).status)
      .toBe(403);

    const invalid = await GET(new Request(
      'https://mc.example/api/finance/receipt-reconciliation?offset=-1',
    ));
    expect(invalid.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('sends only strict action input and the header idempotency key to OWL', async () => {
    mocks.act.mockResolvedValue({ contractVersion: '1.0' });
    const { POST } = await import(
      '@/app/api/finance/receipt-reconciliation/[reviewId]/route'
    );
    const response = await POST(new Request(
      'https://mc.example/api/finance/receipt-reconciliation/review_opaque',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'mc:payment-review:test' },
        body: JSON.stringify({
          action: 'confirm',
          expectedRevision: 4,
          evidenceId: 'evidence_opaque',
        }),
      },
    ), { params: Promise.resolve({ reviewId: 'review_opaque' }) });

    expect(response.status).toBe(200);
    expect(mocks.act).toHaveBeenCalledWith(
      'review_opaque',
      {
        action: 'confirm',
        expectedRevision: 4,
        evidenceId: 'evidence_opaque',
      },
      'mc:payment-review:test',
    );
  });

  it('rejects attention actions from the browser boundary', async () => {
    const { POST } = await import(
      '@/app/api/finance/receipt-reconciliation/[reviewId]/route'
    );
    const response = await POST(new Request(
      'https://mc.example/api/finance/receipt-reconciliation/review_opaque',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'mc:payment-review:test' },
        body: JSON.stringify({
          action: 'deliver_attention',
          expectedRevision: 4,
        }),
      },
    ), { params: Promise.resolve({ reviewId: 'review_opaque' }) });

    expect(response.status).toBe(400);
    expect(mocks.act).not.toHaveBeenCalled();
  });
});
