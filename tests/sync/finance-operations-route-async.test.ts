import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  quarantine: vi.fn(),
  enqueueCanary: vi.fn(),
  release: vi.fn(),
  rollback: vi.fn(),
  getCutoverReadiness: vi.fn(),
  inventoryCleanBootstrap: vi.fn(),
  applyCleanBootstrap: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/finance-request', () => ({
  isTrustedFinanceReadRequest: () => true,
  trustedFinanceMutationActor: () => 'service',
}));

vi.mock('@/lib/sync/operator-control', () => {
  class SyncOperatorError extends Error {
    constructor(
      readonly code: string,
      readonly status = 409,
    ) {
      super(code);
    }
  }
  return {
    SyncOperatorError,
    getFinanceSyncControlStatus: mocks.getStatus,
    quarantineFinanceConnectorSync: mocks.quarantine,
    enqueueFinanceOperatorCanary: mocks.enqueueCanary,
    releaseFinanceConnectorQuarantine: mocks.release,
    rollbackFinanceOperatorCanary: mocks.rollback,
  };
});

vi.mock('@/lib/finance-insights/cutover-operator', () => {
  class FinanceCutoverOperatorError extends Error {
    constructor(
      readonly code: string,
      readonly status = 409,
    ) {
      super(code);
    }
  }
  return {
    FinanceCutoverOperatorError,
    getFinanceInsightCutoverReadiness: mocks.getCutoverReadiness,
    enableFinanceInsightCutoverForOperator: vi.fn(),
    rollbackFinanceInsightCutoverForOperator: vi.fn(),
  };
});

vi.mock('@/lib/connectors/monarch-money/clean-bootstrap', () => ({
  inventoryFinanceCleanBootstrap: mocks.inventoryCleanBootstrap,
  applyFinanceCleanBootstrap: mocks.applyCleanBootstrap,
  cleanBootstrapErrorResponse: () => null,
}));

import { GET, POST } from '@/app/api/connectors/[id]/finance-operations/route';
import { SyncOperatorError } from '@/lib/sync/operator-control';

function context(id = 'finance-connector') {
  return { params: Promise.resolve({ id }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCutoverReadiness.mockResolvedValue({ ready: true });
});

describe('finance operator route async compatibility', () => {
  it('awaits status before evaluating cutover readiness and preserves the body', async () => {
    const status = deferred<{ scheduler: { state: string } }>();
    mocks.getStatus.mockReturnValue(status.promise);
    const responsePromise = GET(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance-operations'
        + '?sourceGeneration=publication-generation',
      ),
      context(),
    );

    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    expect(mocks.getCutoverReadiness).not.toHaveBeenCalled();

    status.resolve({ scheduler: { state: 'scheduled' } });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sync: { scheduler: { state: 'scheduled' } },
      cutover: { ready: true },
    });
    expect(mocks.getCutoverReadiness).toHaveBeenCalledWith(
      'finance-connector',
      'publication-generation',
    );
  });

  it('requires an explicit source generation for readiness', async () => {
    mocks.getStatus.mockResolvedValue({ scheduler: { state: 'scheduled' } });
    const response = await GET(
      new NextRequest('http://localhost/api/connectors/finance-connector/finance-operations'),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'finance_insight_cutover_generation_required',
    });
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.getCutoverReadiness).not.toHaveBeenCalled();
  });

  it('awaits operator failures so existing error mapping handles rejections', async () => {
    mocks.quarantine.mockRejectedValue(
      new SyncOperatorError('sync_quarantine_active_job', 409),
    );
    const response = await POST(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance-operations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'route-operator-key-123456',
          },
          body: JSON.stringify({ action: 'quarantine-scheduler' }),
        },
      ),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'sync_quarantine_active_job',
    });
  });

  it('preserves the accepted canary response shape after awaiting the job', async () => {
    mocks.enqueueCanary.mockResolvedValue({
      job: {
        id: 'canary-job',
        status: 'queued',
        source: 'operator-canary',
        maxAttempts: 1,
      },
      replayed: false,
    });
    const response = await POST(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance-operations',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'route-canary-key-1234567',
          },
          body: JSON.stringify({ action: 'authorize-canary' }),
        },
      ),
      context(),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      jobId: 'canary-job',
      status: 'queued',
      source: 'operator-canary',
      maxAttempts: 1,
      replayed: false,
    });
  });

  it('passes only aggregate dry-run identity and exact apply confirmation', async () => {
      mocks.inventoryCleanBootstrap.mockResolvedValue({
        mode: 'dry-run',
        dryRunId: '8c72cdf4-676e-4744-b7fc-d01fd49f08a3',
        connectorId: 'finance-connector',
        inventory: { manualAttributionDecisions: 0 },
        scopeDigest: 'a'.repeat(64),
        confirmationToken: 'b'.repeat(64),
        replayed: false,
      });
      const inventoryResponse = await POST(
        new NextRequest(
          'http://localhost/api/connectors/finance-connector/finance-operations',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': 'route-bootstrap-dry-run-123',
            },
            body: JSON.stringify({ action: 'inventory-clean-bootstrap' }),
          },
        ),
        context(),
      );
      expect(inventoryResponse.status).toBe(200);
      expect(mocks.inventoryCleanBootstrap).toHaveBeenCalledWith({
        connectorId: 'finance-connector',
        actorType: 'service',
        idempotencyKey: 'route-bootstrap-dry-run-123',
      });

      mocks.applyCleanBootstrap.mockResolvedValue({ mode: 'apply', replayed: false });
      const applyResponse = await POST(
        new NextRequest(
          'http://localhost/api/connectors/finance-connector/finance-operations',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': 'route-bootstrap-apply-12345',
            },
            body: JSON.stringify({
              action: 'apply-clean-bootstrap',
              dryRunId: '8c72cdf4-676e-4744-b7fc-d01fd49f08a3',
              scopeDigest: 'a'.repeat(64),
              confirmationToken: 'b'.repeat(64),
            }),
          },
        ),
        context(),
      );
      expect(applyResponse.status).toBe(200);
      expect(mocks.applyCleanBootstrap).toHaveBeenCalledWith({
        connectorId: 'finance-connector',
        actorType: 'service',
        idempotencyKey: 'route-bootstrap-apply-12345',
        dryRunId: '8c72cdf4-676e-4744-b7fc-d01fd49f08a3',
        scopeDigest: 'a'.repeat(64),
        confirmationToken: 'b'.repeat(64),
    });
  });
});
