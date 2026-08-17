import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock('@/lib/api/trusted-request', () => ({
  isTrustedMutationRequest: mocks.trusted,
}));

vi.mock('@/lib/connectors/github-issues/bulk-transfer-service', () => ({
  abortGitHubBulkTransfer: vi.fn(),
  executeGitHubBulkTransfer: vi.fn(),
  getGitHubBulkTransferStatus: vi.fn(),
  previewGitHubBulkTransfer: vi.fn(),
  reconcileGitHubBulkTransferItem: mocks.reconcile,
}));

vi.mock('@/lib/connectors/github-issues/repoint-service', () => ({
  inspectGitHubRepointBackup: vi.fn(),
}));

import { POST } from '@/app/api/connectors/github-bulk-transfer/route';

function request(body: unknown): Request {
  return new Request('https://mc.example/api/connectors/github-bulk-transfer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GitHub bulk transfer API', () => {
  beforeEach(() => {
    mocks.reconcile.mockReset();
    mocks.trusted.mockReset();
    mocks.trusted.mockReturnValue(true);
  });

  it('passes reviewed successor authorization to ambiguous-write reconciliation', async () => {
    const successorAuthorization = {
      expectedSourceStableIdDigest: 'a'.repeat(64),
      expectedSuccessorStableIdDigest: 'b'.repeat(64),
      reason: 'Reviewed native-transfer successor identity',
      idempotencyKey: 'successor-reconcile-836',
    };
    mocks.reconcile.mockResolvedValue({ phase: 'failed', ambiguousCount: 0 });

    const response = await POST(request({
      action: 'reconcile',
      runId: '7a634a4d-ce42-4e31-84b3-25117f7d12c9',
      taskId: 'task-836',
      targetNumber: 42,
      actor: 'operator',
      confirmation: 'reconcile',
      successorAuthorization,
    }));

    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      action: 'reconcile',
      runId: '7a634a4d-ce42-4e31-84b3-25117f7d12c9',
      taskId: 'task-836',
      targetNumber: 42,
      actor: 'operator',
      confirmation: 'reconcile',
      successorAuthorization,
    });
  });

  it('rejects incomplete successor authorization', async () => {
    const response = await POST(request({
      action: 'reconcile',
      runId: '7a634a4d-ce42-4e31-84b3-25117f7d12c9',
      taskId: 'task-836',
      targetNumber: 42,
      actor: 'operator',
      confirmation: 'reconcile',
      successorAuthorization: {
        expectedSourceStableIdDigest: 'a'.repeat(64),
      },
    }));

    expect(response.status).toBe(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
