import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinanceReview } from '@/components/finance/FinanceReview';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const overview = {
  connectors: [{ id: 'finance-one', name: 'Tyrion' }],
  connector: { id: 'finance-one', name: 'Tyrion' },
  attention: {
    total: 1,
    pendingExceptions: 1,
    retryRequested: 0,
    failedWritebacks: 0,
    openAlerts: 0,
  },
  alerts: [],
  subjects: [],
  digest: [],
  links: {
    monarch: {
      transactions: 'https://app.monarchmoney.com/transactions',
      budgets: 'https://app.monarchmoney.com/plan',
      recurring: 'https://app.monarchmoney.com/recurring',
      reports: 'https://app.monarchmoney.com/reports',
      accounts: 'https://app.monarchmoney.com/accounts',
      investments: 'https://app.monarchmoney.com/investments',
      goals: 'https://app.monarchmoney.com/goals',
      forecasts: 'https://app.monarchmoney.com/plan',
    },
    tyrionConfiguration: 'https://tyrion.example/configuration',
  },
};

const firstException = {
  id: 'exception-one',
  status: 'open',
  reasonCode: 'low-confidence',
  retryable: true,
  reviewState: 'pending',
  policyVersion: 7,
  occurrenceCount: 1,
  firstObservedAt: '2026-08-08T10:00:00.000Z',
  lastObservedAt: '2026-08-08T12:00:00.000Z',
  updatedAt: '2026-08-08T12:00:00.000Z',
  date: '2026-08-08',
  merchantName: 'Invented Market',
  assignedKidId: 'kid-one',
  attributionStatus: 'attributed',
  confidence: 'likely',
  method: 'merchant-rule',
  explanation: 'Two current rules produced similar matches.',
  reasons: ['low-confidence', 'merchant-rule-conflict'],
  decisionSource: 'automated',
  evaluatedAt: '2026-08-08T12:00:00.000Z',
};

const secondException = {
  ...firstException,
  id: 'exception-two',
  merchantName: 'Invented Cafe',
  date: '2026-08-07',
};

const subjects = [
  { kidId: 'kid-one', name: 'Alex' },
  { kidId: 'kid-two', name: 'Jordan' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FinanceReview', () => {
  it('renders bounded master-detail data and paginates without ledger identifiers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: 'next-page',
      }))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [secondException],
        subjects,
        nextCursor: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);

    expect(await screen.findByRole('heading', { name: 'Attribution exception review' })).toBeInTheDocument();
    expect(screen.getAllByText('Invented Market').length).toBeGreaterThan(0);
    expect(screen.getByText('Two current rules produced similar matches.')).toBeInTheDocument();
    expect(screen.getByText('Likely')).toBeInTheDocument();
    expect(screen.getAllByText('Alex').length).toBeGreaterThan(0);
    expect(screen.queryByText('exception-one')).not.toBeInTheDocument();
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: /Invented Cafe/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls[2][0]).toContain('cursor=next-page');
  });

  it('submits a confirmed manual correction with an idempotency key and restores list focus', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException, secondException],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'resolved', exceptionId: 'exception-one' }))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [secondException],
        subjects,
        nextCursor: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);
    await screen.findByRole('heading', { name: 'Invented Market' });
    fireEvent.change(screen.getByLabelText('Manual correction'), { target: { value: 'kid-two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Jordan');
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const postCall = fetchMock.mock.calls[2];
    expect(postCall[0]).toContain('/exception-one');
    expect(postCall[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Idempotency-Key': expect.any(String),
      }),
      body: JSON.stringify({
        action: 'manual-resolve',
        kidId: 'kid-two',
        expectedUpdatedAt: firstException.updatedAt,
      }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Invented Cafe/ })).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Attribution decision saved.');
  });

  it('reuses the same idempotency key across retryable failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);
    const retry = await screen.findByRole('button', { name: 'Retry attribution' });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('failed temporarily'));
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const firstKey = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>;
    const secondKey = (fetchMock.mock.calls[3][1] as RequestInit).headers as Record<string, string>;
    expect(firstKey['Idempotency-Key']).toBe(secondKey['Idempotency-Key']);
  });

  it('restores focus when a confirmation is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: null,
      })));

    render(<FinanceReview />);
    const approve = await screen.findByRole('button', { name: 'Approve suggestion' });
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(approve).toHaveFocus());
  });

  it('announces conflicts and refreshes from the authoritative projection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 'manual_decision_superseded' }, 409))
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [],
        subjects,
        nextCursor: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve suggestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByRole('heading', { name: 'No exceptions need review' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('A newer decision already changed this item.');
  });
});
