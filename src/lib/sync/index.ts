import type { IConnector } from '@/lib/connectors';
import type { ConnectorConfig, SyncResult } from '@/types';
import type { GitHubIdentityRunContext } from '@/lib/external-identities';
import { isPublicDemoMode } from '@/lib/public-demo';
import { syncLogger } from '@/lib/logger';
import { isDurableSyncMode } from './job-runtime';
import { SyncCronScheduler } from './cron-scheduler';
import { SyncExecutionPipeline } from './execution-pipeline';
import { SyncQueue, type SyncRequestOptions } from './queue';

export type { SyncAuditEntry } from './execution-pipeline';
export { SyncCronScheduler } from './cron-scheduler';
export { SyncExecutionPipeline } from './execution-pipeline';
export { SyncQueue } from './queue';
export { logWriteThrough, type WriteThroughLogParams } from './write-through-log';

export class SyncScheduler {
  private readonly executionPipeline: SyncExecutionPipeline;
  private readonly queue: SyncQueue;
  private readonly cronScheduler: SyncCronScheduler;

  constructor() {
    this.executionPipeline = new SyncExecutionPipeline();
    this.queue = new SyncQueue(
      (connectorId, options) => this.executionPipeline.runSyncLocally(connectorId, options),
      (connectorId) => this.executionPipeline.isConnectorSyncing(connectorId),
    );
    this.executionPipeline.configureFacade({
      requestSync: (connectorId, options) => this.queue.requestSync(connectorId, options),
      getQueueRemaining: () => this.queue.getRemaining(),
    });
    this.cronScheduler = new SyncCronScheduler(
      (connectorId, options) => this.queue.requestSync(connectorId, options),
      (connectorId) => this.executionPipeline.getLastResult(connectorId),
      () => this.executionPipeline.getActiveSyncs(),
    );
  }

  schedule(config: ConnectorConfig, staggerIndex = 0): Promise<void> {
    return this.cronScheduler.schedule(config, staggerIndex);
  }

  unschedule(connectorId: string): Promise<void> {
    return this.cronScheduler.unschedule(connectorId);
  }

  reconcileScheduleFromDb(connectorId: string): Promise<void> {
    return this.cronScheduler.reconcileScheduleFromDb(connectorId);
  }

  queueFollowUpSync(connectorId: string): Promise<void> {
    return this.queue.queueFollowUpSync(connectorId);
  }

  runExclusiveConnectorOperation<T>(
    connectorId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.executionPipeline.runExclusiveConnectorOperation(connectorId, operation);
  }

  async runSync(
    connectorId: string,
    options?: SyncRequestOptions,
  ): Promise<SyncResult> {
    return this.queue.requestSync(connectorId, options);
  }

  async requestSync(
    connectorId: string,
    options?: SyncRequestOptions,
  ): Promise<SyncResult> {
    return this.queue.requestSync(connectorId, options);
  }

  runSyncLocally(
    connectorId: string,
    options?: {
      full?: boolean;
      signal?: AbortSignal;
      jobId?: string;
      identityContext?: GitHubIdentityRunContext;
    },
  ): Promise<SyncResult> {
    return this.executionPipeline.runSyncLocally(connectorId, options);
  }

  initializeConnectorFromDb(connectorId: string): Promise<IConnector | null> {
    return this.executionPipeline.initializeConnectorFromDb(connectorId);
  }

  runAll(full?: boolean): Promise<SyncResult[]> {
    return this.executionPipeline.runAll(full);
  }

  getLastResult(connectorId: string): Promise<SyncResult | undefined> {
    return this.executionPipeline.getLastResult(connectorId);
  }

  getStatus() {
    return this.cronScheduler.getStatus();
  }

  isSyncing(): Promise<boolean> {
    return this.executionPipeline.isSyncing();
  }

  getActiveSyncs(): Promise<string[]> {
    return this.executionPipeline.getActiveSyncs();
  }

  scheduleAll(): Promise<void> {
    return this.cronScheduler.scheduleAll();
  }

  async stopAll(): Promise<void> {
    this.cronScheduler.stopAll();
    await this.executionPipeline.stopAll();
  }

  startNightlyFullSync(): void {
    this.cronScheduler.startNightlyFullSync();
  }

  resumeDependencyReconciliations(
    trigger?: 'startup' | 'recurring' | 'retry' | 'manual',
    onlyConnectorIds?: ReadonlySet<string>,
  ): Promise<void> {
    return this.executionPipeline.resumeDependencyReconciliations(
      trigger,
      onlyConnectorIds,
    );
  }

  startDependencyReconciliationResume(): void {
    this.executionPipeline.startDependencyReconciliationResume();
  }

  pollDueDependencyRelationships(
    trigger?: 'startup' | 'recurring' | 'manual',
  ): Promise<void> {
    return this.executionPipeline.pollDueDependencyRelationships(trigger);
  }

  startDependencyRelationshipPolling(): void {
    this.executionPipeline.startDependencyRelationshipPolling();
  }

  startWatchdog(): void {
    this.cronScheduler.startWatchdog();
  }
}

export const syncScheduler = new SyncScheduler();

if (!isPublicDemoMode() && !isDurableSyncMode()) {
  syncScheduler.scheduleAll().catch((err) => {
    syncLogger.error({ err }, 'Initial scheduleAll failed — instrumentation hook will retry');
  });
  syncScheduler.startNightlyFullSync();
  syncScheduler.startDependencyReconciliationResume();
  syncScheduler.startDependencyRelationshipPolling();
}
