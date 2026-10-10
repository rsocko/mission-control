import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trustedRead: vi.fn(),
  trustedMutation: vi.fn(),
  startSession: vi.fn(),
  applyAction: vi.fn(),
  prepareResearch: vi.fn(),
  researchContext: vi.fn(),
  researchVendor: vi.fn(),
  previewRule: vi.fn(),
  createRule: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/finance-request', () => ({
  isTrustedFinanceReadRequest: mocks.trustedRead,
  trustedFinanceMutationActor: mocks.trustedMutation,
}));

vi.mock('@/lib/finance/quick-review-service', () => ({
  QuickReviewSessionError: class QuickReviewSessionError extends Error {},
  startQuickReviewSession: mocks.startSession,
  applyQuickReviewAction: mocks.applyAction,
  getQuickReviewResearchContext: mocks.researchContext,
  previewQuickReviewMerchantRule: mocks.previewRule,
  createQuickReviewMerchantRule: mocks.createRule,
}));

vi.mock('@/lib/connectors/monarch-money/quick-review-client', () => ({
  TyrionFinanceReviewError: class TyrionFinanceReviewError extends Error {},
  TyrionFinanceReviewClient: class TyrionFinanceReviewClient {
    prepareResearch = mocks.prepareResearch;
  },
}));

vi.mock('@/lib/finance/vendor-research', () => ({
  VendorResearchError: class VendorResearchError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
      readonly retryable: boolean,
    ) {
      super(message);
    }
  },
  researchVendor: mocks.researchVendor,
}));

const filters = {
  preset: 'impact-confidence',
  startDate: null,
  endDate: null,
  minimumAmount: null,
  maximumAmount: null,
  accountNames: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustedRead.mockReturnValue(true);
  mocks.trustedMutation.mockReturnValue('parent-admin');
  mocks.researchContext.mockReturnValue({
    vendorName: 'Invented Market',
    coarseLocation: null,
    amount: 184.62,
    occurredOn: '2026-10-08',
  });
  mocks.researchVendor.mockResolvedValue({
    contractVersion: '1.0',
    reviewRef: 'review_ref_1234567890',
    researchedAt: '2026-10-08T21:00:00.000Z',
    facts: [],
    inferences: [],
    suggestions: {
      businessIdentity: null,
      location: null,
      businessType: null,
      plausiblePurchase: null,
      category: null,
      kidsClues: [],
    },
    riskIndicators: [],
    sources: [],
  });
});

describe('finance quick review API boundary', () => {
  it('starts a server-owned session with the typed request', async () => {
    mocks.startSession.mockResolvedValue({ contractVersion: '1.0', current: null });
    const { POST } = await import('@/app/api/finance/quick-review/session/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/session', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        mode: 'ranked',
        filters,
        resumeToken: null,
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'ranked', filters }),
      expect.any(AbortSignal),
    );
  });

  it('rejects an action that would incorrectly mutate Monarch review state', async () => {
    const { POST } = await import('@/app/api/finance/quick-review/actions/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/actions', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
        action: 'skip',
        monarchReviewOutcome: 'reviewed',
        correction: null,
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.applyAction).not.toHaveBeenCalled();
  });

  it('rejects amount/date research context without explicit approval', async () => {
    const { POST } = await import('@/app/api/finance/quick-review/research/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/research', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        request: null,
        publicContext: {
          normalizedVendorName: 'Invented Market',
          coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
          amount: 184.62,
          date: '2026-10-08',
          sensitiveContextApproved: false,
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.prepareResearch).not.toHaveBeenCalled();
  });

  it('executes sourced research after privacy-safe preparation', async () => {
    mocks.prepareResearch.mockResolvedValue({
      contractVersion: '1.0',
      query: {
        vendorName: 'Invented Market',
        coarseLocation: null,
        amount: null,
        occurredOn: null,
      },
      outputPolicy: {
        factsRequireSources: true,
        inferencesMustBeLabeled: true,
        fraudAssertionAllowed: false,
      },
    });
    const { POST } = await import('@/app/api/finance/quick-review/research/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/research', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        request: null,
        publicContext: {
          normalizedVendorName: 'Invented Market',
          coarseLocation: null,
          amount: null,
          date: null,
          sensitiveContextApproved: false,
        },
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reviewRef: 'review_ref_1234567890',
    });
    expect(mocks.researchVendor).toHaveBeenCalledWith({
      reviewRef: 'review_ref_1234567890',
      prepared: expect.objectContaining({
        query: expect.objectContaining({ vendorName: 'Invented Market' }),
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it('preserves an explicit unavailable response when web search is not configured', async () => {
    const { VendorResearchError } = await import('@/lib/finance/vendor-research');
    mocks.prepareResearch.mockResolvedValue({
      contractVersion: '1.0',
      query: {
        vendorName: 'Invented Market',
        coarseLocation: null,
        amount: null,
        occurredOn: null,
      },
      outputPolicy: {
        factsRequireSources: true,
        inferencesMustBeLabeled: true,
        fraudAssertionAllowed: false,
      },
    });
    mocks.researchVendor.mockRejectedValue(new VendorResearchError(
      'vendor_research_provider_unavailable',
      'Vendor research requires OpenAI web search',
      503,
      false,
    ));
    const { POST } = await import('@/app/api/finance/quick-review/research/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/research', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        request: null,
        publicContext: {
          normalizedVendorName: 'Invented Market',
          coarseLocation: null,
          amount: null,
          date: null,
          sensitiveContextApproved: false,
        },
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'vendor_research_provider_unavailable',
      retryable: false,
    });
  });

  it('binds rule preview to the active review session', async () => {
    mocks.previewRule.mockResolvedValue({
      contractVersion: '1.0',
      policyVersion: 7,
      suggestion: {
        kind: 'merchant',
        merchantPattern: 'INVENTED MARKET',
        businessEntityPattern: 'INVENTED MARKET HOLDINGS',
        kidId: 'kid-alex',
        confidence: 'likely',
        requiresConfirmation: true,
      },
    });
    const { POST } = await import('@/app/api/finance/quick-review/rule-suggestion/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/rule-suggestion', {
      method: 'POST',
      body: JSON.stringify({
        contractVersion: '1.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        merchantName: 'Invented Market',
        kidId: 'kid-alex',
        suggestReusableRule: true,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      contractVersion: '1.0',
      suggestion: expect.objectContaining({ merchantPattern: 'INVENTED MARKET' }),
    });
    expect(mocks.previewRule).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: 'session_ref_123456789',
        reviewRef: 'review_ref_1234567890',
      }),
      expect.any(AbortSignal),
    );
  });

  it('rejects browser-controlled account references on rule creation', async () => {
    const { POST } = await import('@/app/api/finance/quick-review/rules/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '2.0',
        sessionRef: 'session_ref_123456789',
        resumeToken: 'resume_token_123456789',
        reviewRef: 'review_ref_1234567890',
        stateToken: 'state_token_123456789',
        idempotencyKey: '4948bf5e-cd3d-47fe-8935-4e00949d1f3c',
        confirmation: {
          confirmed: true,
          confirmedAt: '2026-10-09T20:00:00.000-04:00',
          globalScopeConfirmed: false,
        },
        rule: {
          outcome: 'kid',
          kidId: 'kid-alex',
          pattern: 'INVENTED MARKET',
          businessEntityPattern: null,
          scope: 'accounts',
          accountRefs: ['browser-controlled-account'],
          confidence: 'likely',
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.createRule).not.toHaveBeenCalled();
  });

  it('rejects oversized merchant rule requests before parsing them', async () => {
    const { POST } = await import('@/app/api/finance/quick-review/rules/route');
    const response = await POST(new Request('https://mc.example/api/finance/quick-review/rules', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '70000',
      },
      body: '{}',
    }));

    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ code: 'payload_too_large' });
    expect(mocks.createRule).not.toHaveBeenCalled();
  });
});
