import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  abortGitHubBulkTransfer,
  executeGitHubBulkTransfer,
  getGitHubBulkTransferStatus,
  previewGitHubBulkTransfer,
  reconcileGitHubBulkTransferItem,
} from '@/lib/connectors/github-issues/bulk-transfer-service';
import { inspectGitHubRepointBackup } from '@/lib/connectors/github-issues/repoint-service';

const repository = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = z.object({
  connectorInstanceId: z.string().min(1).max(100),
  sourceRepository: repository,
  targetRepository: repository,
  actor: z.string().min(1).max(80),
  backupPath: z.string().min(1).max(2_048),
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
      return NextResponse.json(getGitHubBulkTransferStatus(input.runId));
    }
    if (input.action === 'abort') {
      return NextResponse.json(abortGitHubBulkTransfer(input.runId, input.actor));
    }
    if (input.action === 'reconcile') {
      return NextResponse.json(await reconcileGitHubBulkTransferItem(input));
    }
    const backupProof = await inspectGitHubRepointBackup(input.backupPath);
    const commonInput = {
      connectorInstanceId: input.connectorInstanceId,
      sourceRepository: input.sourceRepository,
      targetRepository: input.targetRepository,
      actor: input.actor,
      backupProof,
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
