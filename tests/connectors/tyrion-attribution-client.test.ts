import { describe, expect, it, vi } from 'vitest';
import {
  createAttributionHeaders,
  createAttributionRequests,
  createAttributionAccountRef,
  createAttributionSourceRef,
  resolveTyrionAttributionConfig,
  TyrionAttributionClient,
  TyrionAttributionError,
  type TyrionAttributionConfig,
} from '@/lib/connectors/monarch-money/attribution-client';
import type {
  AttributionBatchItem,
  AttributionBatchRequest,
} from '@/lib/connectors/monarch-money/attribution-contract';

const config: TyrionAttributionConfig = {
  serviceToken: 'invented-finance-manager-service-token',
  identityNamespace: 'a'.repeat(64),
  expectedPolicyVersion: 2,
  timeoutMs: 50,
};

const item: AttributionBatchItem = {
  sourceRef: 'source-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  occurredOn: '2026-08-08',
  merchantName: 'Invented merchant',
  accountRef: 'account-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  observedAt: '2026-08-08T12:00:00.000Z',
  existingManualDecision: null,
};

function request(overrides: Partial<AttributionBatchRequest> = {}): AttributionBatchRequest {
  return {
    contractVersion: '2.0',
    provenance: 'mission-control-normalized-v2',
    expectedPolicyVersion: 2,
    items: [item],
    ...overrides,
  };
}

function success(sourceRef = item.sourceRef, policyVersion = 2) {
  return {
    contractVersion: '2.0',
    policyVersion,
    engineVersion: '2.0.0',
    results: [{
      contractVersion: '2.0',
      sourceRef,
      status: 'attributed',
      kidId: 'kid-one',
      confidence: 'definite',
      method: 'account-rule',
      explanation: 'Matched a configured account rule',
      reviewStatus: 'not-required',
      reasons: [],
      decisionSource: 'automated',
      policyVersion,
      engineVersion: '2.0.0',
      evaluatedAt: '2026-08-08T12:00:01.000Z',
    }],
  };
}

describe('Tyrion attribution v2 client', () => {
  it('uses only the shared finance-manager bearer credential', () => {
    const headers = createAttributionHeaders(config);

    expect(headers.get('authorization')).toBe(`Bearer ${config.serviceToken}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect([...headers.keys()].filter((name) => name.startsWith('x-tyrion'))).toEqual([]);
  });

  it('derives stable opaque connector-scoped references from protected state', () => {
    const source = createAttributionSourceRef(config, 'connector-a', 'private-transaction-id');
    const account = createAttributionAccountRef(config, 'private-account-id');

    expect(source).toMatch(/^source-v1:[A-Za-z0-9_-]{43}$/);
    expect(account).toMatch(/^account-v1:[A-Za-z0-9_-]{43}$/);
    expect(source).not.toContain('private-transaction-id');
    expect(account).not.toContain('private-account-id');
    expect(createAttributionSourceRef(config, 'connector-a', 'private-transaction-id'))
      .toBe(source);
    expect(createAttributionSourceRef({
      ...config,
      identityNamespace: 'b'.repeat(64),
    }, 'connector-a', 'private-transaction-id'))
      .not.toBe(source);
  });

  it('sends only the strict minimized DTO and validates ordered metadata correlation', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'http://tyrion-operations-ui:3000/api/internal/v2/attribution/batch',
      );
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${config.serviceToken}`);
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.items[0]).sort()).toEqual([
        'accountRef',
        'existingManualDecision',
        'merchantName',
        'observedAt',
        'occurredOn',
        'sourceRef',
      ]);
      expect(JSON.stringify(body)).not.toMatch(/amount|accountId|mask|notes|tags|category/i);
      return new Response(JSON.stringify(success()), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionAttributionClient(
      config,
      fetchMock as typeof fetch,
    );

    await expect(client.attribute(request())).resolves.toMatchObject({
      policyVersion: 2,
      engineVersion: '2.0.0',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects duplicate, missing, extra, reordered, and policy-mismatched results', async () => {
    const mismatched = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify(success(
        'source-v1:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      )), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    );
    await expect(mismatched.attribute(request())).rejects.toMatchObject({
      code: 'invalid_attribution_correlation',
    });

    const policyClient = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify(success(item.sourceRef, 8)), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    await expect(policyClient.attribute(request({ expectedPolicyVersion: 7 })))
      .rejects.toMatchObject({ code: 'policy_conflict' });
  });

  it('keeps contract and policy versions independent behind the static fence', async () => {
    const client = new TyrionAttributionClient(
      { ...config, expectedPolicyVersion: 7 },
      vi.fn().mockResolvedValue(new Response(JSON.stringify(success(item.sourceRef, 7)), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );

    await expect(client.attribute(request({ expectedPolicyVersion: 7 }))).resolves.toMatchObject({
      contractVersion: '2.0',
      policyVersion: 7,
    });
  });

  it('enforces item and body bounds and emits sanitized stable service errors', async () => {
    expect(() => createAttributionRequests(Array.from({ length: 101 }, (_, index) => ({
      ...item,
      sourceRef: `source-${index}`,
    })), 2)).not.toThrow();
    expect(createAttributionRequests(Array.from({ length: 101 }, (_, index) => ({
      ...item,
      sourceRef: `source-${index}`,
    })), 2)).toHaveLength(2);

    const client = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code: 'policy_unavailable', message: 'private filesystem detail' },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    const error = await client.attribute(request()).catch((value) => value);
    expect(error).toBeInstanceOf(TyrionAttributionError);
    expect(error).toMatchObject({ code: 'policy_unavailable', retryable: true });
    expect(error.message).not.toContain('private filesystem detail');

    const unexpectedSuccessStatus = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify(success()), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    await expect(unexpectedSuccessStatus.attribute(request())).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
      status: 201,
    });
  });

  it('rejects malformed success bodies and requires shared token configuration', async () => {
    const client = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ...success(),
        unexpected: 'field',
      }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    );
    await expect(client.attribute(request())).rejects.toMatchObject({
      code: 'invalid_attribution_contract',
    });
    const contradictory = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ...success(),
        results: [{
          ...success().results[0],
          kidId: null,
        }],
      }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    );
    await expect(contradictory.attribute(request())).rejects.toMatchObject({
      code: 'invalid_attribution_contract',
    });
    expect(resolveTyrionAttributionConfig({
      credentials: {
        serviceToken: 'persisted-token',
        identityNamespace: config.identityNamespace,
      },
    }, {
      FINANCE_MANAGER_API_TOKEN: 'environment-token',
      TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION: '7',
    })).toMatchObject({ serviceToken: 'persisted-token', expectedPolicyVersion: 7 });
    expect(resolveTyrionAttributionConfig({
      credentials: {
        bridgeToken: 'legacy-persisted-token',
        identityNamespace: config.identityNamespace,
      },
    }, {
      TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION: '7',
    })).toMatchObject({ serviceToken: 'legacy-persisted-token' });
    expect(resolveTyrionAttributionConfig({
      credentials: { identityNamespace: config.identityNamespace },
    }, {
      FINANCE_MANAGER_API_TOKEN: 'environment-token',
      TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION: '7',
    })).toMatchObject({ serviceToken: 'environment-token' });
    expect(() => resolveTyrionAttributionConfig({
      credentials: { serviceToken: 'persisted-token' },
    }, {})).toThrowError(expect.objectContaining({ code: 'attribution_not_configured' }));
    expect(() => resolveTyrionAttributionConfig({
      credentials: {
        serviceToken: 'persisted-token',
        identityNamespace: config.identityNamespace,
      },
    }, {})).toThrowError(expect.objectContaining({ code: 'attribution_not_configured' }));
  });

  it('accepts a maximum-item response larger than the request body limit', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...item,
      sourceRef: `source-v1:${index.toString().padStart(43, 'A')}`,
    }));
    const responseBody = {
      contractVersion: '2.0',
      policyVersion: 2,
      engineVersion: '2.0.0',
      results: items.map((entry) => ({
        ...success(entry.sourceRef).results[0],
        sourceRef: entry.sourceRef,
        kidId: 'k'.repeat(128),
        explanation: 'x'.repeat(240),
      })),
    };
    expect(new TextEncoder().encode(JSON.stringify(responseBody)).byteLength)
      .toBeGreaterThan(65_536);
    const client = new TyrionAttributionClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    const result = await client.attribute(request({ items }));
    expect(result.results).toHaveLength(100);
  });

  it('times out without leaking transport details', async () => {
    const timeoutConfig = { ...config, timeoutMs: 1 };
    const client = new TyrionAttributionClient(
      timeoutConfig,
      vi.fn((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private socket detail')));
      })) as typeof fetch,
    );
    const error = await client.attribute(request()).catch((value) => value);
    expect(error).toMatchObject({ code: 'attribution_timeout', retryable: true });
    expect(error.message).not.toContain('private socket detail');
  });
});
