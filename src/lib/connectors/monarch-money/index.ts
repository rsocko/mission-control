import type { IConnector, ConnectorFactory } from '../index';
import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  SyncResult,
  DomainSyncContext,
  DomainSyncResult,
} from '@/types';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from './client';
import { FinanceSnapshotSynchronizer } from './snapshot-synchronizer';
import { FinanceDatasetSynchronizer } from './dataset-synchronizer';
import { FinanceInsightHistorySynchronizer } from './finance-insight-history-sync';
import { captureFinanceInsightPublication } from '@/lib/finance-insights/publication';
import { pruneFinanceInsightOccurrenceCache } from '@/lib/finance-insights/occurrence-cache';
import logger from '@/lib/logger';
import { FINANCE_NOTIFICATION_TYPES } from '@/lib/notifications/push-policy/catalogs';
import {
  queryFinanceTransactions,
  type FinanceTransactionFilters,
} from './transaction-query';

export {
  DEFAULT_TYRION_BRIDGE_URL,
  getTyrionBridgeUrl,
  normalizeTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from './bridge-url';
const activeProjectionSyncs = new Set<string>();

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Connector ────────────────────────────────────────────────────────────────
// Mission Control talks to Tyrion here. Tyrion owns the Monarch integration
// details and exposes the bridge API consumed by this connector.

export class FinanceManagerConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'finance-manager';
  readonly displayName = 'Tyrion';
  readonly icon = '💰';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: true,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable', // no list concept
    notificationOnly: true,
  };

  private config: ConnectorConfig | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const health = await new MonarchBridgeClient(this.requireConfig()).getHealth();
      return {
        success: health.authenticated,
        message: health.authenticated
          ? 'Connected to Tyrion'
          : `Tyrion requires attention (${health.authState})`,
      };
    } catch (error) {
      const code = error instanceof MonarchBridgeError ? error.code : 'bridge_unavailable';
      return { success: false, message: `Tyrion connection failed (${code})` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
  }

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async syncDomainData(context: DomainSyncContext): Promise<DomainSyncResult> {
    const config = this.requireConfig();
    if (activeProjectionSyncs.has(config.id)) {
      throw new MonarchBridgeError(
        'sync_in_progress',
        'Finance synchronization is already in progress',
        true,
        409,
      );
    }
    activeProjectionSyncs.add(config.id);
    try {
      let transactions: DomainSyncResult = {
        itemsAdded: 0,
        itemsUpdated: 0,
        itemsRemoved: 0,
      };
      let transactionError: string | null = null;
      try {
        transactions = await new FinanceSnapshotSynchronizer(config).sync(context);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        transactionError = error instanceof MonarchBridgeError
          ? error.code
          : 'transaction_sync_failed';
      }
      const datasets = await new FinanceDatasetSynchronizer(config).sync(context);
      const datasetErrors = {
        ...(transactionError ? { transactions: transactionError } : {}),
        ...datasets.datasetErrors,
      };
      const result: DomainSyncResult = {
        itemsAdded: transactions.itemsAdded + datasets.itemsAdded,
        itemsUpdated: transactions.itemsUpdated + datasets.itemsUpdated,
        itemsRemoved: transactions.itemsRemoved + datasets.itemsRemoved,
        status: transactionError ? 'partial' : datasets.status,
        datasetErrors,
      };
      if (result.status === 'fresh' && Object.keys(datasetErrors).length === 0) {
        try {
          await new FinanceInsightHistorySynchronizer(config).sync(context);
        } catch (error) {
          if (context.signal?.aborted) throw error;
        }
      }
      const publication = await captureFinanceInsightPublication(config, result);
      let insightNotificationsAdded = 0;
      try {
        const {
          findFinanceInsightContinuationPublicationId,
          runFinanceInsightIngestion,
        } = await import('@/lib/finance-insights/orchestrator');
        const insightPublicationId = 'publicationId' in publication
          ? publication.publicationId
          : await findFinanceInsightContinuationPublicationId(config.id);
        if (insightPublicationId) {
          const insightResult = await runFinanceInsightIngestion({
            config,
            publicationId: insightPublicationId,
            signal: context.signal,
          });
          if (
            context.jobId
            && (
              insightResult.status === 'pending'
              || (insightResult.status === 'failed' && insightResult.retryable)
            )
          ) {
            const { enqueueFinanceInsightContinuation } = await import(
              '@/lib/finance-insights/continuation'
            );
            await enqueueFinanceInsightContinuation({
              connectorId: config.id,
              jobId: context.jobId,
            });
          }
          if (insightResult.status === 'failed') {
            logger.warn(
              { code: insightResult.code },
              'Finance insight shadow ingestion failed',
            );
          } else if (insightResult.status === 'completed') {
            insightNotificationsAdded = insightResult.notificationsAdded;
          }
        }
      } catch {
        logger.warn(
          { code: 'finance_insight_shadow_isolation_failed' },
          'Finance insight shadow ingestion failed',
        );
      }
      await pruneFinanceInsightOccurrenceCache();
      const { reconcileFinanceAttention } = await import('@/lib/finance/attention-routing');
      const attention = await reconcileFinanceAttention({ connectorId: config.id });
      logger.info(
        {
          evaluated: attention.evaluated,
          notificationsCreated: attention.notificationsCreated,
          taskPromoted: attention.taskPromoted,
          autoIncluded: attention.autoIncluded,
          deferred: attention.deferred,
          settled: attention.settled,
          stalePreserved: attention.stalePreserved,
        },
        'Finance attention routing completed',
      );
      return {
        ...result,
        notificationsAdded:
          insightNotificationsAdded + attention.notificationsCreated,
      };
    } finally {
      activeProjectionSyncs.delete(config.id);
    }
  }

  /** @deprecated Use the canonical sync scheduler, which calls syncDomainData. */
  async sync(): Promise<SyncResult> {
    try {
      await this.syncDomainData({ full: false });
      return {
        connectorId: this.id,
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        connectorId: this.id,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [
          error instanceof MonarchBridgeError
            ? `Finance sync failed (${error.code})`
            : 'Finance sync failed',
        ],
        syncedAt: new Date().toISOString(),
      };
    }
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  async getTransactions(filters: FinanceTransactionFilters = {}) {
    const config = this.requireConfig();
    return queryFinanceTransactions(config.id, filters);
  }

  // ─── Write-back ────────────────────────────────────────────────────────────

  async updateCategory(
    transactionId: string,
    categoryId: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<{ idempotencyKey: string; status: 'updated' }> {
    const { updateFinanceCategory } = await import('./snapshot-sync');
    return updateFinanceCategory(
      this.requireConfig(),
      transactionId,
      categoryId,
      idempotencyKey,
      signal,
    );
  }

  async assignKid(
    transactionId: string,
    kidId: string,
    idempotencyKey: string,
    actorType: 'parent-admin' | 'service',
  ) {
    if (process.env.MC_DATABASE_BACKEND === 'postgres') {
      throw new Error('Legacy finance attribution write-back is unavailable on PostgreSQL');
    }
    const { applyManualAttributionDecision } = await import('./attribution-service');
    return applyManualAttributionDecision({
      connectorId: this.requireConfig().id,
      transactionId,
      action: 'assign-kid',
      kidId,
      idempotencyKey,
      actorType,
    });
  }

  // ─── IConnector required methods ───────────────────────────────────────────

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    // Finance connector doesn't produce tasks
    yield [];
  }

  async fetchNotifications(): Promise<InboundNotification[]> {
    // Tyrion's finance automation outbox has no protected cross-process transport yet.
    // Do not infer its pending deliveries or connector-health recovery from projection success.
    return [];
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    return [];
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  private requireConfig(): ConnectorConfig {
    if (!this.config) throw new Error('Tyrion connector is not initialized');
    return this.config;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export const financeManagerFactory: ConnectorFactory = {
  create: () => new FinanceManagerConnector(),
  notificationTypes: FINANCE_NOTIFICATION_TYPES,
};

export const monarchMoneyFactory = financeManagerFactory;
export const MonarchMoneyConnector = FinanceManagerConnector;
