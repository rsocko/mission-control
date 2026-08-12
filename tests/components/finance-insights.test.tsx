import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FinancePage from '@/app/finance/page';
import {
  FinanceInsightDetailContent,
  FinanceInsightRoute,
} from '@/components/finance/FinanceInsightDetail';
import { SpendingInsightsSection } from '@/components/finance/SpendingInsightsSection';
import type {
  FinanceInsightDetailData,
  FinanceInsightsPresentationData,
} from '@/components/finance/types';
import type {
  InsightOccurrenceDetailV1,
  InsightOccurrenceSummaryV1,
} from '@/lib/finance-insights/contract';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fixtureDetail = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/fixtures/finance-insights/occurrence-detail.json'),
  'utf8',
)) as InsightOccurrenceDetailV1;

function summary(
  kind: InsightOccurrenceSummaryV1['kind'],
  marker: string,
  overrides: Partial<InsightOccurrenceSummaryV1> = {},
): InsightOccurrenceSummaryV1 {
  const value = structuredClone(fixtureDetail) as Record<string, unknown>;
  for (const field of [
    'ruleResults',
    'baseline',
    'comparisons',
    'contributors',
    'exclusions',
    'evidence',
    'lifecycleHistory',
    'suppression',
    'availableActions',
  ]) {
    delete value[field];
  }
  const entity = {
    recurringAmountChange: {
      kind: 'recurring',
      sourceRef: `invented-recurring-${marker}`,
      displayName: `Invented recurring ${marker}`,
      identityQuality: 'stableSource',
    },
    largeTransaction: {
      kind: 'transaction',
      sourceRef: `invented-transaction-${marker}`,
      displayName: `Invented transaction ${marker}`,
      identityQuality: 'stableSource',
    },
    categoryVariance: {
      kind: 'category',
      sourceRef: `invented-category-${marker}`,
      displayName: `Invented category ${marker}`,
      identityQuality: 'stableSource',
    },
    merchantVariance: {
      kind: 'merchant',
      sourceRef: `merchant-v1_${marker.repeat(43).slice(0, 43)}`,
      displayName: `Invented merchant ${marker}`,
      identityQuality: 'normalizedName',
    },
  } as const;
  return {
    ...(value as unknown as InsightOccurrenceSummaryV1),
    insightId: `insight-v1_${marker.repeat(43).slice(0, 43)}`,
    occurrenceId: `occurrence-v1_${marker.repeat(43).slice(0, 43)}`,
    kind,
    entity: entity[kind],
    headline: `Invented ${kind} headline`,
    explanation: `Invented ${kind} explanation with no private source identifiers.`,
    ...overrides,
  } as InsightOccurrenceSummaryV1;
}

function presentation(
  overrides: Partial<FinanceInsightsPresentationData> = {},
): FinanceInsightsPresentationData {
  return {
    contractVersion: '1.0',
    state: 'connected',
    transport: 'live',
    authoritative: true,
    sourceAsOf: '2026-08-10T15:00:00Z',
    collapsedCount: 0,
    items: [],
    ...overrides,
  };
}

const detailData: FinanceInsightDetailData = {
  contractVersion: '1.0',
  detail: fixtureDetail,
  externalLinks: [{
    system: 'monarch',
    label: 'Open Monarch recurring',
    url: 'https://app.monarchmoney.com/recurring',
  }],
};

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
  digest: ['Invented household digest remains visible'],
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
  overall: 'healthy',
  bridge: { reachable: true, authenticated: true, authState: 'valid', mode: 'live' },
  sync: {
    status: 'succeeded',
    lastSuccessfulSyncAt: '2026-08-10T15:00:00Z',
    freshnessMinutes: 1,
    stale: false,
    lastErrorCode: null,
    activeJob: null,
  },
  attribution: {
    status: 'healthy',
    lastSuccessfulAt: '2026-08-10T15:00:00Z',
    policyVersion: 1,
    engineVersion: 'invented',
  },
  projection: { aggregate: 'fresh', datasets: [] },
};

beforeEach(() => {
  window.history.replaceState(null, '', '/finance');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/finance');
});

describe('SpendingInsightsSection', () => {
  it('renders every approved group and keeps compact decision metadata distinct', async () => {
    const items = [
      summary('recurringAmountChange', 'a'),
      summary('largeTransaction', 'b'),
      summary('categoryVariance', 'c'),
      summary('merchantVariance', 'd'),
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation({ items }))));

    render(<SpendingInsightsSection />);

    expect(await screen.findByRole('heading', { name: 'Spending insights' })).toBeInTheDocument();
    for (const heading of [
      'Recurring changes',
      'Large transactions',
      'Category movers',
      'Merchant movers',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
    const recurring = screen.getByRole('article', {
      name: /Recurring change: Invented recurringAmountChange headline/,
    });
    expect(within(recurring).getByText('Observed')).toBeInTheDocument();
    expect(within(recurring).getByText('Expected')).toBeInTheDocument();
    expect(within(recurring).getByText('Delta')).toBeInTheDocument();
    expect(within(recurring).getByText('High confidence')).toBeInTheDocument();
    expect(within(recurring).getByText('Sufficient')).toBeInTheDocument();
    expect(within(recurring).getByText('Open')).toBeInTheDocument();
    expect(within(recurring).getByText('Fresh')).toBeInTheDocument();
    expect(within(recurring).getByText(/Monarch bridge normalized/)).toBeInTheDocument();
    expect(within(recurring).getByText(/Invented recurringAmountChange explanation/)).toBeInTheDocument();
  });

  it.each([
    ['connected', 'Connected — live insight summaries are current.'],
    ['degraded', 'Degraded — current summaries include mixed freshness or cached fallback data.'],
    ['partial', 'Partial — bounded source retrieval was incomplete; available groups remain visible.'],
    ['stale', 'Stale — insight summaries are outside their freshness window.'],
  ] as const)('announces the distinct %s presentation state', async (state, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation({
      state,
      authoritative: state === 'connected',
      items: [summary('largeTransaction', 'e')],
    }))));

    render(<SpendingInsightsSection />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('keeps loading, exact-one connector, unavailable, and metadata-only states distinct', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })));
    const loadingView = render(<SpendingInsightsSection />);
    expect(screen.getByText('Loading Spending insights...')).toBeInTheDocument();
    resolveRequest?.(jsonResponse(presentation({ state: 'connectorUnavailable' })));
    expect(await screen.findByText(/require exactly one enabled Finance connector/)).toBeInTheDocument();
    loadingView.unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation({
      state: 'unavailable',
      authoritative: false,
      transport: 'none',
    }))));
    const unavailableView = render(<SpendingInsightsSection />);
    expect(await screen.findByText(/Spending insights are unavailable/)).toBeInTheDocument();
    unavailableView.unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation({
      state: 'stale',
      authoritative: false,
      transport: 'metadata-only',
      sourceAsOf: null,
      collapsedCount: 2,
    }))));
    render(<SpendingInsightsSection />);
    expect(await screen.findByText(/passed the seven-day display window/)).toHaveTextContent(
      '2 occurrence metadata records remain',
    );
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('does not confuse an authoritative empty result with insufficient baseline analysis', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation())));
    const emptyView = render(<SpendingInsightsSection />);
    expect(await screen.findByText(/authoritative empty result/)).toBeInTheDocument();
    expect(screen.queryByText('Insufficient')).not.toBeInTheDocument();
    emptyView.unmount();

    const insufficient = summary('categoryVariance', 'f', {
      analysisState: 'insufficientBaseline',
      sourceLifecycle: null,
      baselineSufficiency: 'insufficient',
      observedValue: null,
      expectedRange: null,
      absoluteDelta: null,
      percentageDeltaBasisPoints: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(presentation({
      items: [insufficient],
    }))));
    render(<SpendingInsightsSection />);

    const card = await screen.findByRole('article', {
      name: /Category mover: Invented categoryVariance headline/,
    });
    expect(within(card).getByText('Insufficient')).toBeInTheDocument();
    expect(within(card).getByText('Insufficient Baseline')).toBeInTheDocument();
    expect(within(card).getAllByText('Not available')).toHaveLength(2);
  });

  it('isolates Tyrion presentation failure from overview, health, digest, and alerts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/finance/overview') return jsonResponse(overview);
      if (url === '/api/finance/insights/presentation') return jsonResponse({}, 503);
      if (url.includes('/health')) return jsonResponse(health);
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<FinancePage />);

    expect(await screen.findByText('Invented household digest remains visible')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connection health' })).toBeInTheDocument();
    expect(await screen.findByText(/Spending insights are unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Household digest' })).toBeInTheDocument();
  });

  it('uses one accessible shared drawer with focus return, escape close, and canonical route seam', async () => {
    const item = summary('recurringAmountChange', 'g', {
      occurrenceId: fixtureDetail.occurrenceId,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => (
      String(input) === '/api/finance/insights/presentation'
        ? jsonResponse(presentation({ items: [item] }))
        : jsonResponse(detailData)
    )));

    render(<SpendingInsightsSection />);
    const card = await screen.findByRole('article', { name: /Recurring change:/ });
    const trigger = within(card).getByRole('button', { name: 'View details' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Spending insight details' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(dialog);
    expect(screen.getByRole('link', { name: /Open full page/ }))
      .toHaveAttribute('href', `/finance/insights/${fixtureDetail.occurrenceId}`);
    expect(screen.queryByRole('link', { name: /finance\/review/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('finance-insight-drawer-scroll')).toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('finance-insight-groups')).toHaveClass('xl:grid-cols-2');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('opens a deep-linked occurrence and removes only its query parameter on close', async () => {
    window.history.replaceState(null, '', `/finance?insight=${fixtureDetail.occurrenceId}&keep=1`);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => (
      String(input) === '/api/finance/insights/presentation'
        ? jsonResponse(presentation())
        : jsonResponse(detailData)
    )));

    render(<SpendingInsightsSection />);

    expect(await screen.findByRole('dialog', { name: 'Spending insight details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).toBe('?keep=1');
  });
});

describe('FinanceInsightDetail shared contexts', () => {
  it('renders route and drawer content from the same live DTO without local recomputation', () => {
    const drawer = render(<FinanceInsightDetailContent data={detailData} context="drawer" />);
    expect(screen.getByRole('heading', {
      name: fixtureDetail.headline,
    })).toBeInTheDocument();
    expect(screen.getByText('Comparisons')).toBeInTheDocument();
    expect(screen.getByText('Top contributors')).toBeInTheDocument();
    expect(screen.getByText('Supporting evidence')).toBeInTheDocument();
    expect(screen.getByText(/changes only its local visibility/)).toHaveTextContent(
      "Tyrion's source lifecycle remains open",
    );
    expect(screen.getByRole('link', { name: 'Open Monarch recurring' }))
      .toHaveAttribute('href', 'https://app.monarchmoney.com/recurring');
    drawer.unmount();

    render(<FinanceInsightDetailContent data={detailData} context="route" />);
    expect(screen.getByRole('heading', {
      name: fixtureDetail.headline,
    })).toBeInTheDocument();
    expect(screen.getByText('Comparisons')).toBeInTheDocument();
    expect(screen.getByText('Top contributors')).toBeInTheDocument();
    expect(screen.getByText('Supporting evidence')).toBeInTheDocument();
  });

  it('renders the canonical full-page route through the shared live detail component', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detailData)));

    render(<FinanceInsightRoute occurrenceId={fixtureDetail.occurrenceId} />);

    expect(await screen.findByRole('heading', {
      name: fixtureDetail.headline,
    })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Finance' })).toHaveAttribute('href', '/finance');
    expect(screen.getByText('Live occurrence detail')).toBeInTheDocument();
  });

  it('contains no task creation or attribution-review routing in the M3 surfaces', () => {
    const sectionSource = readFileSync(
      resolve(process.cwd(), 'src/components/finance/SpendingInsightsSection.tsx'),
      'utf8',
    );
    const detailSource = readFileSync(
      resolve(process.cwd(), 'src/components/finance/FinanceInsightDetail.tsx'),
      'utf8',
    );
    expect(`${sectionSource}\n${detailSource}`).not.toMatch(/\/api\/tasks|create task|\/finance\/review/i);
  });
});
