import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPersistedConfig: vi.fn(),
  configFromRow: vi.fn(),
  runSync: vi.fn(),
  runExclusive: vi.fn(),
  runBackfill: vi.fn(),
  getHealth: vi.fn(),
  getDatasetHealth: vi.fn(),
  verifyRecovery: vi.fn(),
  reconcileRecovery: vi.fn(),
  getRecoveryView: vi.fn(),
  listEnabledConnectorIds: vi.fn(),
  getConnector: vi.fn(),
  recordTestResult: vi.fn(),
  readHealthSnapshot: vi.fn(),
}));

/** Empty finance operator health snapshot (no persisted finance state yet). */
function emptyHealthSnapshot() {
  return {
    sync: null,
    attribution: null,
    activeJob: null,
    capture: null,
    evaluation: null,
  };
}

// The owned routes must never reach SQLite: an empty module is enough, and any
// residual `db.*`/`sqlite.*` use would fail loudly as a TypeError.
vi.mock('@/db', () => ({ default: {} }));

vi.mock('@/lib/connectors/monarch-money/config', () => ({
  getPersistedFinanceConnectorConfig: mocks.getPersistedConfig,
  financeConnectorConfigFromRow: mocks.configFromRow,
  isFinanceConnectorType: (type: string) => (
    type === 'finance' || type === 'finance-manager' || type === 'monarch-money'
  ),
}));

vi.mock('@/lib/connectors/monarch-money/connection-recovery', () => ({
  verifyFinanceConnectionRecovery: mocks.verifyRecovery,
  reconcileFinanceConnectionObservation: mocks.reconcileRecovery,
  getFinanceConnectionRecoveryView: mocks.getRecoveryView,
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    runSync: mocks.runSync,
    runExclusiveConnectorOperation: mocks.runExclusive,
  },
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    connectors: { get: mocks.getPersistedConfig },
    finance: {
      insights: {
        connectors: { listEnabledConnectorIds: mocks.listEnabledConnectorIds },
      },
      operator: { readHealthSnapshot: mocks.readHealthSnapshot },
    },
  })),
}));

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    connectors: {
      get: mocks.getConnector,
      recordTestResult: mocks.recordTestResult,
    },
  }),
}));

vi.mock('@/lib/connectors/monarch-money/transaction-backfill', () => ({
  FinanceInsightBackfillError: class FinanceInsightBackfillError extends Error {},
  runFinanceInsightTransactionBackfill: mocks.runBackfill,
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: () => false,
}));

vi.mock('@/lib/connectors/monarch-money/client', () => ({
  MonarchBridgeClient: class {
    getHealth = mocks.getHealth;
  },
  MonarchBridgeError: class MonarchBridgeError extends Error {
    constructor(readonly code = 'bridge_unavailable') {
      super(code);
    }
  },
}));

vi.mock('@/lib/connectors/monarch-money/dataset-sync', () => ({
  getFinanceDatasetHealth: mocks.getDatasetHealth,
}));

describe('finance connector routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MC_API_KEY = 'test-finance-api-key';
    mocks.getPersistedConfig.mockResolvedValue({
      id: 'persisted-finance',
      type: 'finance-manager',
      enabled: true,
    });
    mocks.listEnabledConnectorIds.mockResolvedValue(['persisted-finance']);
    mocks.getDatasetHealth.mockResolvedValue({
      aggregate: 'fresh',
      datasets: [],
    });
    mocks.readHealthSnapshot.mockResolvedValue(emptyHealthSnapshot());
    mocks.recordTestResult.mockResolvedValue({ recorded: true });
    mocks.getRecoveryView.mockReturnValue(null);
  });

  it('authorizes recovery verification and accepts only an empty request contract', async () => {
    const connector = {
      id: 'persisted-finance',
      type: 'finance-manager',
      enabled: true,
      deletedAt: null,
    };
    mocks.getConnector.mockResolvedValue(connector);
    mocks.configFromRow.mockReturnValue({ id: connector.id, settings: {}, credentials: {} });
    mocks.verifyRecovery.mockResolvedValue({ recovered: true, reason: 'recovered' });
    const { POST } = await import('@/app/api/connectors/[id]/finance/recovery/route');

    const response = await POST(new Request(
      'https://mc.example/api/connectors/persisted-finance/finance/recovery',
      {
        method: 'POST',
        headers: {
          host: 'mc.example',
          origin: 'https://mc.example',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: '{}',
      },
    ), { params: Promise.resolve({ id: connector.id }) });

    expect(response.status).toBe(200);
    expect(mocks.verifyRecovery).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: connector.id }),
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ['cross-site request', { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, '{}', 403],
    ['malformed JSON', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{', 400],
    ['return URL', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{"returnUrl":"https://attacker.example"}', 400],
    ['session cookie', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{"session_id":"secret"}', 400],
    ['CSRF token', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{"csrftoken":"secret"}', 400],
    ['connector token', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{"connectorToken":"secret"}', 400],
    ['recovery assertion', { origin: 'https://mc.example', 'sec-fetch-site': 'same-origin' }, '{"assertion":"secret"}', 400],
  ])('rejects a recovery %s', async (_label, requestHeaders, body, status) => {
    const { POST } = await import('@/app/api/connectors/[id]/finance/recovery/route');
    const response = await POST(new Request(
      'https://mc.example/api/connectors/persisted-finance/finance/recovery',
      {
        method: 'POST',
        headers: {
          host: 'mc.example',
          'content-type': 'application/json',
          ...requestHeaders,
        },
        body,
      },
    ), { params: Promise.resolve({ id: 'persisted-finance' }) });

    expect(response.status).toBe(status);
    expect(mocks.verifyRecovery).not.toHaveBeenCalled();
  });

  it('runs finance sync through persisted config and the canonical scheduler', async () => {
    mocks.runSync.mockResolvedValue({
      success: true,
      connectorId: 'persisted-finance',
      errors: [],
    });

    const { POST } = await import('@/app/api/finance/sync/route');
    const request = new Request('http://localhost/api/finance/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'x-mc-api-key': 'test-finance-api-key',
      },
      body: JSON.stringify({ connectorId: 'persisted-finance', full: true }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.getPersistedConfig).toHaveBeenCalledWith('persisted-finance');
    expect(mocks.runSync).toHaveBeenCalledWith('persisted-finance', expect.objectContaining({
      full: true,
      source: 'api',
      signal: request.signal,
    }));
  });

  it('runs bounded Finance insight backfill through the protected connector lease', async () => {
    mocks.runBackfill.mockResolvedValue({
      planId: 'invented-plan',
      status: 'running',
      completedWindows: 1,
      totalWindows: 4,
      coverageStart: '2023-07-11',
      coverageEnd: '2026-08-10',
      itemCount: 10,
    });
    mocks.runExclusive.mockImplementation(async (_connectorId, operation) => operation());
    const { POST } = await import('@/app/api/finance/sync/route');
    const request = new Request('http://localhost/api/finance/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'x-mc-api-key': 'test-finance-api-key',
      },
      body: JSON.stringify({
        connectorId: 'persisted-finance',
        insightBackfill: {
          idempotencyKey: 'invented-operator-key',
          horizonMonths: 37,
          maxWindows: 1,
        },
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.runExclusive).toHaveBeenCalledWith(
      'persisted-finance',
      expect.any(Function),
    );
    expect(mocks.runBackfill).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: 'persisted-finance' }),
      idempotencyKey: 'invented-operator-key',
      horizonMonths: 37,
      maxWindows: 1,
      signal: request.signal,
    }));
    expect(mocks.runSync).not.toHaveBeenCalled();
  });

  it('returns conflict when another connector operation holds the backfill lease', async () => {
    const { ConnectorOperationBusyError } = await import('@/lib/sync/connector-lock');
    mocks.runExclusive.mockRejectedValue(
      new ConnectorOperationBusyError('Sync already in progress for this connector'),
    );
    const { POST } = await import('@/app/api/finance/sync/route');
    const response = await POST(new Request('http://localhost/api/finance/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
        'x-mc-api-key': 'test-finance-api-key',
      },
      body: JSON.stringify({
        connectorId: 'persisted-finance',
        insightBackfill: { idempotencyKey: 'invented-operator-key' },
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Connector has an active operation',
    });
  });

  it('reports bridge authentication, active retry, freshness, and successful window', async () => {
    const connector = {
      id: 'persisted-finance',
      type: 'finance-manager',
      enabled: true,
      pollIntervalMinutes: 240,
    };
    mocks.configFromRow.mockReturnValue({ id: connector.id, settings: {}, credentials: {} });
    mocks.getHealth.mockResolvedValue({
      contractVersion: '1.0',
      status: 'ok',
      mode: 'live',
      reachable: true,
      authenticated: true,
      authState: 'connected',
    });
    const datasetNames = [
      'accounts',
      'category-groups',
      'categories',
      'tags',
      'recurring',
      'budgets',
    ] as const;
    const projectionDatasets = datasetNames.map((dataset, index) => ({
      dataset,
      provenance: 'monarch-bridge',
      state: dataset === 'tags' ? 'partial' : 'fresh',
      itemCount: index,
      sourceLimit: 1_000 + index,
      coverage: dataset === 'budgets'
        ? { start: '2026-08-01', end: '2026-08-31' }
        : null,
      lastAttemptAt: '2026-08-10T12:01:00.000Z',
      lastSuccessfulAt: '2026-08-10T12:01:00.000Z',
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      freshUntil: '2026-08-11T12:00:00.000Z',
      generationId: `generation-${index}`,
      schemaVersion: '1.0',
      configVersion: 1,
      warning: dataset === 'tags' ? 'invalid_contract' : null,
    }));
    mocks.getDatasetHealth.mockResolvedValue({
      aggregate: 'partial',
      datasets: projectionDatasets,
    });
    mocks.getConnector.mockResolvedValue(connector);
    mocks.readHealthSnapshot.mockResolvedValue({
      sync: {
        status: 'succeeded',
        lastAttemptAt: '2026-08-10T01:00:00.000Z',
        lastSuccessfulSyncAt: new Date().toISOString(),
        lastSuccessfulWindowStart: '2026-08-01',
        lastSuccessfulWindowEnd: '2026-08-10',
        lastErrorCode: null,
      },
      attribution: {
        status: 'healthy',
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        lastErrorCode: null,
        policyVersion: 7,
        engineVersion: '1.0.0',
      },
      activeJob: {
        id: 'job-1',
        status: 'queued',
        attempt: 1,
        maxAttempts: 3,
        availableAt: '2026-08-10T01:05:00.000Z',
        startedAt: null,
      },
      capture: {
        status: 'captured',
        lastAttemptAt: '2026-08-10T12:02:00.000Z',
        lastErrorCode: null,
      },
      evaluation: {
        status: 'evaluating',
        stage: 'evaluation-requested',
        lastAttemptAt: '2026-08-10T12:03:00.000Z',
        lastSuccessfulAt: '2026-08-10T12:03:00.000Z',
        lastErrorCode: null,
        retryable: false,
      },
    });
    const { GET } = await import('@/app/api/connectors/[id]/health/route');

    const response = await GET({
      url: 'http://next-internal:3099/api/connectors/persisted-finance/health',
      headers: new Headers({
        host: 'next-internal:3099',
        'x-forwarded-host': 'mc.example',
        'x-forwarded-proto': 'https',
        referer: 'https://mc.example/finance',
        'sec-fetch-site': 'same-origin',
      }),
    } as Request, {
      params: Promise.resolve({ id: connector.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      overall: 'degraded',
      bridge: {
        reachable: true,
        authenticated: true,
        authState: 'connected',
      },
      sync: {
        status: 'succeeded',
        lastSuccessfulWindow: { start: '2026-08-01', end: '2026-08-10' },
        activeJob: {
          id: 'job-1',
          retrying: true,
          attempt: 1,
          maxAttempts: 3,
        },
      },
      attribution: {
        status: 'healthy',
        policyVersion: 7,
        engineVersion: '1.0.0',
      },
      insights: {
        capture: {
          status: 'captured',
          lastAttemptAt: '2026-08-10T12:02:00.000Z',
          lastErrorCode: null,
        },
        evaluation: {
          status: 'evaluating',
          stage: 'evaluation-requested',
          lastErrorCode: null,
          retryable: false,
        },
      },
      projection: {
        aggregate: 'partial',
        datasets: projectionDatasets,
      },
    });
    expect(body.projection.datasets.map((dataset: { dataset: string }) => dataset.dataset))
      .toEqual(datasetNames);
    expect(body.projection.datasets[5]).toMatchObject({
      dataset: 'budgets',
      itemCount: 5,
      sourceLimit: 1_005,
      coverage: { start: '2026-08-01', end: '2026-08-31' },
      lastSuccessfulAt: '2026-08-10T12:01:00.000Z',
      sourceAsOf: '2026-08-10T12:00:00.000Z',
      freshUntil: '2026-08-11T12:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /accountBalance|currentBalance|accessToken|responseBody|lastErrorMessage|publicationId|sourceSequence|detectorSetVersion/,
    );
  });

  it('reports only sanitized Finance insight evaluation failures', async () => {
    const connector = {
      id: 'persisted-finance',
      type: 'finance-manager',
      enabled: true,
      pollIntervalMinutes: 240,
    };
    mocks.configFromRow.mockReturnValue({ id: connector.id, settings: {}, credentials: {} });
    mocks.getHealth.mockResolvedValue({
      status: 'ok',
      mode: 'live',
      reachable: true,
      authenticated: true,
      authState: 'connected',
    });
    mocks.getDatasetHealth.mockResolvedValue({ aggregate: 'fresh', datasets: [] });
    mocks.getConnector.mockResolvedValue(connector);
    mocks.readHealthSnapshot.mockResolvedValue({
      sync: {
        status: 'succeeded',
        lastAttemptAt: null,
        lastSuccessfulSyncAt: new Date().toISOString(),
        lastSuccessfulWindowStart: null,
        lastSuccessfulWindowEnd: null,
        lastErrorCode: null,
      },
      attribution: {
        status: 'healthy',
        lastAttemptAt: null,
        lastSuccessfulAt: null,
        lastErrorCode: null,
        policyVersion: null,
        engineVersion: null,
      },
      activeJob: null,
      capture: {
        status: 'captured',
        lastAttemptAt: '2026-08-10T12:02:00.000Z',
        lastErrorCode: null,
      },
      evaluation: {
        status: 'unavailable',
        stage: 'evaluation-requested',
        lastAttemptAt: '2026-08-10T12:03:00.000Z',
        lastSuccessfulAt: null,
        lastErrorCode: 'finance_insight_evaluation_unavailable',
        retryable: true,
      },
    });
    const { GET } = await import('@/app/api/connectors/[id]/health/route');

    const response = await GET(new Request(
      'http://localhost/api/connectors/persisted-finance/health',
      { headers: { 'x-mc-api-key': 'test-finance-api-key' } },
    ), { params: Promise.resolve({ id: connector.id }) });
    const body = await response.json();

    expect(body).toMatchObject({
      overall: 'degraded',
      insights: {
        evaluation: {
          status: 'unavailable',
          stage: 'evaluation-requested',
          lastErrorCode: 'finance_insight_evaluation_unavailable',
          retryable: true,
        },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/private-publication|sourceSequence/);
  });

  it.each([
    'finance',
    'finance-manager',
    'monarch-money',
  ])('fails closed for a cross-site %s health request', async (type) => {
    const connector = {
      id: 'persisted-finance',
      type,
      enabled: true,
    };
    mocks.getConnector.mockResolvedValueOnce(connector);
    const { GET } = await import('@/app/api/connectors/[id]/health/route');

    const response = await GET(new Request('https://mc.example/api/connectors/persisted-finance/health', {
      headers: {
        host: 'mc.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    }), { params: Promise.resolve({ id: connector.id }) });

    expect(response.status).toBe(403);
    expect(mocks.getHealth).not.toHaveBeenCalled();
  });

  it('does not expose unexpected health errors', async () => {
    mocks.getConnector.mockImplementationOnce(() => {
      throw new Error('private token and upstream response body');
    });
    const { GET } = await import('@/app/api/connectors/[id]/health/route');

    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'persisted-finance' }),
    });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'Failed to check connector health',
      code: 'health_check_failed',
    });
    expect(JSON.stringify(body)).not.toMatch(/private token|response body|detail/i);
  });

  it('reports a precise server-only Tyrion credential requirement', async () => {
    const { describeTyrionConnectionError } = await import(
      '@/lib/connectors/monarch-money/connection-error'
    );

    expect(describeTyrionConnectionError({ code: 'missing_server_credential' }))
      .toBe('Tyrion service token is not configured. Enter it in connector setup or set FINANCE_MANAGER_API_TOKEN on the server.');
  });

  it('identifies a URL that does not expose the Tyrion v1 contract', async () => {
    const { describeTyrionConnectionError } = await import(
      '@/lib/connectors/monarch-money/connection-error'
    );

    expect(describeTyrionConnectionError({ code: 'invalid_contract' }))
      .toBe('The configured Tyrion service does not expose the Monarch Bridge v1 API.');
  });

  it.each([
    'finance',
    'finance-manager',
    'monarch-money',
  ])('returns actionable guidance for an unsafe persisted %s bridge URL', async (type) => {
    const { MonarchBridgeError } = await import('@/lib/connectors/monarch-money/client');
    mocks.getConnector.mockResolvedValueOnce({
      id: 'persisted-finance',
      type,
      enabled: true,
      settings: { bridgeUrl: 'https://tyrion.example' },
      credentials: {},
    });
    mocks.configFromRow.mockReturnValue({
      id: 'persisted-finance',
      settings: { bridgeUrl: 'https://tyrion.example' },
      credentials: {},
    });
    mocks.getHealth.mockRejectedValue(
      new MonarchBridgeError('invalid_bridge_url', 'private detail', false),
    );
    const { POST } = await import('@/app/api/connectors/[id]/test/route');

    const response = await POST(new Request('http://localhost/api/connectors/persisted-finance/test', {
      method: 'POST',
      headers: { 'x-mc-api-key': 'test-finance-api-key' },
    }), {
      params: Promise.resolve({ id: 'persisted-finance' }),
    });

    expect(await response.json()).toMatchObject({
      success: false,
      error: 'Tyrion Bridge API URL is invalid. Edit the connector and enter its protected Bridge v1 base URL.',
    });
    expect(mocks.recordTestResult).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'persisted-finance',
      status: 'failed',
    }));
  });

  it('rejects an untrusted finance connector test before any provider I/O', async () => {
    mocks.getConnector.mockResolvedValueOnce({
      id: 'persisted-finance',
      type: 'finance-manager',
      enabled: true,
      settings: {},
      credentials: {},
    });
    const { POST } = await import('@/app/api/connectors/[id]/test/route');

    const response = await POST(new Request('https://mc.example/api/connectors/persisted-finance/test', {
      method: 'POST',
      headers: {
        host: 'mc.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    }), { params: Promise.resolve({ id: 'persisted-finance' }) });

    expect(response.status).toBe(403);
    expect(mocks.getHealth).not.toHaveBeenCalled();
    expect(mocks.recordTestResult).not.toHaveBeenCalled();
  });
});
