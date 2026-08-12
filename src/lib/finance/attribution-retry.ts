import 'server-only';

import { syncScheduler } from '@/lib/sync';
import {
  isDurableSyncMode,
} from '@/lib/sync/job-queue';

export function requestFinanceAttributionRetry(connectorId: string): void {
  if (isDurableSyncMode()) {
    return;
  }

  syncScheduler.queueFollowUpSync(connectorId);
}
