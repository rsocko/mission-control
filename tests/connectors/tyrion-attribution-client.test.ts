import { describe, expect, it, vi } from 'vitest';
import {
  createAttributionHeaders,
  createAttributionRequests,
  createAttributionSourceRef,
  createInstrumentFingerprint,
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
  fingerprintKey: 'invented-fingerprint-key-at-least-32-characters',
  keyVersion: 1,
  expectedPolicyVersion: null,
  timeoutMs: 50,
};

const item: AttributionBatchItem = {
  sourceRef: 'source-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  occurredOn: '2026-08-08',
  merchantName: 'Invented merchant',
  instrumentFingerprint: 'instrument-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  observedAt: '2026-08-08T12:00:00.000Z',
  existingManualDecision: null,
};

function request(overrides: Partial<AttributionBatchRequest> = {}): AttributionBatchRequest {
  return {
    contractVersion: '1.0',
    provenance: 'mission-control-normalized-v1',
    expectedPolicyVersion: null,
    items: [item],
    ...overrides,
  };
}

function success(sourceRef = item.sourceRef, policyVersion = 7) {
  return {
    contractVersion: '1.0',
    policyVersion,
    engineVersion: '1.0.0',
    results: [{
      contractVersion: '1.0',
      sourceRef,
      status: 'attributed',
      kidId: 'kid-one',
      confidence: 'definite',
      method: 'card-rule',
      explanation: 'Matched a configured instrument rule',
      reviewStatus: 'not-required',
      reasons: [],
      decisionSource: 'automated',
      policyVersion,
      engineVersion: '1.0.0',
      evaluatedAt: '2026-08-08T12:00:01.000Z',
    }],
  };
}

describe('Tyrion attribution v1 client', () => {
  it('uses only the shared finance-manager bearer credential', () => {
    const headers = createAttributionHeaders(config);

    expect(headers.get('authorization')).toBe(`Bearer ${config.serviceToken}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect([...headers.keys()].filter((name) => name.startsWith('x-tyrion'))).toEqual([]);
  });

  it('derives stable scoped irreversible references with explicit key rotation', () => {
    const source = createAttributionSourceRef(config, 'connector-a', 'private-transaction-id');
    const instrument = createInstrumentFingerprint(
      config,
      'connector-a',
      'private-account-id',
      '1234',
    );

    expect(source).toMatch(/^source-v1:[A-Za-z0-9_-]{43}$/);
    expect(instrument).toMatch(/^instrument-v1:[A-Za-z0-9_-]{43}$/);
    expect(source).not.toContain('private-transaction-id');
    expect(instrument).not.toContain('private-account-id');
    expect(createAttributionSourceRef(config, 'connector-a', 'private-transaction-id'))
      .toBe(source);
    expect(createAttributionSourceRef(config, 'connector-b', 'private-transaction-id'))
      .not.toBe(source);
    expect(createAttributionSourceRef({ ...config, keyVersion: 2 }, 'connector-a', 'private-transaction-id'))
      .not.toBe(source);
  });

  it('sends only the strict minimized DTO and validates ordered metadata correlation', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'http://tyrion-operations-ui:3000/api/internal/v1/attribution/batch',
      );
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${config.serviceToken}`);
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.items[0]).sort()).toEqual([
        'existingManualDecision',
        'instrumentFingerprint',
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
      policyVersion: 7,
      engineVersion: '1.0.0',
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

  it('enforces item and body bounds and emits sanitized stable service errors', async () => {
    expect(() => createAttributionRequests(Array.from({ length: 101 }, (_, index) => ({
      ...item,
      sourceRef: `source-${index}`,
    })), null)).not.toThrow();
    expect(createAttributionRequests(Array.from({ length: 101 }, (_, index) => ({
      ...item,
      sourceRef: `source-${index}`,
    })), null)).toHaveLength(2);

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
      credentials: { serviceToken: 'persisted-token' },
    }, {
      FINANCE_MANAGER_API_TOKEN: 'environment-token',
      TYRION_ATTRIBUTION_FINGERPRINT_KEY: config.fingerprintKey,
      TYRION_ATTRIBUTION_KEY_VERSION: '1',
    })).toMatchObject({ serviceToken: 'persisted-token' });
    expect(resolveTyrionAttributionConfig({
      credentials: { bridgeToken: 'legacy-persisted-token' },
    }, {
      TYRION_ATTRIBUTION_FINGERPRINT_KEY: config.fingerprintKey,
      TYRION_ATTRIBUTION_KEY_VERSION: '1',
    })).toMatchObject({ serviceToken: 'legacy-persisted-token' });
    expect(resolveTyrionAttributionConfig({ credentials: {} }, {
      FINANCE_MANAGER_API_TOKEN: 'environment-token',
      TYRION_ATTRIBUTION_FINGERPRINT_KEY: config.fingerprintKey,
      TYRION_ATTRIBUTION_KEY_VERSION: '1',
    })).toMatchObject({ serviceToken: 'environment-token' });
    expect(() => resolveTyrionAttributionConfig({ credentials: {} }, {
      TYRION_ATTRIBUTION_FINGERPRINT_KEY: config.fingerprintKey,
      TYRION_ATTRIBUTION_KEY_VERSION: '1',
    })).toThrowError(expect.objectContaining({ code: 'attribution_not_configured' }));
  });

  it('accepts a maximum-item response larger than the request body limit', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...item,
      sourceRef: `source-v1:${index.toString().padStart(43, 'A')}`,
    }));
    const responseBody = {
      contractVersion: '1.0',
      policyVersion: 7,
      engineVersion: '1.0.0',
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
