import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceQuickReview } from '@/components/finance/FinanceQuickReview';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const item = {
  reviewRef: 'review_ref_1234567890',
  stateToken: 'state_token_123456789',
  date: '2026-10-08',
  amount: -184.62,
  currency: 'USD',
  accountName: 'Household card',
  payee: 'Invented Market',
  category: { id: 'category-groceries', label: 'Groceries' },
  kid: null,
  monarchReview: { status: 'needs-review', assignedTo: 'Parent' },
  whySelected: ['High amount with low Kids attribution confidence.'],
  confidence: { overall: 0.52, kids: 0.31, category: 0.81, payee: 0.64 },
  corrections: {
    kids: [{ id: 'kid-alex', label: 'Alex' }],
    categories: [
      { id: 'category-groceries', label: 'Groceries' },
      { id: 'category-school', label: 'School' },
    ],
    payeeSuggestions: ['Invented Market'],
    maySuggestKidRule: true,
  },
  research: {
    recommended: true,
    reason: 'The vendor is unfamiliar and the amount is high.',
    normalizedVendorName: 'Invented Market',
    coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
  },
};

const session = {
  contractVersion: '1.0',
  sessionRef: 'session_ref_123456789',
  resumeToken: 'resume_token_123456789',
  sourceAsOf: '2026-10-08T20:00:00.000Z',
  mode: 'ranked',
  filters: {
    preset: 'impact-confidence',
    startDate: null,
    endDate: null,
    minimumAmount: null,
    maximumAmount: null,
    accountNames: [],
  },
  progress: { reviewed: 0, skipped: 0, total: 3, remaining: 3 },
  current: item,
  accounts: ['Household card', 'Checking'],
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('FinanceQuickReview', () => {
  it('renders ranked context and confirms through Tyrion with Monarch review semantics', async () => {
    const completed = {
      ...session,
      progress: { reviewed: 1, skipped: 0, total: 3, remaining: 2 },
      current: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response(completed));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);

    expect(await screen.findByRole('heading', { name: 'Invented Market' })).toBeInTheDocument();
    expect(screen.getByText('$184.62')).toBeInTheDocument();
    expect(screen.getByText('Needs review · Assigned to Parent')).toBeInTheDocument();
    expect(screen.getByText('High amount with low Kids attribution confidence.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));

    await screen.findByRole('heading', { name: 'Review complete' });
    const action = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(action).toMatchObject({
      action: 'confirm',
      monarchReviewOutcome: 'reviewed',
      correction: null,
      reviewRef: item.reviewRef,
      stateToken: item.stateToken,
    });
    expect(action.idempotencyKey).toEqual(expect.any(String));
  });

  it('submits corrections before Monarch is marked reviewed', async () => {
    const next = {
      ...session,
      progress: { reviewed: 1, skipped: 0, total: 3, remaining: 2 },
      current: { ...item, reviewRef: 'review_ref_0987654321' },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response(next));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByLabelText('Kids attribution'));
    fireEvent.click(screen.getByRole('option', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const action = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(action).toMatchObject({
      action: 'correct',
      monarchReviewOutcome: 'reviewed',
      correction: {
        kidId: 'kid-alex',
        categoryId: 'category-groceries',
        payee: 'Invented Market',
      },
    });
  });

  it('previews a reusable Kids rule separately without applying it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({
        contractVersion: '1.0',
        suggestion: {
          kind: 'merchant',
          merchantPattern: 'INVENTED MARKET',
          businessEntityPattern: 'INVENTED MARKET HOLDINGS',
          kidId: 'kid-alex',
          confidence: 'likely',
          requiresConfirmation: true,
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByLabelText('Kids attribution'));
    fireEvent.click(screen.getByRole('option', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview reusable rule' }));

    expect(await screen.findByText(/This advisory has not been applied/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Business entity pattern/)).toHaveValue('INVENTED MARKET HOLDINGS');
    const request = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(request).toEqual({
      contractVersion: '1.0',
      sessionRef: session.sessionRef,
      resumeToken: session.resumeToken,
      reviewRef: item.reviewRef,
      stateToken: item.stateToken,
      merchantName: 'Invented Market',
      kidId: 'kid-alex',
      suggestReusableRule: true,
    });
  });

  it('creates an account-scoped rule independently without exposing account references', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({
        contractVersion: '1.0',
        suggestion: {
          kind: 'merchant',
          merchantPattern: 'INVENTED MARKET',
          businessEntityPattern: null,
          kidId: 'kid-alex',
          confidence: 'likely',
          requiresConfirmation: true,
        },
      }))
      .mockResolvedValueOnce(response({
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
          confidence: 'likely',
          enabled: true,
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByLabelText('Kids attribution'));
    fireEvent.click(screen.getByRole('option', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview reusable rule' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create confirmed rule' }));

    expect(await screen.findByText('Rule created')).toBeInTheDocument();
    const request = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(request).toMatchObject({
      contractVersion: '2.0',
      sessionRef: session.sessionRef,
      resumeToken: session.resumeToken,
      reviewRef: item.reviewRef,
      stateToken: item.stateToken,
      confirmation: {
        confirmed: true,
        globalScopeConfirmed: false,
      },
      rule: {
        outcome: 'kid',
        kidId: 'kid-alex',
        pattern: 'INVENTED MARKET',
        scope: 'accounts',
      },
    });
    expect(request.rule).not.toHaveProperty('accountRefs');
    expect(request).not.toHaveProperty('expectedPolicyVersion');
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('requires a conspicuous additional confirmation for global rules', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({
        contractVersion: '1.0',
        suggestion: {
          kind: 'merchant',
          merchantPattern: 'INVENTED MARKET',
          businessEntityPattern: null,
          kidId: 'kid-alex',
          confidence: 'likely',
          requiresConfirmation: true,
        },
      }))
      .mockResolvedValueOnce(response({
        contractVersion: '2.0',
        outcome: 'created',
        policyVersion: 8,
        rule: {
          id: 'rule-merchant-global',
          outcome: 'review',
          kidId: null,
          pattern: 'INVENTED MARKET',
          businessEntityPattern: null,
          scope: 'global',
          confidence: 'likely',
          enabled: true,
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByLabelText('Kids attribution'));
    fireEvent.click(screen.getByRole('option', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview reusable rule' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Outcome' }));
    fireEvent.click(screen.getByRole('option', { name: 'Send to review' }));
    fireEvent.click(screen.getByRole('radio', { name: /All accounts/ }));

    const createButton = screen.getByRole('button', { name: 'Create confirmed rule' });
    expect(createButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {
      name: /apply to matching merchants on every household account/i,
    }));
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    expect(await screen.findByText('Rule created')).toBeInTheDocument();
    const request = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(request).toMatchObject({
      confirmation: { globalScopeConfirmed: true },
      rule: { outcome: 'review', kidId: null, scope: 'global' },
    });
  });

  it('keeps default vendor research public context free of amount and date', async () => {
    const research = {
      contractVersion: '1.0',
      reviewRef: item.reviewRef,
      researchedAt: '2026-10-08T21:00:00.000Z',
      facts: [{
        statement: 'Invented Market publishes a Seattle location.',
        confidence: 0.92,
        sourceIds: ['source-one'],
      }],
      inferences: [{
        statement: 'The purchase may be household supplies.',
        confidence: 0.51,
        sourceIds: [],
      }],
      suggestions: {
        businessIdentity: 'Invented Market LLC',
        location: 'Seattle, WA',
        businessType: 'Retail',
        plausiblePurchase: 'Household supplies',
        category: 'Shopping',
        kidsClues: [],
      },
      riskIndicators: [],
      sources: [{
        id: 'source-one',
        title: 'Invented Market locations',
        url: 'https://example.test/invented-market',
        publisher: 'Example Directory',
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response(research));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: 'Research vendor' }));

    expect(await screen.findByRole('heading', { name: 'Research result' })).toBeInTheDocument();
    expect(screen.getByText('Invented Market publishes a Seattle location.')).toBeInTheDocument();
    const request = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(request.publicContext).toEqual({
      normalizedVendorName: 'Invented Market',
      coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
      amount: null,
      date: null,
      sensitiveContextApproved: false,
    });
  });

  it('requires a visible disclosure before sharing amount and date for research', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(session));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByLabelText('Include amount and date when materially useful'));
    fireEvent.click(screen.getByRole('button', { name: 'Research vendor' }));

    const disclosure = screen.getByRole('alertdialog');
    expect(disclosure).toHaveTextContent('$184.62');
    expect(disclosure).toHaveTextContent('It will not include account/card details');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(disclosure).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('fails honestly when the Tyrion contract is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: 'Tyrion does not yet provide the finance quick review contract',
      code: 'review_contract_unavailable',
      retryable: false,
    }, 501)));

    render(<FinanceQuickReview />);

    expect(await screen.findByRole('heading', {
      name: 'Tyrion quick review is not available yet',
    })).toBeInTheDocument();
    expect(screen.getByText(/did not create sample transactions/i)).toBeInTheDocument();
  });

  it('recovers from an expired resume token by starting a new session', async () => {
    sessionStorage.setItem('mc.financeQuickReview.resume.v1', JSON.stringify({
      resumeToken: 'expired_resume_token_123',
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        error: 'Review session expired',
        code: 'review_session_expired',
        retryable: false,
      }, 409))
      .mockResolvedValueOnce(response(session));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceQuickReview />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start new session' }));

    expect(await screen.findByRole('heading', { name: 'Invented Market' })).toBeInTheDocument();
    const request = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(request.resumeToken).toBeNull();
  });
});
