import 'server-only';

import { syncLogger } from '@/lib/logger';
import { syncScheduler } from '@/lib/sync';
import {
  isDurableSyncMode,
} from '@/lib/sync/job-runtime';

export function requestFinanceAttributionRetry(connectorId: string): void {
  if (isDurableSyncMode()) {
    return;
  }

  void syncScheduler.queueFollowUpSync(connectorId).catch((err) => {
    syncLogger.warn({ err, connectorId }, 'Failed to queue finance attribution retry sync');
  });
}
