import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPersistedConfig: vi.fn(),
  readCache: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/config', () => ({
  getPersistedFinanceConnectorConfig: mocks.getPersistedConfig,
}));
vi.mock('@/lib/logger', () => ({
  default: { warn: mocks.warn },
}));
vi.mock('@/lib/finance-insights/occurrence-cache', () => ({
  readFinanceInsightOccurrenceCache: mocks.readCache,
}));

function trustedRequest(query = ''): Request {
  return new Request(`https://mc.example/api/finance/insights${query}`, {
    headers: {
      host: 'mc.example',
      origin: 'https://mc.example',
      'sec-fetch-site': 'same-origin',
      'x-mc-api-key': 'trusted-key',
    },
  });
}

function listResponse() {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    items: [],
    nextCursor: null,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function occurrenceDetail() {
  const detail = JSON.parse(readFileSync(
    resolve(process.cwd(), 'tests/fixtures/finance-insights/occurrence-detail.json'),
    'utf8',
  )) as Record<string, unknown>;
  detail.provenance = {
    ...(detail.provenance as Record<string, unknown>),
    connectorRef: 'finance-primary',
  };
  return detail;
}

function occurrenceSummary() {
  const detail = occurrenceDetail();
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
    delete detail[field];
  }
  return detail;
}

function occurrenceListResponse(items: unknown[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({
    contractVersion: '1.0',
    items,
    nextCursor,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('finance insight trusted read proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MC_API_KEY = 'trusted-key';
    process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'true';
    process.env.TYRION_FINANCE_INSIGHTS_MAX_RETRIES = '0';
    mocks.getPersistedConfig.mockResolvedValue({
      id: 'finance-primary',
      type: 'finance-manager',
      enabled: true,
      credentials: { serviceToken: 'persisted-service-token' },
      settings: { householdCurrency: 'USD' },
    });
    mocks.readCache.mockReturnValue({
      state: 'unavailable',
      alertCapable: false,
      sourceGeneration: null,
      items: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.MC_API_KEY;
    delete process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED;
    delete process.env.TYRION_FINANCE_INSIGHTS_MAX_RETRIES;
  });

  it('binds a strict default list request to the one enabled connector', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://tyrion-operations-ui:3000');
      expect(url.pathname).toBe('/api/internal/v1/finance/insights/occurrences');
      expect(url.searchParams.getAll('sourceLifecycle')).toEqual(['open']);
      expect(url.searchParams.getAll('analysisState')).toEqual(['qualified']);
      expect(url.searchParams.get('connectorRef')).toBe('finance-primary');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer persisted-service-token');
      return listResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      contractVersion: '1.0',
      items: [],
      nextCursor: null,
    });
    expect(mocks.getPersistedConfig).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forwards only strict bounded filters and preserves an opaque cursor', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.getAll('kind')).toEqual([
        'largeTransaction',
        'categoryVariance',
      ]);
      expect(url.searchParams.get('cursor')).toBe('opaque+/cursor==');
      expect(url.searchParams.get('connectorRef')).toBe('finance-primary');
      expect(url.searchParams.get('limit')).toBe('100');
      return listResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');
    const query = '?kind=largeTransaction&kind=categoryVariance'
      + '&connectorRef=finance-primary&limit=100&cursor=opaque%2B%2Fcursor%3D%3D';

    const response = await GET(trustedRequest(query));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    '?url=https://attacker.example',
    '?limit=1&limit=2',
    '?connectorRef=finance-primary&connectorRef=finance-primary',
    '?limit=0',
    '?limit=01',
    '?kind=',
    '?kind=largeTransaction&kind=largeTransaction',
    '?kind=largeTransaction&kind=categoryVariance&kind=merchantVariance'
      + '&kind=recurringAmountChange&kind=largeTransaction',
    '?cursor=',
  ])('rejects malformed query %s before connector or client access', async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest(query));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      contractVersion: '1.0',
      error: {
        code: 'invalid_filter',
        message: 'Finance insight filter is invalid',
      },
    });
    expect(mocks.getPersistedConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects cross-site callers before connector or private-client access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');
    const request = new Request('https://mc.example/api/finance/insights', {
      headers: {
        host: 'mc.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    });

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mocks.getPersistedConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'Finance connector is not configured',
    'connectorId is required when multiple finance connectors are enabled',
  ])('fails closed when exactly-one connector selection fails', async (detail) => {
    mocks.getPersistedConfig.mockRejectedValueOnce(new Error(detail));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      contractVersion: '1.0',
      error: {
        code: 'insight_source_unavailable',
        message: 'Finance insight source data is unavailable',
      },
    });
    expect(JSON.stringify(body)).not.toContain(detail);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a different connector reference without private transport', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest('?connectorRef=finance-other'));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed before transport when the shadow gate is disabled', async () => {
    process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'false';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest());

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates malformed upstream responses behind a stable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      items: [],
      nextCursor: null,
      privateDetail: 'raw upstream detail',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/privateDetail|raw upstream/i);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'finance_insight_read_proxy_failed',
        connectorId: 'finance-primary',
        sourceCode: 'invalid_finance_insight_contract',
      }),
      'Finance insight read proxy failed',
    );
  });

  it('rejects a valid summary attributed to another connector', async () => {
    const detail = JSON.parse(readFileSync(
      resolve(process.cwd(), 'tests/fixtures/finance-insights/occurrence-detail.json'),
      'utf8',
    )) as Record<string, unknown>;
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
      delete detail[field];
    }
    detail.provenance = {
      ...(detail.provenance as Record<string, unknown>),
      connectorRef: 'finance-other',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      items: [detail],
      nextCursor: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const { GET } = await import('@/app/api/finance/insights/route');

    const response = await GET(trustedRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'insight_source_unavailable' },
    });
  });

    it('returns bounded live presentation groups without exposing server credentials', async () => {
      const summary = occurrenceSummary();
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const analysisStates = url.searchParams.getAll('analysisState');
        expect(new Headers(init?.headers).has('authorization')).toBe(true);
        return occurrenceListResponse(
          analysisStates.includes('qualified') ? [summary] : [],
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(body).toMatchObject({
        contractVersion: '1.0',
        state: 'connected',
        transport: 'live',
        authoritative: true,
        collapsedCount: 0,
        items: [{ occurrenceId: summary.occurrenceId }],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(body)).not.toMatch(/persisted-service-token|authorization|api\/internal/i);
    });

    it('keeps fulfilled presentation data when the independent context request fails', async () => {
      const summary = occurrenceSummary();
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        const analysisStates = new URL(String(input)).searchParams.getAll('analysisState');
        return analysisStates.includes('qualified')
          ? occurrenceListResponse([summary])
          : new Response('{}', { status: 503 });
      }));
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));

      expect(await response.json()).toMatchObject({
        state: 'partial',
        transport: 'live',
        authoritative: false,
        items: [{ occurrenceId: summary.occurrenceId }],
    });
  });

    it('follows bounded cursors before declaring the presentation authoritative', async () => {
      const first = occurrenceSummary();
      const second = {
        ...occurrenceSummary(),
        occurrenceId: `occurrence-v1_${'A'.repeat(43)}`,
        updatedAt: '2026-08-10T15:05:02Z',
      };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const analysisStates = url.searchParams.getAll('analysisState');
        if (!analysisStates.includes('qualified')) return occurrenceListResponse([]);
        return url.searchParams.get('cursor') === null
          ? occurrenceListResponse([first], 'invented-next-page')
          : occurrenceListResponse([second]);
      });
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));
      const body = await response.json();

      expect(body).toMatchObject({
        state: 'connected',
        authoritative: true,
        items: [
          { occurrenceId: second.occurrenceId },
          { occurrenceId: first.occurrenceId },
        ],
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('bounds oversized complete snapshots without claiming authority', async () => {
      const items = Array.from({ length: 101 }, (_, index) => ({
        ...occurrenceSummary(),
        occurrenceId: `occurrence-v1_${index.toString(36).padStart(43, '0')}`,
      }));
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (!url.searchParams.getAll('analysisState').includes('qualified')) {
          return occurrenceListResponse([]);
        }
        const cursor = url.searchParams.get('cursor');
        if (cursor === null) return occurrenceListResponse(items.slice(0, 50), 'page-2');
        if (cursor === 'page-2') return occurrenceListResponse(items.slice(50, 100), 'page-3');
        return occurrenceListResponse(items.slice(100));
      });
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));
      const body = await response.json();

      expect(body).toMatchObject({
        state: 'partial',
        authoritative: false,
      });
      expect(body.items).toHaveLength(100);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('distinguishes exact-one connector unavailability from source unavailability', async () => {
      mocks.getPersistedConfig.mockRejectedValueOnce(
        new Error('connectorId is required when multiple finance connectors are enabled'),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));

      expect(await response.json()).toEqual({
        contractVersion: '1.0',
        state: 'connectorUnavailable',
        transport: 'none',
        authoritative: false,
        sourceAsOf: null,
        collapsedCount: 0,
        items: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('collapses payloads after the cache display window without reviving summaries', async () => {
      mocks.readCache.mockReturnValueOnce({
        state: 'metadata-only',
        alertCapable: false,
        sourceGeneration: 'invented-generation',
        items: [{
          occurrenceId: occurrenceDetail().occurrenceId,
          insightId: occurrenceDetail().insightId,
          kind: 'recurringAmountChange',
          sourceLifecycle: 'open',
          updatedAt: '2026-08-01T12:00:00Z',
        }],
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Tyrion unavailable')));
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));

      expect(await response.json()).toEqual({
        contractVersion: '1.0',
        state: 'stale',
        transport: 'metadata-only',
        authoritative: false,
        sourceAsOf: null,
        collapsedCount: 1,
        items: [],
      });
    });

    it('ages cached summary freshness at the presentation boundary', async () => {
      const cached = occurrenceSummary();
      mocks.readCache.mockReturnValueOnce({
        state: 'available',
        alertCapable: false,
        sourceGeneration: 'invented-generation',
        items: [cached],
      });
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-13T15:00:01Z'));
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Tyrion unavailable')));
      const { GET } = await import('@/app/api/finance/insights/presentation/route');

      const response = await GET(trustedRequest('/presentation'));

      expect(await response.json()).toMatchObject({
        state: 'stale',
        transport: 'cache',
        authoritative: false,
        items: [{
          occurrenceId: cached.occurrenceId,
          freshness: {
            state: 'stale',
            warningReason: 'source_stale',
          },
        }],
      });
    });

    it('serves live detail with only registry-built safe fallback links', async () => {
      const detail = occurrenceDetail();
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);
      const { GET } = await import('@/app/api/finance/insights/[occurrenceId]/route');

      const response = await GET(trustedRequest(`/${detail.occurrenceId}`), {
        params: Promise.resolve({ occurrenceId: String(detail.occurrenceId) }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(body.externalLinks).toEqual([{
        system: 'monarch',
        label: 'Open Monarch recurring',
        url: 'https://app.monarchmoney.com/recurring',
      }]);
      expect(JSON.stringify(body)).not.toMatch(/persisted-service-token|authorization|tyrion-operations-ui/i);
    });

    it('rejects arbitrary upstream target URLs and sanitizes detail failures', async () => {
      const detail = occurrenceDetail();
      detail.targets = [{
        system: 'monarch',
        targetKind: 'safeRoot',
        root: 'transactions',
        url: 'https://attacker.example',
      }];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })));
      const { GET } = await import('@/app/api/finance/insights/[occurrenceId]/route');

      const response = await GET(trustedRequest(`/${detail.occurrenceId}`), {
        params: Promise.resolve({ occurrenceId: String(detail.occurrenceId) }),
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        contractVersion: '1.0',
        error: {
          code: 'insight_source_unavailable',
          message: 'Finance insight source data is unavailable',
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/attacker|raw|token/i);
  });
});
