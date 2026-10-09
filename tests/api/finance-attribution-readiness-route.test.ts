import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trustedRead: vi.fn(),
  mutationActor: vi.fn(),
  getReadiness: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('@/lib/connectors/monarch-money/finance-request', () => ({
  isTrustedFinanceReadRequest: mocks.trustedRead,
  trustedFinanceMutationActor: mocks.mutationActor,
}));

vi.mock('@/lib/connectors/monarch-money/attribution-readiness', () => {
  class FinanceAttributionReadinessError extends Error {
    constructor(
      readonly code: string,
      readonly status = 409,
    ) {
      super(code);
    }
  }
  return {
    FinanceAttributionReadinessError,
    getFinanceAttributionPolicyReadiness: mocks.getReadiness,
    previewFinanceAttributionPolicy: mocks.preview,
  };
});

import {
  GET,
  POST,
} from '@/app/api/connectors/[id]/finance/attribution-readiness/route';
import {
  FinanceAttributionReadinessError,
} from '@/lib/connectors/monarch-money/attribution-readiness';

function context() {
  return { params: Promise.resolve({ id: 'finance-connector' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustedRead.mockReturnValue(true);
  mocks.mutationActor.mockReturnValue('parent-admin');
});

describe('finance attribution readiness route', () => {
  it('returns the trusted account handoff without accepting an untrusted read', async () => {
    mocks.getReadiness.mockResolvedValue({ accounts: [] });
    const trusted = await GET(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance/attribution-readiness',
      ),
      context(),
    );
    expect(trusted.status).toBe(200);
    await expect(trusted.json()).resolves.toEqual({ accounts: [] });

    mocks.trustedRead.mockReturnValue(false);
    const forbidden = await GET(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance/attribution-readiness',
      ),
      context(),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.getReadiness).toHaveBeenCalledTimes(1);
  });

  it('requires a trusted mutation actor before running the no-write preview', async () => {
    mocks.mutationActor.mockReturnValue(null);
    const response = await POST(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance/attribution-readiness',
        { method: 'POST' },
      ),
      context(),
    );

    expect(response.status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('returns only the aggregate preview response', async () => {
    mocks.preview.mockResolvedValue({
      totalTransactions: 2,
      evaluated: 2,
      ready: true,
      counts: { reason: {} },
    });
    const response = await POST(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance/attribution-readiness',
        { method: 'POST' },
      ),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      totalTransactions: 2,
      evaluated: 2,
      ready: true,
      counts: { reason: {} },
    });
    expect(mocks.preview).toHaveBeenCalledWith('finance-connector');
  });

  it('maps stable readiness failures without exposing exception details', async () => {
    mocks.preview.mockRejectedValue(
      new FinanceAttributionReadinessError('policy_conflict', 409),
    );
    const response = await POST(
      new NextRequest(
        'http://localhost/api/connectors/finance-connector/finance/attribution-readiness',
        { method: 'POST' },
      ),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'policy_conflict' });
  });
});
