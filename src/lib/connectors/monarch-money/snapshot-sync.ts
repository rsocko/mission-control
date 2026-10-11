import 'server-only';

import { randomUUID } from 'node:crypto';
import { FinanceWebPersistenceError } from '@/db/persistence/finance-web';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorConfig,
} from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from './client';
const MUTATION_CLAIM_STALE_MS = 15 * 60_000;

export { FinanceSnapshotSynchronizer } from './snapshot-synchronizer';

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof MonarchBridgeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && /cancel/i.test(error.message)) {
    return { code: 'sync_cancelled', message: 'Finance sync was cancelled' };
  }
  return { code: 'sync_failed', message: 'Finance snapshot sync failed' };
}

export async function updateFinanceCategory(
  config: ConnectorConfig,
  transactionId: string,
  categoryId: string,
  idempotencyKey: string = randomUUID(),
  signal?: AbortSignal,
  expectedTransactionVersion?: {
    sourceFingerprint: string;
    lastSeenAt: string;
    assignedKidId: string | null;
    confirmedCategory: string | null;
    manualDecidedAt: string | null;
    categoryName: string;
  },
): Promise<{ idempotencyKey: string; status: 'updated' }> {
  const now = new Date().toISOString();
  const web = (await getWorkerPersistenceRepositories()).finance.web;
  let claim;
  try {
    claim = await web.claimCategoryUpdate({
      connectorId: config.id,
      transactionId,
      categoryId,
      idempotencyKey,
      now,
      staleBefore: new Date(Date.now() - MUTATION_CLAIM_STALE_MS).toISOString(),
      expectedTransactionVersion,
    });
  } catch (error) {
    if (error instanceof FinanceWebPersistenceError) {
      throw new MonarchBridgeError(
        error.code,
        error.message,
        error.retryable,
        error.status,
      );
    }
    throw error;
  }
  if (claim.outcome === 'replayed') return { idempotencyKey, status: 'updated' };

  try {
    await new MonarchBridgeClient(config).updateCategory(
      claim.upstreamTransactionId,
      categoryId,
      signal,
    );
    const completedAt = new Date().toISOString();
    const completed = await web.completeCategoryUpdate({
      connectorId: config.id,
      transactionId,
      categoryId,
      idempotencyKey,
      claimToken: claim.claimToken,
      completedAt,
    });
    if (!completed) {
      throw new MonarchBridgeError(
        'mutation_claim_lost',
        'Category update claim was superseded',
        true,
        409,
      );
    }
    return { idempotencyKey, status: 'updated' };
  } catch (error) {
    const failure = errorDetails(error);
    await web.failCategoryUpdate({
      connectorId: config.id,
      idempotencyKey,
      claimToken: claim.claimToken,
      errorCode: failure.code,
      errorMessage: failure.message,
      failedAt: new Date().toISOString(),
    });
    throw error;
  }
}
