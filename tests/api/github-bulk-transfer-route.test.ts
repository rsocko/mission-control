import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  inspectBackup: vi.fn(),
  preview: vi.fn(),
  reconcile: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock('@/lib/api/trusted-request', () => ({
  isTrustedMutationRequest: mocks.trusted,
}));

vi.mock('@/lib/connectors/github-issues/bulk-transfer-service', () => ({
  abortGitHubBulkTransfer: vi.fn(),
  executeGitHubBulkTransfer: mocks.execute,
  getGitHubBulkTransferStatus: vi.fn(),
  previewGitHubBulkTransfer: mocks.preview,
  reconcileGitHubBulkTransferItem: mocks.reconcile,
}));

vi.mock('@/lib/connectors/github-issues/backup-verifier', () => ({
  inspectGitHubRepointBackup: mocks.inspectBackup,
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
    mocks.execute.mockReset();
    mocks.inspectBackup.mockReset();
    mocks.preview.mockReset();
    mocks.trusted.mockReset();
    mocks.trusted.mockReturnValue(true);
    mocks.inspectBackup.mockResolvedValue({ sha256: 'b'.repeat(64) });
  });

  it('requires explicit reviewed-allowlist or all-issues scope', async () => {
    const response = await POST(request({
      action: 'preview',
      connectorInstanceId: 'github',
      sourceRepository: 'owner/source',
      targetRepository: 'owner/target',
      actor: 'operator',
      backupPath: 'backup.db',
    }));

    expect(response.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('rejects duplicate reviewed node IDs before preview', async () => {
    const response = await POST(request({
      action: 'preview',
      connectorInstanceId: 'github',
      sourceRepository: 'owner/source',
      targetRepository: 'owner/target',
      actor: 'operator',
      backupPath: 'backup.db',
      scope: {
        mode: 'reviewed-allowlist',
        sourceRepository: 'owner/source',
        manifestSha256: 'a'.repeat(64),
        issueNodeIds: ['I_1', 'I_1'],
      },
    }));

    expect(response.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('passes the reviewed manifest scope to preview', async () => {
    const scope = {
      mode: 'reviewed-allowlist',
      sourceRepository: 'owner/source',
      manifestSha256: 'a'.repeat(64),
      issueNodeIds: ['I_1', 'I_2'],
    };
    mocks.preview.mockResolvedValue({ go: true, items: [] });

    const response = await POST(request({
      action: 'preview',
      connectorInstanceId: 'github',
      sourceRepository: 'owner/source',
      targetRepository: 'owner/target',
      actor: 'operator',
      backupPath: 'backup.db',
      scope,
    }));

    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ scope }));
  });

  it('passes externally verified PostgreSQL backup evidence without opening SQLite', async () => {
    const backupAttestation = {
      path: 'approved-backup://mission-control/2026-08-30',
      sha256: 'b'.repeat(64),
      sizeBytes: 4096,
      modifiedAt: '2026-08-30T19:00:00.000Z',
      integrityCheck: 'ok',
      verifiedAt: '2026-08-30T19:05:00.000Z',
      source: 'external-preverified',
    };
    mocks.preview.mockResolvedValue({ go: true, items: [] });

    const response = await POST(request({
      action: 'preview',
      connectorInstanceId: 'github',
      sourceRepository: 'owner/source',
      targetRepository: 'owner/target',
      actor: 'operator',
      backupAttestation,
      scope: { mode: 'all-issues' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.inspectBackup).not.toHaveBeenCalled();
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ backupProof: backupAttestation }),
    );
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
