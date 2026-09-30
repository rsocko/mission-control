import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RyMessageActionPersistenceError } from '@/db/persistence/rymessage-actions';

const mocks = vi.hoisted(() => ({
  getConnector: vi.fn(),
  readStatus: vi.fn(),
  enqueueMutation: vi.fn(),
}));

vi.mock('@/lib/api/trusted-request', () => ({
  isTrustedMutationRequest: () => true,
}));
vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    connectors: { get: mocks.getConnector },
  }),
}));
vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectorState: {
      rymessageActions: {
        readStatus: mocks.readStatus,
        enqueueMutation: mocks.enqueueMutation,
      },
    },
  }),
}));

import { GET, POST } from '@/app/api/connectors/[id]/rymessage-actions/route';

const CONNECTOR_ID = 'rymessage-route';
const ACTION_ID = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '00000000-0000-4000-8000-000000000002';

function context() {
  return { params: Promise.resolve({ id: CONNECTOR_ID }) };
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/connectors/rymessage-route/rymessage-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('RyMessage action route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnector.mockResolvedValue({
      id: CONNECTOR_ID,
      type: 'rymessage',
      enabled: true,
      deletedAt: null,
      settings: { mode: 'companion' },
    });
    mocks.enqueueMutation.mockResolvedValue('queued');
    mocks.readStatus.mockResolvedValue({
      projectionCount: 1,
      conflictCount: 0,
      mutationConflictCount: 2,
    });
  });

  it('returns bounded reconciliation status for Companion connectors', async () => {
    const response = await GET(new Request('http://localhost'), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      projectionCount: 1,
      mutationConflictCount: 2,
    });
  });

  it('requires stable mutation identity and rejects account scope and observations', async () => {
    const base = {
      operationId: OPERATION_ID,
      actionId: ACTION_ID,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed' } },
    };
    for (const body of [
      { ...base, operationId: undefined },
      { ...base, accountId: 'caller-scope' },
      {
        ...base,
        mutation: {
          kind: 'materialization.observe',
          materializationId: '00000000-0000-4000-8000-000000000003',
          observedAt: '2026-09-29T23:00:00.000Z',
        },
      },
    ]) {
      const response = await POST(request(body), context());
      expect(response.status).toBe(400);
    }
    expect(mocks.enqueueMutation).not.toHaveBeenCalled();
  });

  it('queues allowed mutations without forwarding an account selector', async () => {
    const response = await POST(request({
      operationId: OPERATION_ID,
      actionId: ACTION_ID,
      baseRevision: 2,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed' } },
    }), context());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      operationId: OPERATION_ID,
      queued: true,
    });
    expect(mocks.enqueueMutation).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: CONNECTOR_ID,
      operationId: OPERATION_ID,
      actionId: ACTION_ID,
    }));
    expect(mocks.enqueueMutation.mock.calls[0]![0]).not.toHaveProperty('accountId');
  });

  it('surfaces idempotency conflicts and payload limits', async () => {
    mocks.enqueueMutation.mockRejectedValueOnce(new RyMessageActionPersistenceError(
      'IDEMPOTENCY_CONFLICT',
      'Mutation identity was reused with different content',
    ));
    const body = {
      operationId: OPERATION_ID,
      actionId: ACTION_ID,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed' } },
    };
    const conflict = await POST(request(body), context());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const oversized = new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-length': String(33 * 1024) },
      body: '{}',
    });
    expect((await POST(oversized, context())).status).toBe(413);
  });
});
