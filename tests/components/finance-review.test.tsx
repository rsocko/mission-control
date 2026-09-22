import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      }))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: 'next-page',
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

    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    expect(await screen.findByRole('button', { name: /Invented Cafe/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls[2][0]).toContain('cursor=next-page');
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByRole('button', { name: /Invented Market/ })).toBeInTheDocument();
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
    fireEvent.click(screen.getByLabelText('Manual correction'));
    fireEvent.click(screen.getByRole('option', { name: 'Jordan' }));
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

  it('keeps previous-page recovery available when a later page becomes empty', async () => {
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
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'resolved' }))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: 'next-page',
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load next page' }));
    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Select all 1 Invented Cafe exceptions',
    }));
    fireEvent.click(screen.getByLabelText('Assign selected to'));
    fireEvent.click(screen.getByRole('option', { name: 'Parent expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Assign selected',
    }));

    const emptyPageHeading = await screen.findByRole('heading', {
      name: 'No exceptions remain on this page',
    });
    await waitFor(() => expect(emptyPageHeading).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByRole('button', { name: /Invented Market/ })).toBeInTheDocument();
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

  it('groups normalized merchants and assigns a selected group to the parent with one confirmation', async () => {
    const normalizedVariant = {
      ...secondException,
      merchantName: '  Invented\u000b  Market  ',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException, normalizedVariant],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'resolved' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'resolved' }))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [],
        subjects,
        nextCursor: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);

    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Select all 2 Invented Market exceptions',
    }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Assign selected to'));
    fireEvent.click(screen.getByRole('option', { name: 'Parent expense' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected' }));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('2 selected exceptions');
    expect(dialog).toHaveTextContent('parent expense');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign selected' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const posts = fetchMock.mock.calls.filter((call) => (
      (call[1] as RequestInit | undefined)?.method === 'POST'
    ));
    expect(posts).toHaveLength(2);
    expect(posts.map((call) => JSON.parse((call[1] as RequestInit).body as string))).toEqual(
      expect.arrayContaining([
        {
          action: 'manual-resolve',
          kidId: null,
          expectedUpdatedAt: firstException.updatedAt,
        },
        {
          action: 'manual-resolve',
          kidId: null,
          expectedUpdatedAt: normalizedVariant.updatedAt,
        },
      ]),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Assignment complete: 2 succeeded, 0 conflicted, 0 failed.',
    );
  });

  it('supports individual selection and enforces the 100-item selection cap', async () => {
    const cappedExceptions = Array.from({ length: 101 }, (_, index) => ({
      ...firstException,
      id: `capped-${index}`,
      merchantName: 'Capped Merchant',
    }));
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: cappedExceptions,
        subjects,
        nextCursor: null,
      })));

    render(<FinanceReview />);

    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Select all 101 Capped Merchant exceptions',
    }));
    expect(screen.getByText('100 selected')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Selection is limited to 100 exceptions on this page.',
    );

    fireEvent.click(screen.getAllByRole('checkbox', {
      name: `Deselect Capped Merchant on ${new Date('2026-08-08T00:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`,
    })[0]);
    expect(screen.getByText('99 selected')).toBeInTheDocument();
  });

  it('clears recipients removed from the authoritative subject projection', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({
        exceptions: [firstException],
        subjects: [subjects[0]],
        nextCursor: null,
      })));

    render(<FinanceReview />);

    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Select all 1 Invented Market exceptions',
    }));
    fireEvent.click(screen.getByLabelText('Manual correction'));
    fireEvent.click(screen.getByRole('option', { name: 'Jordan' }));
    fireEvent.click(screen.getByLabelText('Assign selected to'));
    fireEvent.click(screen.getByRole('option', { name: 'Jordan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Assign selected',
    }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'Assignment complete: 0 succeeded, 0 conflicted, 1 failed.',
    ));
    expect(screen.getByLabelText('Assign selected to')).toHaveTextContent(
      'Choose a current subject',
    );
    expect(screen.getByRole('button', { name: 'Assign selected' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Manual correction' })).toHaveTextContent(
      'Choose a current subject',
    );
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  });

  it('bounds kid assignment fan-out and preserves only retryable request identities', async () => {
    const batchExceptions = Array.from({ length: 6 }, (_, index) => ({
      ...firstException,
      id: `batch-${index + 1}`,
      merchantName: 'Batch Merchant',
    }));
    const unresolved = batchExceptions.slice(1, 4).map((item) => ({
      ...item,
      updatedAt: '2026-08-08T13:00:00.000Z',
    }));
    const attempts = new Map<string, number>();
    const keys = new Map<string, string[]>();
    const expectedTimestamps = new Map<string, string[]>();
    let exceptionReads = 0;
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/finance/overview') return jsonResponse(overview);
      if (init?.method !== 'POST') {
        exceptionReads += 1;
        return jsonResponse({
          exceptions: exceptionReads === 1
            ? batchExceptions
            : exceptionReads === 2
              ? unresolved
              : [],
          subjects,
          nextCursor: null,
        });
      }
      const exceptionId = batchExceptions.find((item) => url.endsWith(`/${item.id}`))?.id;
      if (!exceptionId) throw new Error('Unexpected exception request');
      const headers = init.headers as Record<string, string>;
      keys.set(exceptionId, [...(keys.get(exceptionId) ?? []), headers['Idempotency-Key']]);
      const body = JSON.parse(init.body as string) as { expectedUpdatedAt: string };
      expectedTimestamps.set(exceptionId, [
        ...(expectedTimestamps.get(exceptionId) ?? []),
        body.expectedUpdatedAt,
      ]);
      const attempt = (attempts.get(exceptionId) ?? 0) + 1;
      attempts.set(exceptionId, attempt);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (attempt > 1) return jsonResponse({ status: 'resolved' });
      if (exceptionId === 'batch-2') return jsonResponse({ code: 'stale_state' }, 409);
      if (exceptionId === 'batch-3') return jsonResponse({}, 503);
      if (exceptionId === 'batch-4') throw new TypeError('Network unavailable');
      return jsonResponse({ status: 'resolved' });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FinanceReview />);

    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Select all 6 Batch Merchant exceptions',
    }));
    fireEvent.click(screen.getByLabelText('Assign selected to'));
    fireEvent.click(screen.getByRole('option', { name: 'Jordan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign selected' }));
    let dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('6 selected exceptions');
    expect(dialog).toHaveTextContent('Jordan');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign selected' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(
      'Assignment complete: 3 succeeded, 1 conflicted, 2 failed.',
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign selected' })).toBeEnabled());
    expect(maximumActive).toBe(4);
    expect(exceptionReads).toBe(2);
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', {
      name: /Batch Merchant/,
    })[0]).toHaveFocus());
    expect(screen.queryByText('batch-2')).not.toBeInTheDocument();
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign selected' }));
    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('3 selected exceptions');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign selected' }));

    await waitFor(() => expect(screen.getByRole('heading', {
      name: 'No exceptions need review',
    })).toBeInTheDocument());
    expect(exceptionReads).toBe(3);
    expect(keys.get('batch-2')?.[1]).not.toBe(keys.get('batch-2')?.[0]);
    expect(keys.get('batch-3')?.[1]).toBe(keys.get('batch-3')?.[0]);
    expect(keys.get('batch-4')?.[1]).toBe(keys.get('batch-4')?.[0]);
    expect(expectedTimestamps.get('batch-2')).toEqual([
      firstException.updatedAt,
      '2026-08-08T13:00:00.000Z',
    ]);
    expect(expectedTimestamps.get('batch-3')).toEqual([
      firstException.updatedAt,
      firstException.updatedAt,
    ]);
    expect(expectedTimestamps.get('batch-4')).toEqual([
      firstException.updatedAt,
      firstException.updatedAt,
    ]);
    expect(screen.getByRole('heading', { name: 'No exceptions need review' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Assignment complete: 3 succeeded, 0 conflicted, 0 failed.',
    );
  });
});
