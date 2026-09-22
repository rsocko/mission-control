import type { SyncResult } from '@/types';
import { setQueuedExpensiveOperations } from '@/lib/telemetry/operations';
import { assertConnectorMaintenanceUnlockedAsync } from './maintenance-lock';
import { assertConnectorSyncEnqueueAllowedAsync } from './control-state';
import {
  getSyncJobRepository,
  isDurableSyncMode,
  waitForSyncJob,
  type SyncJobSource,
} from './job-runtime';

const MAX_CONCURRENT_SYNCS = 1;

export interface SyncRequestOptions {
  full?: boolean;
  signal?: AbortSignal;
  source?: SyncJobSource;
}

interface QueuedSync {
  connectorId: string;
  options?: { full?: boolean };
  resolve: (result: SyncResult) => void;
  reject: (error: unknown) => void;
}

function rejectedSyncResult(connectorId: string, error: string): SyncResult {
  return {
    connectorId,
    success: false,
    tasksAdded: 0,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [error],
    syncedAt: new Date().toISOString(),
  };
}

export class SyncQueue {
  private readonly queue: QueuedSync[] = [];
  private readonly activeConnectorIds = new Set<string>();
  private activeSyncCount = 0;

  constructor(
    private readonly executeSyncLocally: (
      connectorId: string,
      options?: { full?: boolean },
    ) => Promise<SyncResult>,
    private readonly isConnectorSyncing: (connectorId: string) => boolean,
    private readonly maxConcurrentSyncs = MAX_CONCURRENT_SYNCS,
  ) {}

  async requestSync(
    connectorId: string,
    options?: SyncRequestOptions,
  ): Promise<SyncResult> {
    await assertConnectorMaintenanceUnlockedAsync(connectorId);
    await assertConnectorSyncEnqueueAllowedAsync(
      connectorId,
      options?.source ?? 'api',
    );
    if (!isDurableSyncMode()) {
      return this.enqueueSync(connectorId, options);
    }

    const job = await (await getSyncJobRepository()).enqueue(connectorId, {
      full: options?.full,
      source: options?.source ?? 'api',
    });
    if (options?.full && !job.full) {
      return rejectedSyncResult(
        connectorId,
        'An incremental sync is already running; the full sync was not scheduled',
      );
    }
    return waitForSyncJob(job, { signal: options?.signal });
  }

  enqueueSync(
    connectorId: string,
    options?: { full?: boolean },
  ): Promise<SyncResult> {
    if (this.isBusy(connectorId)) {
      return Promise.resolve(rejectedSyncResult(connectorId, 'Sync already in progress'));
    }
    if (this.queue.some((queued) => queued.connectorId === connectorId)) {
      return Promise.resolve(rejectedSyncResult(connectorId, 'Sync already queued'));
    }
    if (this.activeSyncCount < this.maxConcurrentSyncs) {
      return this.executeSync(connectorId, options);
    }

    return new Promise<SyncResult>((resolve, reject) => {
      this.queue.push({ connectorId, options, resolve, reject });
      setQueuedExpensiveOperations(this.queue.length);
    });
  }

  async queueFollowUpSync(connectorId: string): Promise<void> {
    await assertConnectorSyncEnqueueAllowedAsync(connectorId, 'api');
    if (isDurableSyncMode()) {
      await (await getSyncJobRepository()).enqueue(connectorId, { full: true, source: 'api' });
      return;
    }

    const queued = this.queue.find((item) => item.connectorId === connectorId);
    if (queued) {
      queued.options = { ...queued.options, full: true };
      return;
    }
    if (this.isBusy(connectorId)) {
      this.queue.push({
        connectorId,
        options: { full: true },
        resolve: () => undefined,
        reject: () => undefined,
      });
      setQueuedExpensiveOperations(this.queue.length);
      return;
    }
    void this.enqueueSync(connectorId, { full: true });
  }

  async getRemaining(): Promise<number> {
    if (isDurableSyncMode()) {
      const metrics = await (await getSyncJobRepository()).getMetrics();
      return metrics.queued + Math.max(0, metrics.running - 1);
    }
    return this.queue.length + Math.max(0, this.activeSyncCount - 1);
  }

  private async executeSync(
    connectorId: string,
    options?: { full?: boolean },
  ): Promise<SyncResult> {
    this.activeSyncCount++;
    this.activeConnectorIds.add(connectorId);
    try {
      return await this.executeSyncLocally(connectorId, options);
    } finally {
      this.activeConnectorIds.delete(connectorId);
      this.activeSyncCount--;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (
      this.queue.length > 0
      && this.activeSyncCount < this.maxConcurrentSyncs
    ) {
      const next = this.queue.shift()!;
      setQueuedExpensiveOperations(this.queue.length);
      if (this.isBusy(next.connectorId)) {
        next.resolve(rejectedSyncResult(next.connectorId, 'Sync already in progress'));
        continue;
      }
      void this.executeSync(next.connectorId, next.options).then(next.resolve, next.reject);
    }
  }

  private isBusy(connectorId: string): boolean {
    return this.activeConnectorIds.has(connectorId)
      || this.isConnectorSyncing(connectorId);
  }
}
