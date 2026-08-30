import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { GitHubRecoveryBackupAttestation } from '@/db/persistence/github-recovery';
import { isBackupAttestationReady } from '@/db/persistence/github-recovery-values';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  abortGitHubBulkTransfer,
  executeGitHubBulkTransfer,
  getGitHubBulkTransferStatus,
  previewGitHubBulkTransfer,
  reconcileGitHubBulkTransferItem,
} from '@/lib/connectors/github-issues/bulk-transfer-service';
import { inspectGitHubRepointBackup } from '@/lib/connectors/github-issues/backup-verifier';

const repository = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const externalBackupAttestation = z.object({
  path: z.string().min(1).max(2_048),
  sha256: sha256Digest,
  sizeBytes: z.number().int().positive().safe(),
  modifiedAt: z.iso.datetime({ offset: true }),
  integrityCheck: z.literal('ok'),
  verifiedAt: z.iso.datetime({ offset: true }),
  source: z.literal('external-preverified'),
}).strict();
const transferScope = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('reviewed-allowlist'),
    sourceRepository: repository,
    manifestSha256: sha256Digest,
    issueNodeIds: z.array(z.string().min(1).max(200)).min(1).max(10_000),
  }).strict(),
  z.object({ mode: z.literal('all-issues') }).strict(),
]).superRefine((scope, context) => {
  if (scope.mode === 'reviewed-allowlist') {
    if (
      new Set(scope.issueNodeIds.map((nodeId) => nodeId.trim())).size
      !== scope.issueNodeIds.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['issueNodeIds'],
        message: 'Duplicate issue node IDs are not allowed',
      });
    }
  }
});
const common = z.object({
  connectorInstanceId: z.string().min(1).max(100),
  sourceRepository: repository,
  targetRepository: repository,
  actor: z.string().min(1).max(80),
  backupPath: z.string().min(1).max(2_048).optional(),
  backupAttestation: externalBackupAttestation.optional(),
  scope: transferScope,
});
const requestSchema = z.discriminatedUnion('action', [
  common.extend({ action: z.literal('preview') }).strict(),
  common.extend({
    action: z.literal('execute'),
    idempotencyKey: z.string().min(8).max(192),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmation: z.string().min(1).max(500),
    concurrency: z.number().int().min(1).max(8).optional(),
  }).strict(),
  z.object({
    action: z.literal('status'),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal('abort'),
    runId: z.string().uuid(),
    actor: z.string().min(1).max(80),
    confirmation: z.literal('abort'),
  }).strict(),
  z.object({
    action: z.literal('reconcile'),
    runId: z.string().uuid(),
    taskId: z.string().min(1).max(200),
    targetNumber: z.number().int().positive(),
    actor: z.string().min(1).max(80),
    confirmation: z.literal('reconcile'),
    successorAuthorization: z.object({
      expectedSourceStableIdDigest: sha256Digest,
      expectedSuccessorStableIdDigest: sha256Digest,
      reason: z.string().min(3).max(500),
      idempotencyKey: z.string().min(8).max(192),
    }).strict().optional(),
  }).strict(),
]);

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid GitHub bulk transfer request' }, { status: 400 });
  }
  try {
    const input = parsed.data;
    if (input.action === 'status') {
      return NextResponse.json(await getGitHubBulkTransferStatus(input.runId));
    }
    if (input.action === 'abort') {
      return NextResponse.json(await abortGitHubBulkTransfer(input.runId, input.actor));
    }
    if (input.action === 'reconcile') {
      return NextResponse.json(await reconcileGitHubBulkTransferItem(input));
    }
    if (Boolean(input.backupPath) === Boolean(input.backupAttestation)) {
      return NextResponse.json(
        { error: 'Exactly one backup evidence source is required' },
        { status: 400 },
      );
    }
    let backupProof: GitHubRecoveryBackupAttestation;
    if (input.backupAttestation) {
      if (!isBackupAttestationReady(input.backupAttestation, new Date())) {
        return NextResponse.json(
          { error: 'Backup attestation must describe a recent snapshot and verification' },
          { status: 400 },
        );
      }
      backupProof = input.backupAttestation;
    } else {
      if (!input.backupPath) {
        return NextResponse.json(
          { error: 'Exactly one backup evidence source is required' },
          { status: 400 },
        );
      }
      backupProof = await inspectGitHubRepointBackup(input.backupPath);
    }
    const commonInput = {
      connectorInstanceId: input.connectorInstanceId,
      sourceRepository: input.sourceRepository,
      targetRepository: input.targetRepository,
      actor: input.actor,
      backupProof,
      scope: input.scope,
    };
    if (input.action === 'preview') {
      return NextResponse.json(await previewGitHubBulkTransfer(commonInput));
    }
    return NextResponse.json(await executeGitHubBulkTransfer({
      ...commonInput,
      idempotencyKey: input.idempotencyKey,
      planHash: input.planHash,
      confirmation: input.confirmation,
      concurrency: input.concurrency,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
