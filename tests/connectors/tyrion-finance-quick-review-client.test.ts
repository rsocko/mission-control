import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TyrionFinanceReviewClient,
} from '@/lib/connectors/monarch-money/quick-review-client';
import type {
  TyrionQuickReviewRankRequest,
} from '@/lib/finance/quick-review-contract';

const TOKEN = 'invented-private-token-at-least-32-characters';
const rankRequest = {
  contractVersion: '1.0',
  items: [{
    sourceRef: 'opaque-source-b',
    occurredOn: '2026-10-08',
    merchantName: 'Invented Market',
    isPending: false,
    monarchReviewStatus: 'needs_review',
    attribution: {
      status: 'unassigned',
      confidence: 'unknown',
      reviewStatus: 'needs-review',
    },
    signals: ['monarch-needs-review', 'kid-attribution-ambiguous'],
  }],
} satisfies TyrionQuickReviewRankRequest;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TyrionFinanceReviewClient', () => {
  it('uses the exact private transport and never puts the token in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      rankedItems: [{
        sourceRef: 'opaque-source-b',
        rank: 1,
        score: 90,
        reasons: ['kid-attribution-ambiguous', 'monarch-needs-review'],
      }],
    }), { status: 200 }));

    await new TyrionFinanceReviewClient(TOKEN, fetchMock).rank(rankRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://tyrion-operations-ui:3000/api/internal/v1/finance/quick-review/rank',
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('host')).toBe('tyrion-operations-ui:3000');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it('rejects rank responses that do not correlate exactly and deterministically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      rankedItems: [{
        sourceRef: 'different-opaque-source',
        rank: 1,
        score: 90,
        reasons: [],
      }],
    }), { status: 200 }));

    await expect(
      new TyrionFinanceReviewClient(TOKEN, fetchMock).rank(rankRequest),
    ).rejects.toMatchObject({ code: 'invalid_contract', status: 502 });
  });

  it('enforces disclosure before sensitive research context is sent', async () => {
    const fetchMock = vi.fn();
    await expect(new TyrionFinanceReviewClient(TOKEN, fetchMock).prepareResearch({
      contractVersion: '1.0',
      vendorName: 'Invented Market',
      coarseLocation: null,
      sensitiveContext: { amount: 12.34, occurredOn: '2026-10-08' },
      disclosure: { shown: false, confirmedAt: null },
    })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sensitive context injected by Tyrion after a disclosure-free request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      query: {
        vendorName: 'Invented Market',
        coarseLocation: null,
        amount: 184.62,
        occurredOn: '2026-10-08',
      },
      outputPolicy: {
        factsRequireSources: true,
        inferencesMustBeLabeled: true,
        fraudAssertionAllowed: false,
      },
    }), { status: 200 }));

    await expect(new TyrionFinanceReviewClient(TOKEN, fetchMock).prepareResearch({
      contractVersion: '1.0',
      vendorName: 'Invented Market',
      coarseLocation: null,
      sensitiveContext: null,
      disclosure: { shown: false, confirmedAt: null },
    })).rejects.toMatchObject({ code: 'invalid_contract', status: 502 });
  });

  it('uses the separate advisory rule-suggestion operation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      policyVersion: 7,
      suggestion: {
        kind: 'merchant',
        merchantPattern: 'INVENTED MARKET',
        kidId: 'opaque-kid-ref',
        confidence: 'likely',
        requiresConfirmation: true,
      },
    }), { status: 200 }));

    const response = await new TyrionFinanceReviewClient(TOKEN, fetchMock).suggestRule({
      contractVersion: '1.0',
      merchantName: 'Invented Market',
      kidId: 'opaque-kid-ref',
      suggestReusableRule: true,
    });

    expect(response.suggestion?.requiresConfirmation).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/rule-suggestion');
  });

  it('creates a confirmed merchant rule through the exact v2 private endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '2.0',
      outcome: 'created',
      policyVersion: 8,
      rule: {
        id: 'rule-merchant-invented',
        outcome: 'kid',
        kidId: 'kid-alex',
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        scope: 'accounts',
        accountRefs: ['account-current'],
        confidence: 'likely',
        enabled: true,
      },
    }), { status: 200 }));

    const result = await new TyrionFinanceReviewClient(TOKEN, fetchMock).createMerchantRule({
      contractVersion: '2.0',
      expectedPolicyVersion: 7,
      idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
      confirmation: {
        confirmed: true,
        confirmedAt: '2026-10-09T20:00:00.000-04:00',
      },
      rule: {
        outcome: 'kid',
        kidId: 'kid-alex',
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        scope: 'accounts',
        accountRefs: ['account-current'],
        confidence: 'likely',
      },
    });

    expect(result.policyVersion).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://tyrion-operations-ui:3000/api/internal/v2/attribution/rules',
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedPolicyVersion: 7,
      rule: { accountRefs: ['account-current'] },
    });
  });

  it('rejects a merchant rule response that changes the confirmed scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '2.0',
      outcome: 'created',
      policyVersion: 8,
      rule: {
        id: 'rule-merchant-invented',
        outcome: 'review',
        kidId: null,
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        scope: 'global',
        accountRefs: [],
        confidence: 'likely',
        enabled: true,
      },
    }), { status: 200 }));

    await expect(new TyrionFinanceReviewClient(TOKEN, fetchMock).createMerchantRule({
      contractVersion: '2.0',
      expectedPolicyVersion: 7,
      idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
      confirmation: { confirmed: true, confirmedAt: '2026-10-09T20:00:00.000-04:00' },
      rule: {
        outcome: 'review',
        kidId: null,
        pattern: 'INVENTED MARKET',
        businessEntityPattern: null,
        scope: 'accounts',
        accountRefs: ['account-current'],
        confidence: 'likely',
      },
    })).rejects.toMatchObject({ code: 'invalid_contract', status: 502 });
  });
});
