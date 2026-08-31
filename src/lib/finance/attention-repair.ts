import 'server-only';

import { randomUUID } from 'node:crypto';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
import logger from '@/lib/logger';
import {
  FINANCE_ATTENTION_REPAIR_CONFIRMATION,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  FinanceAttentionRepairError,
  type FinanceAttentionRepairMode,
  type FinanceAttentionRepairResult,
} from '@/db/persistence/finance-attention';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export {
  FINANCE_ATTENTION_REPAIR_CONFIRMATION,
  FINANCE_ATTENTION_REPAIR_CUTOVER,
  FINANCE_ATTENTION_REPAIR_REASON,
  FINANCE_ATTENTION_REPAIR_WINDOW_START,
  FinanceAttentionRepairError,
};
export type { FinanceAttentionRepairResult };

/**
 * Idempotently repairs the finance attention projection left behind by the
 * `attribution_not_configured` incident window. Validation that needs no
 * data read (idempotency-key shape, exact apply confirmation phrase) happens
 * here before the adapter's single atomic transaction runs the dry-run/apply
 * scope fence, the in-flight delivery fence, and (on apply) the write.
 */
export async function repairAttributionNotConfiguredAttention(input: {
  connectorId: string;
  mode: FinanceAttentionRepairMode;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  dryRunId?: string;
  confirmation?: string;
  now?: Date;
}): Promise<FinanceAttentionRepairResult> {
  const idempotencyKey = input.idempotencyKey?.trim() ?? '';
  if (idempotencyKey.length < 8 || idempotencyKey.length > 192) {
    throw new FinanceAttentionRepairError(
      'invalid_repair_idempotency_key',
      'A valid idempotency-key header is required',
      400,
    );
  }
  if (
    input.mode === 'apply'
    && input.confirmation !== FINANCE_ATTENTION_REPAIR_CONFIRMATION
  ) {
    throw new FinanceAttentionRepairError(
      'repair_confirmation_required',
      'Exact repair confirmation is required',
      400,
    );
  }

  try {
    const persistence = (await getWorkerPersistenceRepositories()).finance.attention.repair;
    return await persistence.repair({
      connectorId: input.connectorId,
      mode: input.mode,
      actorType: input.actorType,
      idempotencyKey,
      dryRunId: input.mode === 'apply' ? (input.dryRunId?.trim() || null) : null,
      now: (input.now ?? new Date()).toISOString(),
      runId: randomUUID(),
    });
  } catch (error) {
    if (error instanceof FinanceAttentionRepairError) throw error;
    logger.error(
      {
        err: error,
        code: 'finance_attention_repair_failed',
        connectorId: input.connectorId,
        mode: input.mode,
      },
      'Finance attention projection repair failed',
    );
    throw new FinanceAttentionRepairError(
      'finance_attention_repair_failed',
      'Finance attention projection repair failed',
      500,
    );
  }
}
