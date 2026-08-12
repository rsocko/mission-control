import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createTyrionFinanceInsightHeaders,
  financeInsightRetryDelayMs,
  resolveTyrionFinanceInsightConfig,
  TyrionFinanceInsightClient,
  TyrionFinanceInsightError,
  type TyrionFinanceInsightConfig,
} from '@/lib/finance-insights/client';
import {
  defaultOccurrenceListQueryV1,
  insightErrorResponseSchema,
  insightOccurrenceDetailSchema,
  insightOccurrenceSummarySchema,
  occurrenceActionRequestSchema,
  occurrenceActionResultSchema,
  sourceFactBatchSchema,
  sourceGenerationCreateRequestSchema,
  type OccurrenceListQueryV1,
  type SourceGenerationCreateRequestV1,
} from '@/lib/finance-insights/contract';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    resolve(process.cwd(), `tests/fixtures/finance-insights/${name}.json`),
    'utf8',
  ));
}

function occurrenceSummaryFixture(): Record<string, unknown> {
  const occurrenceSummary = {
    ...(fixture('occurrence-detail') as Record<string, unknown>),
  };
  for (const detailField of [
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
    delete occurrenceSummary[detailField];
  }
  return occurrenceSummary;
}

const config: TyrionFinanceInsightConfig = {
  serviceToken: 'unit-token',
  timeoutMs: 50,
  maxRetries: 0,
  shadowIngestEnabled: true,
};

const createRequest = fixture('source-generation-create') as SourceGenerationCreateRequestV1;

function staging() {
  return {
    contractVersion: '1.0',
    connectorRef: createRequest.connectorRef,
    sourceGeneration: createRequest.sourceGeneration,
    sourceSequence: createRequest.sourceSequence,
    state: 'staging',
    detectorSetVersion: null,
    policyVersion: null,
  };
}

describe('Tyrion finance insight T1 client', () => {
  it('accepts the frozen T1 source, batch, and error fixtures strictly', () => {
    expect(sourceGenerationCreateRequestSchema.parse(createRequest)).toEqual(createRequest);
    expect(sourceFactBatchSchema.parse(fixture('transaction-batch'))).toEqual(
      fixture('transaction-batch'),
    );
    expect(insightErrorResponseSchema.parse(fixture('source-unavailable-error'))).toEqual(
      fixture('source-unavailable-error'),
    );
    expect(() => insightErrorResponseSchema.parse({
      contractVersion: '1.0',
      error: {
        code: 'insight_source_unavailable',
        message: 'Invented but non-canonical service detail',
      },
    })).toThrow();
    const occurrenceSummary = occurrenceSummaryFixture();
    expect(insightOccurrenceSummarySchema.parse(occurrenceSummary)).toEqual(occurrenceSummary);
    expect(insightOccurrenceDetailSchema.parse(fixture('occurrence-detail')))
      .toEqual(fixture('occurrence-detail'));
    expect(() => sourceFactBatchSchema.parse({
      ...(fixture('transaction-batch') as object),
      arbitraryUrl: 'https://attacker.example',
    })).toThrow();
  });

  it('uses only the fixed private authority and server-side Finance Manager token', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'http://tyrion-operations-ui:3000/api/internal/v1/finance/insights/source-generations',
      );
      expect(new Headers(init?.headers).get('authorization'))
        .toBe(`Bearer ${config.serviceToken}`);
      expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', method: 'POST' });
      return new Response(JSON.stringify(staging()), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);
    await expect(client.createSourceGeneration(createRequest)).resolves.toMatchObject({
      state: 'staging',
      sourceSequence: 17,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses the separate retry-only evaluation contract and idempotency namespace', async () => {
    const request = {
      contractVersion: '1.0' as const,
      connectorRef: createRequest.connectorRef,
      sourceGeneration: createRequest.sourceGeneration,
      detectorSetVersion: 'detectors-v1',
      expectedPolicyVersion: 3,
      idempotencyKey: ['finance-evaluation-v1', 'example'].join('-'),
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        'http://tyrion-operations-ui:3000/api/internal/v1/finance/insights/evaluations',
      );
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return new Response(JSON.stringify({
        contractVersion: '1.0',
        identity: {
          householdScope: 'household-invented',
          connectorRef: request.connectorRef,
          sourceGeneration: request.sourceGeneration,
          detectorSetVersion: request.detectorSetVersion,
          policyVersion: request.expectedPolicyVersion,
        },
        sourceSequence: createRequest.sourceSequence,
        evaluationSequence: 9,
        acceptedAt: '2026-08-10T12:00:00.000Z',
        state: 'queued',
        completedAt: null,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);
    await expect(client.retryEvaluation(request)).resolves.toMatchObject({
      state: 'queued',
      evaluationSequence: 9,
    });
  });

  it('posts only the strict confirmed occurrence action contract', async () => {
    const action = occurrenceActionRequestSchema.parse({
      contractVersion: '1.0',
      occurrenceId: occurrenceSummaryFixture().occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 3,
      idempotencyKey: 'finance-action-v1-invented',
      action: 'suppress',
      confirm: true,
      scope: 'occurrence',
      durationDays: 30,
      reason: 'expectedRecurringPattern',
    });
    const result = occurrenceActionResultSchema.parse({
      contractVersion: '1.0',
      occurrenceId: action.occurrenceId,
      deliveryRevision: 2,
      policyVersion: 3,
      actionRef: 'action-v1-invented',
      appliedAt: '2026-08-10T12:00:00.000Z',
      action: 'suppress',
      suppressionId: 'suppression-v1-invented',
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://tyrion-operations-ui:3000/api/internal/v1/finance/insights/occurrences/${action.occurrenceId}/actions`,
      );
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      expect(JSON.parse(String(init?.body))).toEqual(action);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(new TyrionFinanceInsightClient(
      config,
      fetchMock as typeof fetch,
    ).applyOccurrenceAction(action)).resolves.toEqual(result);
  });

  it('rejects malformed occurrence actions before transport', async () => {
    const fetchMock = vi.fn();
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);
    const invalid = {
      contractVersion: '1.0',
      occurrenceId: occurrenceSummaryFixture().occurrenceId,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 3,
      idempotencyKey: 'finance-action-v1-invented',
      action: 'suppress',
      confirm: false,
      scope: 'occurrence',
      durationDays: 30,
      reason: 'expectedRecurringPattern',
    };

    await expect(client.applyOccurrenceAction(
      invalid as Parameters<typeof client.applyOccurrenceAction>[0],
    )).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses persisted Finance Manager auth before the server fallback and ignores overrides', () => {
    expect(resolveTyrionFinanceInsightConfig({
      credentials: { serviceToken: 'persisted-token' },
    }, {
      TYRION_FINANCE_INSIGHTS_TIMEOUT_MS: '9000',
      TYRION_FINANCE_INSIGHTS_MAX_RETRIES: '99',
      TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED: 'true',
      NEXT_PUBLIC_TYRION_FINANCE_INSIGHTS_TOKEN: 'browser-token',
      TYRION_FINANCE_INSIGHTS_URL: 'https://attacker.example',
      FINANCE_MANAGER_API_TOKEN: 'shared-token',
    })).toEqual({
      serviceToken: 'persisted-token',
      timeoutMs: 9000,
      maxRetries: 3,
      shadowIngestEnabled: true,
    });
    expect(resolveTyrionFinanceInsightConfig({ credentials: {} }, {
      FINANCE_MANAGER_API_TOKEN: 'shared-token',
    })).toMatchObject({
      serviceToken: 'shared-token',
      shadowIngestEnabled: false,
    });
    expect(() => resolveTyrionFinanceInsightConfig({ credentials: {} }, {
      TYRION_FINANCE_INSIGHTS_TOKEN: 'ignored-token',
      NEXT_PUBLIC_TYRION_FINANCE_INSIGHTS_TOKEN: 'browser-token',
    })).toThrowError(expect.objectContaining({ code: 'insight_service_not_configured' }));
    expect(createTyrionFinanceInsightHeaders(config).get('authorization'))
      .toBe(`Bearer ${config.serviceToken}`);
  });

  it('fails closed before transport while shadow ingestion is disabled', async () => {
    const fetchMock = vi.fn();
    const client = new TyrionFinanceInsightClient(
      { ...config, shadowIngestEnabled: false },
      fetchMock as typeof fetch,
    );

    await expect(client.createSourceGeneration(createRequest)).rejects.toMatchObject({
      code: 'insight_shadow_ingest_disabled',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes service and transport failures without leaking raw details', async () => {
    const serviceClient = new TyrionFinanceInsightClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        contractVersion: '1.0',
        error: {
          code: 'insight_source_unavailable',
          message: 'private database and filesystem detail',
        },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    const serviceError = await serviceClient.createSourceGeneration(createRequest)
      .catch((error) => error);
    expect(serviceError).toBeInstanceOf(TyrionFinanceInsightError);
    expect(serviceError).toMatchObject({ code: 'insight_source_unavailable', retryable: true });
    expect(serviceError.message).not.toContain('private database');

    const transportClient = new TyrionFinanceInsightClient(
      config,
      vi.fn().mockRejectedValue(new Error('private socket detail')) as typeof fetch,
    );
    const transportError = await transportClient.createSourceGeneration(createRequest)
      .catch((error) => error);
    expect(transportError).toMatchObject({ code: 'insight_source_unavailable' });
    expect(transportError.message).not.toContain('private socket');
  });

  it('preserves changed-retry conflict classification without request detail', async () => {
    const client = new TyrionFinanceInsightClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        contractVersion: '1.0',
        error: {
          code: 'idempotency_conflict',
          message: 'Finance insight idempotency key conflicts with prior input',
        },
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    const error = await client.createSourceGeneration(createRequest).catch((value) => value);
    expect(error).toMatchObject({
      code: 'idempotency_conflict',
      retryable: false,
      status: 409,
    });
    expect(error.message).not.toContain(createRequest.sourceGeneration);
    expect(error.message).not.toContain(config.serviceToken);
  });

  it('bounds retries and rejects malformed success bodies', async () => {
    const retryConfig = { ...config, maxRetries: 1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture('source-unavailable-error')), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(staging()), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }));
    const client = new TyrionFinanceInsightClient(retryConfig, fetchMock as typeof fetch);
    await expect(client.createSourceGeneration(createRequest)).resolves.toMatchObject({
      state: 'staging',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(financeInsightRetryDelayMs(new Response(null, {
      status: 429,
      headers: { 'retry-after': '999' },
    }), 0)).toBe(300_000);
    expect(financeInsightRetryDelayMs(new Response(null, {
      status: 429,
      headers: { 'retry-after': 'invalid' },
    }), 2)).toBe(1_000);

    const malformed = new TyrionFinanceInsightClient(
      config,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ...staging(),
        unexpected: true,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    await expect(malformed.createSourceGeneration(createRequest)).rejects.toMatchObject({
      code: 'invalid_finance_insight_contract',
    });
  });

  it('retries and sanitizes response-stream transport failures', async () => {
    const streamFailure = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"contractVersion":'));
        controller.error(new Error('private response stream detail'));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(streamFailure, {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(staging()), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }));
    const client = new TyrionFinanceInsightClient(
      { ...config, maxRetries: 1 },
      fetchMock as typeof fetch,
    );
    await expect(client.createSourceGeneration(createRequest))
      .resolves.toMatchObject({ state: 'staging' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const failedClient = new TyrionFinanceInsightClient(
      config,
      vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('private terminal stream detail'));
        },
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    );
    const failure = await failedClient.createSourceGeneration(createRequest)
      .catch((error) => error);
    expect(failure).toMatchObject({ code: 'insight_source_unavailable' });
    expect(failure.message).not.toContain('private terminal');
  });

  it('serializes only validated occurrence filters and rejects arbitrary query input', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://tyrion-operations-ui:3000');
      expect(url.pathname).toBe('/api/internal/v1/finance/insights/occurrences');
      expect(url.searchParams.getAll('sourceLifecycle')).toEqual(['open']);
      expect(url.searchParams.getAll('analysisState')).toEqual(['qualified']);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.has('url')).toBe(false);
      return new Response(JSON.stringify({
        contractVersion: '1.0',
        items: [],
        nextCursor: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);
    await expect(client.listOccurrences(defaultOccurrenceListQueryV1()))
      .resolves.toEqual({ contractVersion: '1.0', items: [], nextCursor: null });
    await expect(client.listOccurrences(
      new URLSearchParams('url=https://attacker.example') as unknown as OccurrenceListQueryV1,
    )).rejects.toMatchObject({ code: 'invalid_filter' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('walks a bounded snapshot with unchanged filters and rejects cursor loops', async () => {
    const firstCursor = 'opaque-first-cursor';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.getAll('sourceLifecycle')).toEqual(['open']);
      expect(url.searchParams.getAll('analysisState')).toEqual(['qualified']);
      const cursor = url.searchParams.get('cursor');
      return new Response(JSON.stringify({
        contractVersion: '1.0',
        items: cursor === null ? [occurrenceSummaryFixture()] : [],
        nextCursor: cursor === null ? firstCursor : null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);

    await expect(client.listOccurrenceSnapshot(defaultOccurrenceListQueryV1()))
      .resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const loopClient = new TyrionFinanceInsightClient(config, vi.fn()
      .mockImplementation(async () => new Response(JSON.stringify({
        contractVersion: '1.0',
        items: [],
        nextCursor: firstCursor,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch);
    await expect(loopClient.listOccurrenceSnapshot(defaultOccurrenceListQueryV1()))
      .rejects.toMatchObject({ code: 'invalid_cursor' });

    let page = 0;
    const unboundedCursorClient = new TyrionFinanceInsightClient(config, vi.fn()
      .mockImplementation(async () => new Response(JSON.stringify({
        contractVersion: '1.0',
        items: [],
        nextCursor: `unique-cursor-${page++}`,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch);
    await expect(unboundedCursorClient.listOccurrenceSnapshot(defaultOccurrenceListQueryV1()))
      .rejects.toMatchObject({ code: 'page_too_large' });
    expect(page).toBe(10);

    const duplicatePageClient = new TyrionFinanceInsightClient(config, vi.fn()
      .mockImplementation(async () => new Response(JSON.stringify({
        contractVersion: '1.0',
        items: [occurrenceSummaryFixture(), occurrenceSummaryFixture()],
        nextCursor: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch);
    await expect(duplicatePageClient.listOccurrenceSnapshot(defaultOccurrenceListQueryV1()))
      .rejects.toMatchObject({ code: 'page_too_large' });
  });

  it('rejects occurrence rows outside the requested connector boundary', async () => {
    const occurrence = occurrenceSummaryFixture();
    const provenance = occurrence.provenance as Record<string, unknown>;
    const client = new TyrionFinanceInsightClient(config, vi.fn(async () => (
      new Response(JSON.stringify({
        contractVersion: '1.0',
        items: [{
          ...occurrence,
          provenance: { ...provenance, connectorRef: 'finance-b' },
        }],
        nextCursor: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )) as typeof fetch);

    await expect(client.listOccurrences({
      ...defaultOccurrenceListQueryV1(),
      connectorRef: 'finance-a',
    })).rejects.toMatchObject({ code: 'invalid_finance_insight_contract' });
  });

  it('reads only a strict bounded occurrence detail from the private authority', async () => {
    const detail = fixture('occurrence-detail');
    const occurrenceId = (detail as { occurrenceId: string }).occurrenceId;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://tyrion-operations-ui:3000');
      expect(url.pathname).toMatch(/^\/api\/internal\/v1\/finance\/insights\/occurrences\/occurrence-v1_/);
      return new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new TyrionFinanceInsightClient(config, fetchMock as typeof fetch);

    await expect(client.getOccurrence(occurrenceId, 'demo-connector-v1')).resolves.toEqual(detail);
    await expect(client.getOccurrence('https://attacker.example', 'demo-connector-v1'))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.getOccurrence(occurrenceId, 'finance-other'))
      .rejects.toMatchObject({ code: 'invalid_finance_insight_contract' });
    await expect(client.getOccurrence(
      `occurrence-v1_${'A'.repeat(43)}`,
      'demo-connector-v1',
    )).rejects.toMatchObject({ code: 'invalid_finance_insight_contract' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]![0]).endsWith(`/${occurrenceId}`)).toBe(true);
  });

  it('enforces frozen T1 occurrence invariants', () => {
    const occurrence = {
      contractVersion: '1.0',
      insightId: 'insight-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurrenceId: 'occurrence-v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      deliveryRevision: 1,
      kind: 'largeTransaction',
      entity: {
        kind: 'transaction',
        sourceRef: 'transaction-one',
        displayName: 'Invented market',
        identityQuality: 'stableSource',
      },
      analysisState: 'qualified',
      sourceLifecycle: 'open',
      resolutionReason: null,
      supersededByOccurrenceId: null,
      severity: 'high',
      confidence: 'high',
      baselineSufficiency: 'insufficient',
      reasonCodes: ['explicit_amount_rule_exceeded'],
      headline: 'Invented large transaction',
      explanation: 'An invented transaction exceeded the configured amount threshold.',
      observationPeriod: { start: '2026-08-09', end: '2026-08-09' },
      baselinePeriod: null,
      observedValue: { currency: 'USD', amountMinor: -8425 },
      expectedRange: null,
      absoluteDelta: null,
      percentageDeltaBasisPoints: null,
      currency: 'USD',
      freshness: {
        state: 'fresh',
        sourceAsOf: '2026-08-10T12:00:00.000Z',
        maxAgeHours: 48,
        warningReason: null,
      },
      provenance: {
        connectorRef: 'finance-a',
        sourceGeneration: 'publication-one',
        bridgeContractVersion: 'bridge-v1',
        providerClass: 'monarchBridgeNormalized',
        sourceAsOf: '2026-08-10T12:00:00.000Z',
        coverageStart: '2026-08-01',
        coverageEnd: '2026-08-10',
        completeness: 'complete',
        detectorSetVersion: 'detectors-v1',
        detectorVersion: 'large-transaction-v1',
        methodVersion: 'threshold-v1',
        explanationTemplateVersion: 'large-transaction-v1',
        policyVersion: 1,
        evaluationStartedAt: '2026-08-10T12:01:00.000Z',
        evaluationCompletedAt: '2026-08-10T12:01:01.000Z',
      },
      targets: [{
        system: 'monarch',
        targetKind: 'transaction',
        sourceRef: 'transaction-one',
      }],
      createdAt: '2026-08-10T12:01:01.000Z',
      updatedAt: '2026-08-10T12:01:01.000Z',
      resolvedAt: null,
    };
    expect(insightOccurrenceSummarySchema.parse(occurrence)).toEqual(occurrence);
    expect(() => insightOccurrenceSummarySchema.parse({
      ...occurrence,
      entity: { ...occurrence.entity, kind: 'merchant' },
    })).toThrow();
    expect(() => insightOccurrenceSummarySchema.parse({
      ...occurrence,
      freshness: { ...occurrence.freshness, state: 'partial' },
    })).toThrow();
  });

  it('keeps private token names out of browser-facing source modules', () => {
    const privateClient = readFileSync(
      resolve(process.cwd(), 'src/lib/finance-insights/client.ts'),
      'utf8',
    );
    expect(privateClient).toContain("import 'server-only'");
    expect(privateClient).not.toMatch(/process\.env\.NEXT_PUBLIC|NEXT_PUBLIC_[A-Z_]*TOKEN/);
    for (const browserFile of [
      'src/components/finance/FinanceOverview.tsx',
      'src/components/finance/FinanceReview.tsx',
    ]) {
      expect(readFileSync(resolve(process.cwd(), browserFile), 'utf8'))
        .not.toMatch(/FINANCE_MANAGER_API_TOKEN|finance-insights\/client/);
    }
  });
});
