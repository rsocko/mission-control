import { afterEach, describe, expect, it, vi } from 'vitest';

function trustedBrowserRequest(method = 'GET', body?: unknown) {
  return {
    url: 'http://next-internal:3099/api/finance/payee-document-review',
    method,
    headers: new Headers({
      host: 'next-internal:3099',
      'x-forwarded-host': 'mc.example',
      'x-forwarded-proto': 'https',
      origin: 'https://mc.example',
      referer: 'https://mc.example/finance/payee-documents',
      'sec-fetch-site': 'same-origin',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }),
    json: async () => body,
  } as Request;
}

afterEach(() => {
  delete process.env.OWL_MISSION_CONTROL_URL;
  delete process.env.OWL_MISSION_CONTROL_API_TOKEN;
  vi.restoreAllMocks();
});

describe('payee document review API', () => {
  it('returns an explicit unavailable snapshot while sibling adapters are unconfigured', async () => {
    const { GET } = await import('@/app/api/finance/payee-document-review/route');
    const response = await GET(trustedBrowserRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contractVersion: '1',
      state: 'unavailable',
      items: [],
      correspondents: [],
    });
  });

  it('rejects untrusted reads and invalid mutations', async () => {
    const { GET, POST } = await import('@/app/api/finance/payee-document-review/route');
    const forbidden = await GET(new Request(
      'https://mc.example/api/finance/payee-document-review',
      {
        headers: {
          host: 'mc.example',
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
        },
      },
    ));
    expect(forbidden.status).toBe(403);

    const invalid = await POST(trustedBrowserRequest('POST', {
      candidateId: 'candidate-one',
      decision: 'map-correspondent',
    }));
    expect(invalid.status).toBe(422);
  });

  it('does not report local mutation success before OWL is configured', async () => {
    const { POST } = await import('@/app/api/finance/payee-document-review/route');
    const response = await POST(trustedBrowserRequest('POST', {
      candidateId: 'candidate-one',
      decision: 'no-documents-expected',
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'payee_document_review_adapter_unavailable',
    });
  });
});
