import 'server-only';

import { hasConnectorSyncJobLease } from '@/lib/sync/connector-lock';
import { enqueueSyncJob, type SyncJob } from '@/lib/sync/job-queue';

const DEFAULT_CONTINUATION_DELAY_MS = 30_000;
const MAX_CONTINUATION_DELAY_MS = 15 * 60_000;

function continuationDelayMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(environment.TYRION_FINANCE_INSIGHTS_CONTINUATION_DELAY_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_CONTINUATION_DELAY_MS)
    : DEFAULT_CONTINUATION_DELAY_MS;
}

export function enqueueFinanceInsightContinuation(input: {
  connectorId: string;
  jobId: string;
  now?: Date;
  environment?: Readonly<Record<string, string | undefined>>;
}): SyncJob {
  const now = input.now ?? new Date();
  if (!hasConnectorSyncJobLease(input.connectorId, input.jobId, now.toISOString())) {
    throw new Error('finance_insight_continuation_lease_unavailable');
  }
  const availableAt = new Date(now.getTime() + continuationDelayMs(input.environment));
  return enqueueSyncJob(input.connectorId, {
    availableAt,
    scheduledFor: availableAt,
    source: 'recovery',
  });
}
