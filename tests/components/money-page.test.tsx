import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FinancePage from '@/app/finance/page';

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
    total: 5,
    pendingExceptions: 2,
    retryRequested: 1,
    failedWritebacks: 1,
    openAlerts: 1,
  },
  alerts: [{
    title: 'Allowance needs attention',
    summary: 'A household obligation is due.',
    level: 'action_needed',
    receivedAt: '2026-08-08T12:00:00.000Z',
  }],
  subjects: [{ kidId: 'kid-one', name: 'Alex', policyStatus: 'current', limitStatus: 'unavailable' }],
  digest: [
    '2 attribution exceptions need review',
    '1 Monarch write-back has failed',
    '1 finance alert is open',
  ],
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

const health = {
  overall: 'degraded',
  bridge: { reachable: true, authenticated: false, authState: 'expired', mode: 'live' },
  sync: {
    status: 'succeeded',
    lastSuccessfulSyncAt: '2026-08-08T11:00:00.000Z',
    freshnessMinutes: 120,
    stale: true,
    lastErrorCode: null,
    activeJob: null,
  },
  attribution: {
    status: 'degraded',
    lastSuccessfulAt: '2026-08-08T10:00:00.000Z',
    policyVersion: 7,
    engineVersion: '1.0.0',
  },
  projection: {
    aggregate: 'partial',
    datasets: [
      {
        dataset: 'accounts',
        provenance: 'monarch-bridge',
        state: 'fresh',
        itemCount: 4,
        sourceLimit: 1_000,
        coverage: null,
        lastAttemptAt: '2026-08-08T12:01:00.000Z',
        lastSuccessfulAt: '2026-08-08T12:01:00.000Z',
        sourceAsOf: '2026-08-08T12:00:00.000Z',
        freshUntil: '2026-08-09T12:00:00.000Z',
        generationId: 'private-generation-account',
        schemaVersion: '1.0',
        configVersion: 1,
        warning: null,
      },
      {
        dataset: 'category-groups',
        provenance: 'monarch-bridge',
        state: 'fresh',
        itemCount: 0,
        sourceLimit: 250,
        coverage: null,
        lastAttemptAt: '2026-08-08T12:01:00.000Z',
        lastSuccessfulAt: '2026-08-08T12:01:00.000Z',
        sourceAsOf: '2026-08-08T12:00:00.000Z',
        freshUntil: '2026-08-09T12:00:00.000Z',
        generationId: 'private-generation-category-groups',
        schemaVersion: '1.0',
        configVersion: 1,
        warning: null,
      },
      {
        dataset: 'categories',
        provenance: 'monarch-bridge',
        state: 'stale',
        itemCount: 18,
        sourceLimit: 2_000,
        coverage: null,
        lastAttemptAt: '2026-08-08T12:01:00.000Z',
        lastSuccessfulAt: '2026-08-07T12:01:00.000Z',
        sourceAsOf: '2026-08-07T12:00:00.000Z',
        freshUntil: '2026-08-08T12:00:00.000Z',
        generationId: 'private-generation-categories',
        schemaVersion: '1.0',
        configVersion: 1,
        warning: null,
      },
      {
        dataset: 'tags',
        provenance: 'monarch-bridge',
        state: 'partial',
        itemCount: 7,
        sourceLimit: 1_000,
        coverage: null,
        lastAttemptAt: '2026-08-08T12:01:00.000Z',
        lastSuccessfulAt: '2026-08-08T11:01:00.000Z',
        sourceAsOf: '2026-08-08T11:00:00.000Z',
        freshUntil: '2026-08-09T11:00:00.000Z',
        generationId: 'private-generation-tags',
        schemaVersion: '1.0',
        configVersion: 1,
        warning: 'invalid_contract',
      },
      {
        dataset: 'recurring',
        provenance: 'monarch-bridge',
        state: 'unavailable',
        itemCount: 0,
        sourceLimit: 5_000,
        coverage: null,
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        sourceAsOf: null,
        freshUntil: null,
        generationId: null,
        schemaVersion: '1.0',
        configVersion: 1,
        warning: null,
      },
      {
        dataset: 'budgets',
        provenance: 'monarch-bridge',
        state: 'fresh',
        itemCount: 1,
        sourceLimit: 5_000,
        coverage: { start: '2026-08-01', end: '2026-08-31' },
        lastAttemptAt: '2026-08-08T12:01:00.000Z',
        lastSuccessfulAt: '2026-08-08T12:01:00.000Z',
        sourceAsOf: '2026-08-08T12:00:00.000Z',
        freshUntil: '2026-08-08T18:00:00.000Z',
        generationId: 'private-generation-budget',
        schemaVersion: '1.0',
        configVersion: 1,
        warning: null,
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FinancePage', () => {
  it('shows bounded attention, distinct health, safe deep links, and no ledger', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse(health));
    vi.stubGlobal('fetch', fetchMock);

    render(<FinancePage />);

    expect(await screen.findByRole('heading', { name: 'Finance' })).toBeInTheDocument();
    expect(screen.getByText('Powered by')).toBeInTheDocument();
    expect(screen.getAllByText('Tyrion').length).toBeGreaterThan(0);
    expect(screen.getByText('Allowance needs attention')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Policy current · Limit unavailable')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bridge reachability' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connector credentials' })).toBeInTheDocument();
    expect(screen.getByText('Authentication Required')).toBeInTheDocument();
    const transactionSnapshot = screen.getByRole('heading', { name: 'Transaction snapshot sync' })
      .closest('article');
    expect(transactionSnapshot).not.toBeNull();
    expect(within(transactionSnapshot!).getByText('Stale')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tyrion attribution' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Projection dataset health' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Configure money policies in Tyrion/ }))
      .toHaveAttribute('href', 'https://tyrion.example/configuration');
    expect(screen.getByRole('link', { name: /transactions/i }))
      .toHaveAttribute('href', 'https://app.monarchmoney.com/transactions');
    expect(screen.queryByText('Recent transactions')).not.toBeInTheDocument();
    expect(screen.queryByText('Spent this month')).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('renders all six projection states, authoritative empty, timestamps, coverage, and safe warnings', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse(health)));

    render(<FinancePage />);

    const accounts = await screen.findByRole('article', { name: 'Accounts projection health' });
    expect(within(accounts).getByText('Fresh with data')).toBeInTheDocument();
    expect(within(accounts).getByText('4 items')).toBeInTheDocument();
    expect(within(accounts).getByText('Source as of')).toBeInTheDocument();
    expect(within(accounts).getByText('Fresh until')).toBeInTheDocument();
    expect(within(accounts).getByText('Last successful')).toBeInTheDocument();
    expect(within(accounts).getAllByRole('time')).toHaveLength(3);

    const categoryGroups = screen.getByRole('article', { name: 'Category groups projection health' });
    expect(within(categoryGroups).getByText('Fresh and empty')).toBeInTheDocument();
    expect(within(categoryGroups).getByText('0 items')).toBeInTheDocument();
    expect(within(categoryGroups).getByText('Current authoritative result contains no items.'))
      .toBeInTheDocument();

    const categories = screen.getByRole('article', { name: 'Categories projection health' });
    expect(within(categories).getByText('Stale')).toBeInTheDocument();
    expect(within(categories).getByText(/outside its freshness window/)).toBeInTheDocument();

    const tags = screen.getByRole('article', { name: 'Tags projection health' });
    expect(within(tags).getByText('Partial')).toBeInTheDocument();
    expect(within(tags).getByText(/incompatible or oversized dataset contract/)).toBeInTheDocument();
    expect(within(tags).queryByText('invalid_contract')).not.toBeInTheDocument();

    const recurring = screen.getByRole('article', { name: 'Recurring projection health' });
    expect(within(recurring).getAllByText('Unavailable')).toHaveLength(2);
    expect(within(recurring).getByText('Item count').nextSibling).toHaveTextContent('Unavailable');
    expect(within(recurring).getAllByText('Not available')).toHaveLength(3);

    const budgets = screen.getByRole('article', { name: 'Budgets projection health' });
    expect(within(budgets).getByText('1 item')).toBeInTheDocument();
    expect(within(budgets).getByText('2026-08-01 to 2026-08-31')).toBeInTheDocument();

    expect(screen.getByText('Projection coverage is mixed or a later dataset attempt failed.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/private-generation/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /full refresh|retry projection/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open connector operations' }))
      .toHaveAttribute('href', '/settings/connectors');
  });

  it('falls back safely when projection metadata is missing or malformed', async () => {
    const malformedHealth = {
      ...health,
      projection: {
        aggregate: 'private aggregate error',
        datasets: [{
          ...health.projection.datasets[0],
          warning: 'token=private-finance-secret',
          sourceAsOf: 'not-a-timestamp',
          freshUntil: null,
          lastSuccessfulAt: null,
        }, {
          ...health.projection.datasets[1],
          dataset: 'private-dataset-id',
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse(malformedHealth)));

    render(<FinancePage />);

    const accounts = await screen.findByRole('article', { name: 'Accounts projection health' });
    expect(within(accounts).getByText('The latest dataset attempt did not complete.')).toBeInTheDocument();
    expect(within(accounts).getAllByText('Not available')).toHaveLength(3);
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText(/private-finance-secret|private-dataset-id|private aggregate error/))
      .not.toBeInTheDocument();
  });

  it('preserves overview data when canonical health is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockResolvedValueOnce(jsonResponse({}, 503)));

    render(<FinancePage />);

    expect(await screen.findByText('Allowance needs attention')).toBeInTheDocument();
    expect(screen.getByText(
      'Health details are temporarily unavailable. Finance attention data may be partial.',
    )).toBeInTheDocument();
  });

  it('renders overview data before the canonical health request settles', async () => {
    let resolveHealth: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveHealth = resolve;
      })));

    render(<FinancePage />);

    expect(await screen.findByText('Allowance needs attention')).toBeInTheDocument();
    expect(screen.getByText('Loading canonical health details…')).toBeInTheDocument();
    resolveHealth?.(jsonResponse(health));
    expect(await screen.findByRole('heading', { name: 'Bridge reachability' })).toBeInTheDocument();
  });

  it('preserves overview data when the canonical health request rejects', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(overview))
      .mockRejectedValueOnce(new TypeError('network unavailable')));

    render(<FinancePage />);

    expect(await screen.findByText('Allowance needs attention')).toBeInTheDocument();
    expect(await screen.findByText(
      'Health details are temporarily unavailable. Finance attention data may be partial.',
    )).toBeInTheDocument();
  });

  it('shows bounded forbidden and retryable failure states', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<FinancePage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Finance access is restricted to the parent administrator.',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    rerender(<FinancePage key="retryable" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Finance operations could not be loaded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
