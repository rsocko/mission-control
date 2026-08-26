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
import db from '@/db';
import {
  financeTransactions,
} from '@/db/schema';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  MonarchBridgeClient,
  MonarchBridgeError,
} from './client';
import {
  FinanceSnapshotSynchronizer,
  updateFinanceCategory,
} from './snapshot-sync';
import { FinanceDatasetSynchronizer } from './dataset-sync';
import { FinanceInsightHistorySynchronizer } from './finance-insight-history-sync';
import { applyManualAttributionDecision } from './attribution-service';
import { captureFinanceInsightPublication } from '@/lib/finance-insights/publication';
import { pruneFinanceInsightOccurrenceCache } from '@/lib/finance-insights/occurrence-cache';
import logger from '@/lib/logger';
import { FINANCE_NOTIFICATION_TYPES } from '@/lib/notifications/push-policy/catalogs';

export {
  DEFAULT_TYRION_BRIDGE_URL,
  getTyrionBridgeUrl,
  normalizeTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from './bridge-url';
const activeProjectionSyncs = new Set<string>();

// ─── Types ────────────────────────────────────────────────────────────────────

interface TransactionFilters {
  startDate?: string;
  endDate?: string;
  kidId?: string;
  category?: string;
  triageStatus?: string;
  limit?: number;
}

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
      const publication = captureFinanceInsightPublication(config, result);
      let insightNotificationsAdded = 0;
      try {
        const {
          findFinanceInsightContinuationPublicationId,
          runFinanceInsightIngestion,
        } = await import('@/lib/finance-insights/orchestrator');
        const insightPublicationId = 'publicationId' in publication
          ? publication.publicationId
          : findFinanceInsightContinuationPublicationId(config.id);
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
      pruneFinanceInsightOccurrenceCache();
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

  async getTransactions(filters: TransactionFilters = {}) {
    const config = this.requireConfig();
    const conditions = [
      eq(financeTransactions.connectorInstanceId, config.id),
      eq(financeTransactions.lifecycleStatus, 'active'),
    ];

    if (filters.startDate) {
      conditions.push(gte(financeTransactions.date, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(financeTransactions.date, filters.endDate));
    }
    if (filters.kidId) {
      conditions.push(eq(financeTransactions.assignedKidId, filters.kidId));
    }
    if (filters.category) {
      conditions.push(eq(financeTransactions.confirmedCategory, filters.category));
    }
    if (filters.triageStatus) {
      conditions.push(eq(financeTransactions.triageStatus, filters.triageStatus));
    }

    const where = and(...conditions);
    const limit = typeof filters.limit === 'number'
      && Number.isSafeInteger(filters.limit)
      && filters.limit > 0
      ? Math.min(filters.limit, 500)
      : 100;

    return db.select()
      .from(financeTransactions)
      .where(where)
      .orderBy(sql`${financeTransactions.date} DESC`)
      .limit(limit);
  }

  // ─── Write-back ────────────────────────────────────────────────────────────

  async updateCategory(
    transactionId: string,
    categoryId: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<{ idempotencyKey: string; status: 'updated' }> {
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
