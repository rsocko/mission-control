import { afterEach, describe, expect, it, vi } from 'vitest';

const tyrionProjection = {
  contractVersion: '1',
  connectorRef: 'connector-ref-one',
  sourceGeneration: 'generation-one',
  sourceAsOf: '2026-08-13T10:00:00.000Z',
  completeness: 'complete',
  payees: [{
    payeeRef: 'payee-ref-17',
    displayName: 'Invented Utilities',
    activity: 'active',
    classification: 'recurring-variable',
    observationCount: 8,
    observationWindow: {
      firstObservedOn: '2026-01-12',
      lastObservedOn: '2026-08-12',
    },
    intervalEvidence: {
      sampleCount: 7,
      medianDays: 30,
      minimumDays: 28,
      maximumDays: 32,
    },
    confidence: 0.86,
    basis: ['interval-cluster'],
    provenance: {
      transactionHistory: true,
      monarchRecurring: true,
    },
    monarchConfirmedRecurring: {
      active: true,
      cadence: 'monthly',
    },
  }],
};

const owlReview = {
  id: 'payee-ref-17',
  active: true,
  display_hint: 'Invented Utilities',
  classification: 'recurring-variable',
  observation_count: 8,
  observation_window: {},
  interval_evidence: {},
  confidence: 0.86,
  basis: [],
  provenance: {},
  monarch_confirmed_recurring: {},
  source_as_of: '2026-08-13T10:00:00.000Z',
  review_status: 'unreviewed',
  document_decision: 'unknown',
  mappings: [],
  expectation_ids: ['monthly-statement'],
  notes: null,
  reviewed_at: null,
  owl_deep_link: 'https://owl.example/payee-document-reviews/payee-ref-17',
  source_actions: [],
};

const correspondents = [{
  id: 41,
  name: 'Invented Utility Company',
  lifecycle_status: 'active',
  owl_deep_link: 'https://owl.example/correspondents/41',
}];

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installConfiguration() {
  process.env.TYRION_PAYEE_PATTERN_API_URL =
    'https://tyrion.example/api/internal/v1/finance/insights/payee-patterns/generation-one?connectorRef=connector-ref-one';
  process.env.TYRION_PAYEE_PATTERN_API_TOKEN = 'tyrion-secret';
  process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
  process.env.OWL_MISSION_CONTROL_API_TOKEN = 'owl-secret';
}

afterEach(() => {
  delete process.env.TYRION_PAYEE_PATTERN_API_URL;
  delete process.env.TYRION_PAYEE_PATTERN_API_TOKEN;
  delete process.env.OWL_MISSION_CONTROL_URL;
  delete process.env.OWL_MISSION_CONTROL_API_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PayeeDocumentReviewAdapter', () => {
  it('joins sources only by opaque identity and keeps service tokens server-side', async () => {
    installConfiguration();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes('tyrion.example')) return response(tyrionProjection);
      if (url.includes('/correspondents')) return response(correspondents);
      return response([owlReview]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getPayeeDocumentReviewAdapter } = await import(
      '@/lib/payee-document-review/server-adapter'
    );

    const snapshot = await getPayeeDocumentReviewAdapter().load();

    expect(snapshot).toMatchObject({
      state: 'ready',
      sourceAsOf: tyrionProjection.sourceAsOf,
      items: [{
        candidateId: 'payee-ref-17',
        pattern: {
          displayName: 'Invented Utilities',
          observationCount: 8,
        },
        documentPolicy: {
          status: 'unreviewed',
          owlPolicyUrl: owlReview.owl_deep_link,
        },
      }],
      correspondents: [{ correspondentRef: '41', name: 'Invented Utility Company' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return new Headers(init.headers).get('Authorization');
    })).toEqual(expect.arrayContaining(['Bearer tyrion-secret', 'Bearer owl-secret']));
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('sends mapping only to OWL and preserves its expectation identifiers', async () => {
    installConfiguration();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('tyrion.example')) return response(tyrionProjection);
      if (url.includes('/correspondents')) return response(correspondents);
      if (url.endsWith('/mapping')) {
        return response({
          ...owlReview,
          document_decision: 'documents_expected',
          mappings: [{ account_candidate_id: null, correspondent_id: 41 }],
        });
      }
      if (init?.method === 'PUT') throw new Error('Unexpected PUT target');
      return response([{
        ...owlReview,
        document_decision: fetchMock.mock.calls.some((call) => (
          String(call[0]).endsWith('/mapping')
        ))
          ? 'documents_expected'
          : 'unknown',
        mappings: fetchMock.mock.calls.some((call) => (
          String(call[0]).endsWith('/mapping')
        ))
          ? [{ account_candidate_id: null, correspondent_id: 41 }]
          : [],
      }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getPayeeDocumentReviewAdapter } = await import(
      '@/lib/payee-document-review/server-adapter'
    );

    const result = await getPayeeDocumentReviewAdapter().decide({
      candidateId: 'payee-ref-17',
      decision: 'map-correspondent',
      correspondentRef: '41',
    });

    const mutation = fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/mapping'));
    expect(mutation?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body))).toEqual({
      mappings: [{ account_candidate_id: null, correspondent_id: 41 }],
      expectation_ids: ['monthly-statement'],
      notes: null,
    });
    expect(result).toMatchObject({
      acknowledged: true,
      candidateId: 'payee-ref-17',
      documentPolicy: {
      status: 'mapped',
      correspondentRef: '41',
      },
    });
    expect(fetchMock.mock.calls.filter((call) => (
      String(call[0]).includes('tyrion.example')
      && (call[1] as RequestInit | undefined)?.method
    ))).toHaveLength(0);
  });

  it('loads every bounded OWL page before joining reviews and correspondents', async () => {
    installConfiguration();
    const firstCorrespondentPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Invented Correspondent ${String(index + 1).padStart(3, '0')}`,
      lifecycle_status: 'active',
      owl_deep_link: null,
    }));
    const firstReviewPage = Array.from({ length: 100 }, (_, index) => ({
      ...owlReview,
      id: index === 0 ? 'payee-ref-17' : `payee-ref-${index + 100}`,
    }));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'tyrion.example') return response(tyrionProjection);
      const offset = url.searchParams.get('offset');
      if (url.pathname.endsWith('/correspondents')) {
        return response(offset === '0' ? firstCorrespondentPage : [correspondents[0]]);
      }
      return response(offset === '0' ? firstReviewPage : []);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getPayeeDocumentReviewAdapter } = await import(
      '@/lib/payee-document-review/server-adapter'
    );

    const snapshot = await getPayeeDocumentReviewAdapter().load();

    expect(snapshot.state).toBe('ready');
    expect(snapshot.correspondents).toHaveLength(101);
    expect(fetchMock.mock.calls.some((call) => (
      String(call[0]).includes('/correspondents')
      && String(call[0]).includes('offset=100')
    ))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => (
      String(call[0]).includes('/payee-document-reviews')
      && String(call[0]).includes('offset=100')
    ))).toBe(true);
  });
});
