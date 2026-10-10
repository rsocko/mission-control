import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  paymentReviewItemSchema,
  paymentReviewPageSchema,
} from '@/lib/receipt-reconciliation/contract';

const wireItem = {
  contract_version: '1.0',
  id: 'payment_review_opaque',
  revision: 1,
  case_kind: 'ambiguous',
  state: 'open',
  active: true,
  attention_state: 'pending',
  source_as_of: '2026-10-10T12:00:00',
  summary: {
    reason_codes: ['close_candidates'],
    source_generation: 'generation_opaque',
  },
  obligation: {
    id: 'obligation_opaque',
    status: 'open',
    revision: 2,
    expected_amount_minor: 10_000,
    currency: 'USD',
    completion_suggested: false,
  },
  evidence: {
    id: 'evidence_opaque',
    kind: 'bill',
    payee_hint: 'Invented Utilities',
    amount_minor: 10_000,
    currency: 'USD',
    evidence_date: '2026-10-10',
    source_system: 'tyrion_bill_match',
    source_state: 'ambiguous',
    match_state: 'ambiguous',
    payment_status: 'ambiguous',
    confidence: 'medium',
    reason_codes: ['close_candidates'],
    source_as_of: '2026-10-10T12:00:00',
    edge_state: 'proposed',
  },
  owl_deep_link: '#/action-queue?obligation=obligation_opaque',
  source_actions: [{
    id: 'confirm',
    method: 'POST',
    url: '/api/mc/v1/payment-reconciliation-reviews/payment_review_opaque/actions',
    expected_revision: 1,
  }, {
    id: 'deliver_attention',
    method: 'POST',
    url: '/api/mc/v1/payment-reconciliation-reviews/payment_review_opaque/actions',
    expected_revision: 1,
  }],
  history: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  delete process.env.OWL_MISSION_CONTROL_URL;
  delete process.env.OWL_MISSION_CONTROL_API_TOKEN;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('receipt reconciliation OWL boundary', () => {
  it('normalizes the pinned OWL DTO, local timestamps, and hash-only owner link', async () => {
    process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
    process.env.OWL_MISSION_CONTROL_API_TOKEN = 'test-token';
    const fetchMock = vi.fn().mockResolvedValue(response([wireItem]));
    vi.stubGlobal('fetch', fetchMock);
    const { OwlReceiptReconciliationAdapter } = await import(
      '@/lib/receipt-reconciliation/server-adapter'
    );

    const page = await new OwlReceiptReconciliationAdapter().list();

    expect(paymentReviewPageSchema.parse(page)).toMatchObject({
      state: 'ready',
      items: [{
        id: wireItem.id,
        sourceAsOf: '2026-10-10T12:00:00Z',
        evidence: { sourceAsOf: '2026-10-10T12:00:00Z' },
        owlUrl: 'https://owl.example/#/action-queue?obligation=obligation_opaque',
      }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('active_only=true');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer ' + 'test-token',
    );
    expect(JSON.stringify(page)).not.toContain('test-token');
  });

  it('rejects private source fields instead of forwarding them', async () => {
    process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
    process.env.OWL_MISSION_CONTROL_API_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{
      ...wireItem,
      transaction_ref: 'must-not-cross',
    }])));
    const { OwlReceiptReconciliationAdapter } = await import(
      '@/lib/receipt-reconciliation/server-adapter'
    );

    await expect(new OwlReceiptReconciliationAdapter().list()).rejects.toThrow();
  });

  it('writes expected revision and idempotency then verifies a separate read-back', async () => {
    process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
    process.env.OWL_MISSION_CONTROL_API_TOKEN = 'test-token';
    const resolved = {
      ...wireItem,
      revision: 2,
      state: 'resolved',
      active: false,
      attention_state: 'settled',
      source_actions: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        contract_version: '1.0',
        action: 'confirm',
        case: resolved,
        source_acknowledgement: 'not_required',
        authoritative_read_back: true,
        idempotent: false,
      }))
      .mockResolvedValueOnce(response(resolved));
    vi.stubGlobal('fetch', fetchMock);
    const { OwlReceiptReconciliationAdapter } = await import(
      '@/lib/receipt-reconciliation/server-adapter'
    );

    const result = await new OwlReceiptReconciliationAdapter().act(
      wireItem.id,
      {
        action: 'confirm',
        expectedRevision: 1,
        evidenceId: 'evidence_opaque',
        allocatedAmountMinor: 10_000,
      },
      'mc:payment-review:test-key',
    );

    expect(result.item.revision).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      contract_version: '1.0',
      action: 'confirm',
      expected_revision: 1,
      idempotency_key: 'mc:payment-review:test-key',
      evidence_id: 'evidence_opaque',
      allocated_amount_minor: 10_000,
    });
    expect(fetchMock.mock.calls[1]?.[1]?.cache).toBe('no-store');
  });

  it('records attention only after the caller supplies a stable local delivery reference', async () => {
    process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
    process.env.OWL_MISSION_CONTROL_API_TOKEN = 'test-token';
    const delivered = {
      ...wireItem,
      revision: 2,
      attention_state: 'delivered',
      source_actions: [],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        contract_version: '1.0',
        action: 'deliver_attention',
        case: delivered,
        source_acknowledgement: 'not_required',
        authoritative_read_back: true,
        idempotent: false,
      }))
      .mockResolvedValueOnce(response(delivered));
    vi.stubGlobal('fetch', fetchMock);
    const { OwlReceiptReconciliationAdapter } = await import(
      '@/lib/receipt-reconciliation/server-adapter'
    );

    const result = await new OwlReceiptReconciliationAdapter().deliverAttention(
      wireItem.id,
      1,
      'finance-attention:stable-local-reference',
    );

    expect(result.item.attentionState).toBe('delivered');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      contract_version: '1.0',
      action: 'deliver_attention',
      expected_revision: 1,
      idempotency_key: `mc:attention:${wireItem.id}:1`,
      attention_delivery_ref: 'finance-attention:stable-local-reference',
    });
  });

  it('rejects unsafe owner links in the strict public contract', () => {
    expect(() => paymentReviewItemSchema.parse({
      contractVersion: '1.0',
      id: 'review',
      revision: 1,
      caseKind: 'unmatched',
      state: 'open',
      active: true,
      attentionState: 'pending',
      sourceAsOf: '2026-10-10T12:00:00Z',
      summary: {},
      obligation: {
        id: 'obligation',
        status: 'open',
        revision: 1,
        expectedAmountMinor: null,
        currency: null,
        completionSuggested: false,
      },
      evidence: null,
      owlUrl: 'javascript:alert(1)',
      sourceActions: [],
    })).toThrow();
  });
});
