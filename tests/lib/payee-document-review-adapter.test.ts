import { afterEach, describe, expect, it, vi } from 'vitest';

const owlReview = {
  id: 'owl-candidate-17',
  active: true,
  display_hint: 'Invented Utilities',
  classification: 'recurring-variable',
  observation_count: 8,
  observation_window: {
    first_observed_on: '2026-01-12',
    last_observed_on: '2026-08-12',
  },
  interval_evidence: {
    sample_count: 7,
    median_days: 30,
    minimum_days: 28,
    maximum_days: 32,
  },
  confidence: 0.86,
  basis: ['interval-cluster'],
  provenance: {
    transaction_history: true,
    monarch_recurring: true,
  },
  monarch_confirmed_recurring: {
    active: true,
    cadence: 'monthly',
  },
  source_as_of: '2026-08-13T10:00:00.000Z',
  review_status: 'unreviewed',
  document_decision: 'unknown',
  mappings: [],
  expectation_ids: ['monthly-statement'],
  notes: null,
  reviewed_at: null,
  owl_deep_link: 'https://owl.example/payee-document-reviews/owl-candidate-17',
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
  process.env.OWL_MISSION_CONTROL_URL = 'https://owl.example';
  process.env.OWL_MISSION_CONTROL_API_TOKEN = 'owl-secret';
}

afterEach(() => {
  delete process.env.OWL_MISSION_CONTROL_URL;
  delete process.env.OWL_MISSION_CONTROL_API_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PayeeDocumentReviewAdapter', () => {
  it('normalizes the OWL aggregate read model and keeps its token server-side', async () => {
    installConfiguration();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
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
      sourceAsOf: owlReview.source_as_of,
      items: [{
        candidateId: 'owl-candidate-17',
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return new Headers(init.headers).get('Authorization');
    })).toEqual(['Bearer owl-secret', 'Bearer owl-secret']);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('sends mapping only to OWL and preserves its expectation identifiers', async () => {
    installConfiguration();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
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
      candidateId: 'owl-candidate-17',
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
      candidateId: 'owl-candidate-17',
      documentPolicy: {
        status: 'mapped',
        correspondentRef: '41',
      },
    });
    expect(fetchMock.mock.calls.every((call) => (
      new URL(String(call[0])).hostname === 'owl.example'
    ))).toBe(true);
  });

  it('loads every bounded OWL review and correspondent page', async () => {
    installConfiguration();
    const firstCorrespondentPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Invented Correspondent ${String(index + 1).padStart(3, '0')}`,
      lifecycle_status: 'active',
      owl_deep_link: null,
    }));
    const firstReviewPage = Array.from({ length: 100 }, (_, index) => ({
      ...owlReview,
      id: index === 0 ? 'owl-candidate-17' : `owl-candidate-${index + 100}`,
    }));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
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
