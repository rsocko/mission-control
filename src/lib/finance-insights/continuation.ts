import 'server-only';

import type { SyncJob } from '@/lib/sync/job-repository';

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

export async function enqueueFinanceInsightContinuation(input: {
  connectorId: string;
  jobId: string;
  now?: Date;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<SyncJob> {
  const now = input.now ?? new Date();
  const [
    { getConnectorOperationLeaseRepository },
    { getSyncJobRepository },
  ] = await Promise.all([
    import('@/lib/sync/connector-lock'),
    import('@/lib/sync/job-queue'),
  ]);
  const hasLease = await (await getConnectorOperationLeaseRepository()).hasActiveSyncJobLease({
    connectorId: input.connectorId,
    jobId: input.jobId,
    at: now.toISOString(),
  });
  if (!hasLease) {
    throw new Error('finance_insight_continuation_lease_unavailable');
  }
  const availableAt = new Date(now.getTime() + continuationDelayMs(input.environment));
  return (await getSyncJobRepository()).enqueue(input.connectorId, {
    availableAt: availableAt.toISOString(),
    scheduledFor: availableAt.toISOString(),
    source: 'recovery',
  });
}
