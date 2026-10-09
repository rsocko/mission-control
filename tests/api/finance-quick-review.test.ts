import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trustedRead: vi.fn(),
  trustedMutation: vi.fn(),
  startSession: vi.fn(),
  applyAction: vi.fn(),
  prepareResearch: vi.fn(),
  researchContext: vi.fn(),
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
}));

vi.mock('@/lib/connectors/monarch-money/quick-review-client', () => ({
  TyrionFinanceReviewError: class TyrionFinanceReviewError extends Error {},
  TyrionFinanceReviewClient: class TyrionFinanceReviewClient {
    prepareResearch = mocks.prepareResearch;
  },
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

  it('returns an explicit provider dependency after privacy-safe preparation', async () => {
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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'vendor_research_provider_unavailable',
    });
  });
});
