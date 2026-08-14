import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import { connectorRegistry } from '@/lib/connectors';
import type { IConnector } from '@/lib/connectors';
import type {
  InboundNotification,
  ConnectorConfig,
  DomainSyncResult,
  SyncResult,
} from '@/types';
import type { GitHubIdentityPhase } from '@/db/schema';
import db, { runTransaction } from '@/db';
import {
  getGitHubIdentityModeSnapshot,
  GitHubIdentityComparisonRuntime,
} from '@/lib/external-identities';
import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityRunContext,
} from '@/lib/external-identities';
import { syncLog, notifications as notificationsTable, notificationActions, connectorConfigs, sourceLists as sourceListsTable } from '@/db/schema';
import { hubProjects, taskProjects, tasks as tasksTable } from '@/db/schema';
import { eq, and, isNull, inArray, like, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { isPublicDemoMode } from '@/lib/public-demo';
import { emitEvent } from '@/lib/events';
import { syncEventBus } from './events';
import { syncLogger } from '@/lib/logger';
import { publicRuntimeRelease } from '@/lib/runtime/release';
import { resolveSourceListDisplayName } from '@/lib/utils/source-list-display-name';
import { pushPendingChanges } from './push-manager';
import { upsertTasks } from './pull-manager';
import {
  beginDependencySnapshotGeneration,
  createTargetedDependencyCollection,
  getDependencyReconciliationHealth,
  getResumableDependencyReconciliations,
  recordDependencyReconciliationResumeOutcome,
  reconcileTargetedTaskDependencies,
  reconcileTaskDependencies,
  type DependencyReconciliationResumeCandidate,
} from './task-dependency-manager';
import { upsertSourceLists, autoAssignFolderGroups } from './list-manager';
import { indexAlertForSearch, warmUpSearchAfterSync } from './search-indexer';
import { normalizeNotificationLevel } from '@/lib/notifications/levels';
import {
  createNotificationsInTransaction,
  wakeNotificationDeliveryDispatcher,
  type CreateNotificationInput,
} from '@/lib/notifications';
import {
  countRemainingSyncJobs,
  enqueueSyncJob,
  getActiveSyncJobConnectorIds,
  getLatestDurableSyncResult,
  getSyncSchedules,
  getSyncDurationBudgetMs,
  getSyncQueueMetrics,
  isDurableSyncMode,
  markSyncScheduleEnqueued,
  registerSyncSchedule,
  unregisterSyncSchedule,
  waitForSyncJob,
  type SyncJobSource,
} from './job-queue';
import { assertConnectorMaintenanceUnlocked } from './maintenance-lock';
import {
  ConnectorOperationBusyError,
  hasConnectorSyncJobLease,
  runWithConnectorOperationLease,
} from './connector-lock';
import { validateAndFreezeGitHubIdentityContext } from './github-identity-context';
import {
  mergeGitHubHierarchyObservation,
  readGitHubHierarchyObservation,
  reconcileGitHubTaskHierarchy,
} from './github-hierarchy-reconciliation';
import type { GitHubHierarchyObservation } from './github-hierarchy-reconciliation';
import {
  assertCompleteGitHubProjectAssociations,
  assertUniqueGitHubProjectIdentities,
  compareGitHubProjectAssociations,
  resolveGitHubProjectIdentityDigest,
} from './github-project-association-identity';
import { evaluateRulesForTasks } from '@/lib/rules';
import {
  setQueuedExpensiveOperations,
  withRuntimeOperation,
} from '@/lib/telemetry/operations';

interface ScheduledJob {
  connectorId: string;
  task: ScheduledTask;
  intervalMinutes: number;
}

type DependencyResumeTrigger = 'startup' | 'recurring' | 'retry' | 'manual';

interface DependencyResumeSummary {
  attempted: number;
  advanced: number;
  deferred: number;
  failed: number;
}

/** Maximum number of syncs allowed to run concurrently to prevent event loop starvation */
const MAX_CONCURRENT_SYNCS = 1;

/** Stagger delay between connector syncs when scheduled at the same cron tick (ms) */
const STAGGER_DELAY_MS = 30_000;

/** Max parallel API calls during stale in_progress task verification */
const STALE_VERIFY_CONCURRENCY = 5;

const DEFAULT_DEPENDENCY_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_DEPENDENCY_SHUTDOWN_TIMEOUT_MS = 60_000;

function dependencyShutdownTimeoutMs(
  envName:
    | 'MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS'
    | 'MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS',
): number {
  const configured = Number(process.env[envName]);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), MAX_DEPENDENCY_SHUTDOWN_TIMEOUT_MS)
    : DEFAULT_DEPENDENCY_SHUTDOWN_TIMEOUT_MS;
}

function throwIfSyncAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Sync cancelled');
  }
}

function getInaccessibleGitHubSourceListIds(connector: IConnector): Set<string> {
  const observationState = (
    connector as IConnector & {
      getIdentityObservationState?: () => Array<{
        sourceId: string;
        state: 'complete' | 'partial' | 'inaccessible';
      }>;
    }
  ).getIdentityObservationState?.() ?? [];
  return new Set(
    observationState
      .filter((state) => state.state !== 'complete')
      .map((state) => state.sourceId),
  );
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

async function withSyncPhaseTiming<T>(
  connectorId: string,
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  return withRuntimeOperation({
    kind: 'sync',
    name: 'sync-phase',
    connectorId,
    phase,
  }, async () => {
    try {
      const result = await operation();
      syncLogger.info(
        { connectorId, phase, durationMs: Date.now() - startedAt, success: true },
        'Sync phase completed',
      );
      return result;
    } catch (error) {
      syncLogger.warn(
        { err: error, connectorId, phase, durationMs: Date.now() - startedAt, success: false },
        'Sync phase failed',
      );
      throw error;
    }
  });
}

/** Individual task-level action recorded during a sync for audit purposes */
export interface SyncAuditEntry {
  action: 'added' | 'updated' | 'removed' | 'pushed' | 'push_failed' | 'protected' | 'conflict_resolved' | 'skipped';
  taskTitle: string;
  taskSourceId: string;
  /** Stable local identity for opening the current task. */
  taskId?: string;
  /** Durable snapshot identity when the task was removed. */
  deletionSnapshotId?: string;
  reason?: string;
  /** Which list the task belongs to */
  listName?: string;
  resolution?: import('./retention').RetentionResolutionRecord;
}

/**
 * SyncScheduler manages periodic sync jobs for each connector.
 * Handles both PULL (fetch from source) and PUSH (write-back local changes).
 */
export class SyncScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private syncInProgress = new Set<string>();
  private lastSyncResults = new Map<string, SyncResult>();
  private nightlyFullSyncTask: ScheduledTask | null = null;
  private dependencyReconciliationResumeTimer: ReturnType<typeof setInterval> | null = null;
  private dependencyReconciliationResumeRun: Promise<void> | null = null;
  private dependencyReconciliationResumeEnabled = false;
  private dependencyReconciliationFollowUpRequested = false;
  private dependencyRelationshipPollTimer: ReturnType<typeof setInterval> | null = null;
  private dependencyRelationshipPollRun: Promise<void> | null = null;
  private dependencyRelationshipPollEnabled = false;
  private dependencyRelationshipPollAbortController: AbortController | null = null;
  private dependencyReconciliationRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private dependencyReconciliationBusyRetryCounts = new Map<string, number>();
  private hydratePromise: Promise<void> | null = null;
  private syncQueue: Array<{ connectorId: string; options?: { full?: boolean }; resolve: (r: SyncResult) => void }> = [];
  private activeSyncCount = 0;

  constructor() {
    // Fire-and-forget hydration from sync_log so the first sync after restart
    // is treated as incremental (fast) rather than a full re-scan.
    this.hydratePromise = this.hydrateLastSyncResults().then(() => {
      this.hydratePromise = null;
    }).catch((err) => {
      syncLogger.warn({ err }, 'Failed to hydrate lastSyncResults from sync_log; first sync will be full');
      this.hydratePromise = null;
    });
  }

  /**
   * Load the most recent successful sync timestamp per connector from the DB.
   * This is a fast indexed query — one row per connector.
   */
  private async hydrateLastSyncResults(): Promise<void> {
    // Only hydrate from successful syncs — failed syncs should not advance the
    // `since` baseline, otherwise tasks updated during a failed sync window are
    // permanently missed until the next nightly full sync.
    const rows = await db
      .select({
        connectorId: syncLog.connectorId,
        syncedAt: syncLog.syncedAt,
        tasksAdded: syncLog.tasksAdded,
        tasksUpdated: syncLog.tasksUpdated,
        tasksRemoved: syncLog.tasksRemoved,
        notificationsAdded: syncLog.notificationsAdded,
        success: syncLog.success,
        durationMs: syncLog.durationMs,
      })
      .from(syncLog)
      .orderBy(desc(syncLog.syncedAt))
      .all();

    // Keep only the first (most recent) successful PULL sync row per connector.
    // Write-through entries (durationMs === 0) must be excluded — they only push
    // a single field and never pull remote state, so using their syncedAt as the
    // `since` baseline would skip issues closed between the last real sync and
    // the write-through, permanently hiding them from incremental pulls.
    for (const row of rows) {
      if (this.lastSyncResults.has(row.connectorId)) continue;
      if (!row.success) continue; // skip failed syncs
      if (row.durationMs === 0) continue; // skip write-through entries
      this.lastSyncResults.set(row.connectorId, {
        connectorId: row.connectorId,
        success: true,
        tasksAdded: row.tasksAdded,
        tasksUpdated: row.tasksUpdated,
        tasksRemoved: row.tasksRemoved,
        notificationsAdded: row.notificationsAdded,
        errors: [],
        syncedAt: row.syncedAt,
      });
    }
    syncLogger.info({ count: this.lastSyncResults.size }, 'Hydrated lastSyncResults from sync_log');
  }

  /**
   * Schedule a sync job for a connector based on its config.
   * Adds a per-connector stagger offset to avoid all connectors firing simultaneously.
   */
  schedule(config: ConnectorConfig, staggerIndex = 0): void {
    if (isDurableSyncMode()) {
      if (!config.enabled || config.syncMode === 'manual') {
        unregisterSyncSchedule(config.id);
        return;
      }
      if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
        registerSyncSchedule(config.id, config.pollIntervalMinutes);
      }
      return;
    }

    this.unschedule(config.id);

    if (!config.enabled || config.syncMode === 'manual') {
      return;
    }

    if (config.syncMode === 'poll' && config.pollIntervalMinutes) {
      registerSyncSchedule(config.id, config.pollIntervalMinutes);
      const cronExpression = this.intervalToCron(config.pollIntervalMinutes);
      const staggerMs = staggerIndex * STAGGER_DELAY_MS;
      const task = cron.schedule(cronExpression, () => {
        markSyncScheduleEnqueued(config.id);
        if (staggerMs > 0) {
          setTimeout(() => {
            void this.requestSync(config.id, { source: 'schedule' });
          }, staggerMs);
        } else {
          void this.requestSync(config.id, { source: 'schedule' });
        }
      });

      this.jobs.set(config.id, {
        connectorId: config.id,
        task,
        intervalMinutes: config.pollIntervalMinutes,
      });
      task.start();
    }
  }

  /**
   * Remove a scheduled job.
   */
  unschedule(connectorId: string): void {
    const job = this.jobs.get(connectorId);
    if (job) {
      job.task.stop();
      this.jobs.delete(connectorId);
    }
    unregisterSyncSchedule(connectorId);
  }

  async reconcileScheduleFromDb(connectorId: string): Promise<void> {
    const [row] = await db.select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorId))
      .limit(1);

    if (!row || row.deletedAt) {
      this.unschedule(connectorId);
      return;
    }

    this.schedule({
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled ?? true,
      syncMode: (row.syncMode as ConnectorConfig['syncMode']) || 'poll',
      pollIntervalMinutes: row.pollIntervalMinutes ?? 5,
      capabilities: (typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities) as ConnectorConfig['capabilities'],
      credentials: (typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials) || {},
      settings: (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) || {},
      syncedLists: (typeof row.syncedLists === 'string' ? JSON.parse(row.syncedLists) : row.syncedLists) || [],
    });
  }

  /**
   * Enqueue a sync request, respecting the concurrency limit.
   * If below the limit, runs immediately; otherwise queues for later.
   */
  private enqueueSync(connectorId: string, options?: { full?: boolean }): Promise<SyncResult> {
    if (this.syncInProgress.has(connectorId)) {
      return Promise.resolve({
        connectorId,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: ['Sync already in progress'],
        syncedAt: new Date().toISOString(),
      });
    }

    if (this.syncQueue.some((queued) => queued.connectorId === connectorId)) {
      return Promise.resolve({
        connectorId,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: ['Sync already queued'],
        syncedAt: new Date().toISOString(),
      });
    }

    if (this.activeSyncCount < MAX_CONCURRENT_SYNCS) {
      return this.executeSync(connectorId, options);
    }

    return new Promise<SyncResult>((resolve) => {
      this.syncQueue.push({ connectorId, options, resolve });
      setQueuedExpensiveOperations(this.syncQueue.length);
    });
  }

  queueFollowUpSync(connectorId: string): void {
    if (isDurableSyncMode()) {
      enqueueSyncJob(connectorId, { full: true, source: 'api' });
      return;
    }
    const queued = this.syncQueue.find((item) => item.connectorId === connectorId);
    if (queued) {
      queued.options = { ...queued.options, full: true };
      return;
    }
    if (this.syncInProgress.has(connectorId)) {
      this.syncQueue.push({ connectorId, options: { full: true }, resolve: () => undefined });
      setQueuedExpensiveOperations(this.syncQueue.length);
      return;
    }
    void this.enqueueSync(connectorId, { full: true });
  }

  /**
   * Execute a sync and drain the queue when done.
   */
  private async executeSync(connectorId: string, options?: { full?: boolean }): Promise<SyncResult> {
    this.activeSyncCount++;
    try {
      return await this.runSyncLocally(connectorId, options);
    } finally {
      this.activeSyncCount--;
      this.drainQueue();
    }
  }

  /**
   * Process the next queued sync if concurrency allows.
   */
  private drainQueue(): void {
    while (this.syncQueue.length > 0 && this.activeSyncCount < MAX_CONCURRENT_SYNCS) {
      const next = this.syncQueue.shift()!;
      setQueuedExpensiveOperations(this.syncQueue.length);
      // Skip if this connector started a sync while queued
      if (this.syncInProgress.has(next.connectorId)) {
        next.resolve({
          connectorId: next.connectorId,
          success: false,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          notificationsAdded: 0,
          errors: ['Sync already in progress'],
          syncedAt: new Date().toISOString(),
        });
        continue;
      }
      this.executeSync(next.connectorId, next.options).then(next.resolve);
    }
  }

  async runExclusiveConnectorOperation<T>(
    connectorId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.syncInProgress.has(connectorId)) {
      throw new ConnectorOperationBusyError('Sync already in progress for this connector');
    }

    this.syncInProgress.add(connectorId);
    try {
      return await runWithConnectorOperationLease(connectorId, 'retention', operation);
    } finally {
      this.syncInProgress.delete(connectorId);
    }
  }

  /**
   * Manually trigger a full sync for a specific connector.
   * Order: PUSH local changes → PULL remote changes → persist.
   */
  async runSync(
    connectorId: string,
    options?: { full?: boolean; signal?: AbortSignal; source?: SyncJobSource },
  ): Promise<SyncResult> {
    return this.requestSync(connectorId, options);
  }

  async requestSync(
    connectorId: string,
    options?: { full?: boolean; signal?: AbortSignal; source?: SyncJobSource },
  ): Promise<SyncResult> {
    assertConnectorMaintenanceUnlocked(connectorId);
    if (!isDurableSyncMode()) {
      return this.enqueueSync(connectorId, options);
    }
    const job = enqueueSyncJob(connectorId, {
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

  async runSyncLocally(
    connectorId: string,
    options?: {
      full?: boolean;
      signal?: AbortSignal;
      jobId?: string;
      identityContext?: GitHubIdentityRunContext;
    },
  ): Promise<SyncResult> {
    if (!options?.jobId) {
      return runWithConnectorOperationLease(
        connectorId,
        'sync',
        () => this.runSyncLocallyWithLease(connectorId, options),
      );
    }
    if (!hasConnectorSyncJobLease(connectorId, options.jobId)) {
      throw new Error(`Sync job ${options.jobId} has no active connector operation lease`);
    }
    return this.runSyncLocallyWithLease(connectorId, options);
  }

  private async runSyncLocallyWithLease(
    connectorId: string,
    options?: {
      full?: boolean;
      signal?: AbortSignal;
      jobId?: string;
      identityContext?: GitHubIdentityRunContext;
    },
  ): Promise<SyncResult> {
    assertConnectorMaintenanceUnlocked(connectorId);
    // Ensure hydration is complete before checking lastSyncResults
    if (this.hydratePromise) await this.hydratePromise;
    throwIfSyncAborted(options?.signal);
    const queuedIdentitySnapshot = options?.identityContext
      ? validateAndFreezeGitHubIdentityContext(connectorId, options.identityContext)
      : undefined;

    if (this.syncInProgress.has(connectorId)) {
      return {
        connectorId,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: ['Sync already in progress'],
        syncedAt: new Date().toISOString(),
      };
    }

    this.syncInProgress.add(connectorId);
    const startTime = Date.now();
    syncLogger.info({ connectorId, full: options?.full ?? false }, 'Sync started');
    const errors: string[] = [];
    const details: SyncAuditEntry[] = [];
    let tasksAdded = 0;
    let tasksUpdated = 0;
    let tasksRemoved = 0;
    let notificationsAdded = 0;
    let domainDataResult: DomainSyncResult | undefined;
    let identityComparison: GitHubIdentityComparisonRuntime | undefined;
    let identitySnapshot: GitHubIdentityModeSnapshot | undefined = queuedIdentitySnapshot;

    return withRuntimeOperation({
      kind: 'sync',
      name: 'connector-sync',
      connectorId,
      jobId: options?.jobId,
      phase: 'overall',
    }, async () => {
    try {
      let connector: IConnector | null;
      try {
        connector = await this.initializeConnectorFromDb(connectorId);
      } catch (initErr) {
        const detail = initErr instanceof Error ? initErr.message : String(initErr);
        throw new Error(`Failed to initialize connector ${connectorId}: ${detail}`);
      }
      if (!connector) {
        throw new Error(`Connector config not found in database: ${connectorId}`);
      }
      if (connector.type === 'github-issues') {
        identitySnapshot ??= getGitHubIdentityModeSnapshot(connectorId);
        if (
          identitySnapshot.effectiveMode === 'comparison'
          || identitySnapshot.effectiveMode === 'stable'
        ) {
          identityComparison = new GitHubIdentityComparisonRuntime({
            connectorInstanceId: connectorId,
            jobId: options?.jobId,
            modeSnapshot: identitySnapshot,
            syncKind: options?.full ? 'full' : 'incremental',
          });
        }
      } else if (identitySnapshot) {
        throw new Error('Frozen GitHub identity context was assigned to a non-GitHub connector');
      }
      const identityPhase: GitHubIdentityPhase | null = identitySnapshot?.phase ?? null;

      syncEventBus.emitSyncEvent({
        type: 'sync:start',
        connectorId,
        connectorName: connector.displayName,
        phase: 'push',
      });

      // ─── PHASE 1: PUSH — Write-back pending local changes ────────────
      throwIfSyncAborted(options?.signal);
      const pushResult = await withSyncPhaseTiming(
        connectorId,
        'push',
        () => pushPendingChanges(connectorId, connector, details, undefined, {
          identityComparison,
          identityMode: identitySnapshot
            ? {
              effectiveMode: identitySnapshot.effectiveMode,
              modeRevision: identitySnapshot.modeRevision,
            }
            : undefined,
          jobId: options?.jobId,
          connectorOperationLeaseHeld: true,
        }),
      );
      tasksUpdated += pushResult.pushed;
      if (pushResult.errors.length > 0) {
        errors.push(...pushResult.errors);
      }

      // Connector-owned domain data (for example finance transactions) is
      // synchronized inside the same durable job and cancellation boundary.
      if (connector.syncDomainData) {
        throwIfSyncAborted(options?.signal);
        domainDataResult = await withSyncPhaseTiming(
          connectorId,
          'domain-data',
          () => connector.syncDomainData!({
            full: options?.full ?? false,
            signal: options?.signal,
            jobId: options?.jobId,
          }),
        );
      }

      // ─── PHASE 2: PULL — Fetch remote tasks/notifications ───────────────────
      const lastSync = options?.full ? undefined : this.lastSyncResults.get(connectorId);
      const since = lastSync ? new Date(lastSync.syncedAt) : undefined;
      const isFullSync = !since;
      syncLogger.info(
        { connectorId, incremental: !!since, since: since?.toISOString(), forcedFull: options?.full ?? false },
        since ? 'Incremental sync — fetching changes since last sync' : 'Full sync — no prior sync baseline available',
      );

      syncEventBus.emitSyncEvent({
        type: 'sync:start',
        connectorId,
        connectorName: connector.displayName,
        phase: 'lists',
      });

      const remoteNotificationsPromise = withSyncPhaseTiming(
        connectorId,
        'remote-fetch',
        () => connector.fetchNotifications(since),
      );
      // The task stream may take longer than notifications; attach a handler now
      // so an early notification failure is not reported as an unhandled rejection.
      void remoteNotificationsPromise.catch(() => undefined);
      const dependencyGeneration = (
        isFullSync
        && connector.dependencySnapshotStrategy === 'task-stream'
      )
        ? await beginDependencySnapshotGeneration(connectorId, identitySnapshot)
        : undefined;
      const targetedDependencyCollection = (
        !isFullSync
        && connector.dependencySnapshotStrategy === 'task-stream'
        && connector.capabilities.dependencyRead
      )
        ? createTargetedDependencyCollection()
        : undefined;
      const remoteTaskPages = connector.fetchTasks(since, {
        signal: options?.signal,
        dependencyGeneration: dependencyGeneration ?? targetedDependencyCollection?.writer,
      });
      throwIfSyncAborted(options?.signal);

      // ─── PHASE 3: DISCOVER LISTS — Persist source lists locally ─────
      let discoveredLists: Array<{ id: string; name: string }> = [];
      let deletionAuthoritative = isFullSync;
      const deletionProtectedSourceListIds = new Set(getInaccessibleGitHubSourceListIds(connector));
      try {
        const remoteSourceLists = await withSyncPhaseTiming(
          connectorId,
          'list-discovery',
          async () => {
            const sourceLists = await connector.fetchSourceLists();
            await upsertSourceLists(
              connectorId,
              sourceLists,
              identityPhase,
              identityComparison,
              deletionProtectedSourceListIds,
              connector.type === 'github-issues',
            );
            return sourceLists;
          },
        );

        const persistedLists = await db.select({
          sourceId: sourceListsTable.sourceId,
          name: sourceListsTable.name,
          userDisplayName: sourceListsTable.userDisplayName,
        }).from(sourceListsTable)
          .where(eq(sourceListsTable.connectorInstanceId, connectorId));
        discoveredLists = persistedLists.map(l => ({
          id: l.sourceId,
          name: resolveSourceListDisplayName(l),
        }));
        if (connector.type === 'github-issues') {
          const configuredSourceListIds = new Set(remoteSourceLists.map(list => list.sourceId));
          for (const list of persistedLists) {
            if (!configuredSourceListIds.has(list.sourceId)) {
              deletionProtectedSourceListIds.add(list.sourceId);
            }
          }
        }

        syncEventBus.emitSyncEvent({
          type: 'sync:lists-discovered',
          connectorId,
          listCount: remoteSourceLists.length,
          lists: discoveredLists,
        });

        await autoAssignFolderGroups(connector, remoteSourceLists);
      } catch (err) {
        deletionAuthoritative = false;
        identityComparison?.markIneligible('source_list_observation_failed');
        errors.push(`Source list discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      syncEventBus.emitSyncEvent({
        type: 'sync:start',
        connectorId,
        connectorName: connector.displayName,
        phase: 'tasks',
      });

      // ─── PHASE 4: UPSERT — Merge remote tasks into local DB ─────────
      throwIfSyncAborted(options?.signal);
      const upsertResult = await withSyncPhaseTiming(
        connectorId,
        'task-upsert',
        () => upsertTasks(
          connectorId,
          connector,
          remoteTaskPages,
          deletionAuthoritative,
          discoveredLists,
          details,
          identityPhase,
          identityComparison,
          deletionProtectedSourceListIds,
        ),
      );
      tasksAdded += upsertResult.added;
      tasksUpdated += upsertResult.updated;
      tasksRemoved += upsertResult.removed;
      const localOnlyProtected = upsertResult.localOnlyProtected;
      const remoteSourceIds = upsertResult.remoteSourceIds ?? new Set<string>();

      // ─── PHASE 4a: DEPENDENCIES — Reconcile native blocking edges ───
      try {
        if (targetedDependencyCollection) {
          const targeted = targetedDependencyCollection.result();
          await withSyncPhaseTiming(
            connectorId,
            'dependency-targeted-reconciliation',
            () => reconcileTargetedTaskDependencies(
              connectorId,
              targeted.snapshot,
              remoteSourceIds,
              identityComparison,
            ),
          );
        }
        const dependencyResult = await withSyncPhaseTiming(
          connectorId,
          'dependency-reconciliation',
          () => reconcileTaskDependencies(
            connectorId,
            connector,
            { full: isFullSync, identityComparison },
          ),
        );
        if (dependencyResult.failed > 0) {
          errors.push(`${dependencyResult.failed} task dependency write(s) failed`);
        }
        if (dependencyResult.resumeSkippedReason === 'identity-context-changed') {
          identityComparison?.markIneligible('dependency_identity_context_changed');
          errors.push('Task dependency generation was fenced after an identity context change');
        }
      } catch (err) {
        identityComparison?.markIneligible('dependency_identity_observation_failed');
        errors.push(`Task dependency sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ─── PHASE 4b: PROJECTS — Sync GitHub Projects V2 as Hub Projects ─
      try {
        if ('fetchProjectAssociations' in connector && typeof (connector as Record<string, unknown>).fetchProjectAssociations === 'function') {
          const associations = await (connector as {
            fetchProjectAssociations(): Promise<Array<{
              project: {
                id: string;
                number: number;
                title: string;
                shortDescription: string | null;
                url: string;
              };
              membershipState: 'complete' | 'partial' | 'inaccessible';
              taskSourceIds: string[];
              taskIdentityEvidence?: Array<{
                sourceId: string;
                evidence: import('@/lib/external-identities/types').ExternalIdentityEvidence;
              }>;
            }>>;
          }).fetchProjectAssociations();
          assertUniqueGitHubProjectIdentities(associations);
          assertCompleteGitHubProjectAssociations(associations);
          let stableProjectIdentity:
            | ReturnType<typeof compareGitHubProjectAssociations>
            | undefined;
          if (identityComparison) {
            const localRows = await db.select({
              id: tasksTable.id,
              sourceId: tasksTable.sourceId,
            }).from(tasksTable)
              .where(eq(tasksTable.connectorInstanceId, connectorId));
            stableProjectIdentity = compareGitHubProjectAssociations(
              identityComparison,
              associations,
              localRows,
            );
          }
          const stableProjectRouting =
            identityComparison?.modeSnapshot.effectiveMode === 'stable'
              ? stableProjectIdentity
              : undefined;
          const stableProjectContext =
            stableProjectRouting && identityComparison
              ? { routing: stableProjectRouting, runtime: identityComparison }
              : undefined;
          if (
            identityComparison?.modeSnapshot.effectiveMode === 'stable'
            && !stableProjectContext
          ) {
            throw new Error('Stable GitHub project association routing is unavailable');
          }
          const projectIdentityRuntime = identityComparison;
          const assertProjectIdentityCurrent = projectIdentityRuntime
            ? () => projectIdentityRuntime.assertDecisionsCurrent(
                stableProjectIdentity?.decisions ?? [],
              )
            : undefined;
          await withSyncPhaseTiming(
            connectorId,
            'project-reconciliation',
            () => {
              identityComparison?.assertDecisionsCurrent(
                stableProjectIdentity?.decisions ?? [],
              );
              return this.syncGitHubProjectsAsHubProjects(
                connectorId,
                associations,
                stableProjectContext
                  ? {
                      stableProjectTaskIds:
                        stableProjectContext.routing.stableProjectTaskIds,
                      blockedStableProjects:
                        stableProjectContext.routing.blockedStableProjects,
                    }
                  : undefined,
                assertProjectIdentityCurrent,
              );
            },
          );
        }
      } catch (err) {
        identityComparison?.markIneligible('project_association_observation_failed');
        errors.push(`GitHub Projects sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ─── PHASE 4c: CLEANUP — Remove stale project source lists ──────
      try {
        await db.delete(sourceListsTable).where(
          and(
            eq(sourceListsTable.connectorInstanceId, connectorId),
            eq(sourceListsTable.type, 'project'),
          ),
        );

        // Clear sourceListId on tasks that still reference deleted project lists.
        // These tasks are now accessible via hub project associations instead.
        await db.update(tasksTable).set({
          sourceListId: null,
          sourceListName: null,
        }).where(
          and(
            eq(tasksTable.connectorInstanceId, connectorId),
            like(tasksTable.sourceListId, 'project:%'),
          ),
        );
      } catch {
        // Non-fatal: stale project source lists will just be empty
      }

      // ─── PHASE 4d: AUTO-INCLUDE — Re-evaluate tasks changed by this connector ─
      try {
        const connectorTasks = await db.select({
          id: tasksTable.id,
          sourceId: tasksTable.sourceId,
        })
          .from(tasksTable)
          .where(eq(tasksTable.connectorInstanceId, connectorId));
        const changedTaskIds = connectorTasks
          .filter((task) => remoteSourceIds.has(task.sourceId))
          .map((task) => task.id);
        await evaluateRulesForTasks(changedTaskIds);
      } catch (err) {
        errors.push(`Project auto-include failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ─── PHASE 4e: VERIFY — Check stale in_progress tasks ──────────
      // During incremental syncs, tasks whose remote updatedAt is older than
      // `since` are never returned by the API. If a task is locally
      // 'in_progress' but was closed on the remote between syncs (or during
      // a race), it becomes permanently stuck. This phase individually
      // verifies such tasks against the remote and corrects them.
      if (since && connector.updateTask) {
        const verificationStartedAt = Date.now();
        let verificationSucceeded = true;
        try {
          const staleInProgress = await db.select({
            id: tasksTable.id,
            sourceId: tasksTable.sourceId,
            status: tasksTable.status,
            completedAt: tasksTable.completedAt,
          }).from(tasksTable).where(
            and(
              eq(tasksTable.connectorInstanceId, connectorId),
              eq(tasksTable.status, 'in_progress'),
            ),
          );

          // Only verify tasks not already included in the pull results
          const tasksToVerify = staleInProgress.filter(t => !remoteSourceIds.has(t.sourceId));

          if (tasksToVerify.length > 0) {
            syncLogger.info({ connectorId, count: tasksToVerify.length }, 'Verifying stale in_progress tasks against remote');
          }

          // Process in batches with limited concurrency to avoid blocking the event loop
          for (let i = 0; i < tasksToVerify.length; i += STALE_VERIFY_CONCURRENCY) {
            const batch = tasksToVerify.slice(i, i + STALE_VERIFY_CONCURRENCY);
            const results = await Promise.allSettled(
              batch.map(async (task) => {
                const remoteState = await connector.updateTask!(task.sourceId, {});
                return { task, remoteState };
              })
            );

            for (const result of results) {
              if (result.status === 'fulfilled') {
                const { task, remoteState } = result.value;
                const remoteIsTerminal = remoteState?.status === 'done' || remoteState?.status === 'cancelled';
                if (remoteIsTerminal) {
                  await db.update(tasksTable).set({
                    status: remoteState.status,
                    completedAt: remoteState.completedAt || new Date().toISOString(),
                    syncStatus: 'synced',
                    lastSyncedAt: new Date().toISOString(),
                  }).where(eq(tasksTable.id, task.id));
                  tasksUpdated++;
                  details.push({
                    action: 'updated',
                    taskTitle: task.sourceId,
                    taskSourceId: task.sourceId,
                    taskId: task.id,
                    reason: `Stale in_progress corrected — remote is ${remoteState.status}`,
                  });
                  syncLogger.info({ taskId: task.id, sourceId: task.sourceId, remoteStatus: remoteState.status }, 'Corrected stale in_progress task');
                }
              } else {
                // 404/410 = issue deleted/transferred — skip, don't block sync
                const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
                if (/\b(404|410)\b/.test(msg)) continue;
                syncLogger.warn({ err: result.reason }, 'Failed to verify in_progress task');
              }
            }

            // Yield between batches to keep healthchecks responsive
            if (i + STALE_VERIFY_CONCURRENCY < tasksToVerify.length) {
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
        } catch (err) {
          verificationSucceeded = false;
          errors.push(`Stale task verification failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          syncLogger.info(
            {
              connectorId,
              phase: 'stale-task-verification',
              durationMs: Date.now() - verificationStartedAt,
              success: verificationSucceeded,
            },
            'Sync phase completed',
          );
        }
      }

      // ─── PHASE 5: Persist notifications ────────────────────────────────────
      throwIfSyncAborted(options?.signal);
      const remoteNotifications = await remoteNotificationsPromise;
      notificationsAdded = await this.upsertNotifications(connectorId, connector.type, remoteNotifications);
      notificationsAdded += domainDataResult?.notificationsAdded ?? 0;
      await connector.commitNotificationFetch?.();

      // ─── PHASE 6: Reconcile stale notifications ─────────────────────
      const alertsReconciled = await this.reconcileStaleNotifications(connectorId, connector, since);
      if (alertsReconciled > 0) {
        syncLogger.info({ connectorId, alertsReconciled }, 'Auto-resolved stale notifications');
      }

      // ─── Log to sync_log table ──────────────────────────────────────
      // The core sync (fetch + upsert) completed. Non-fatal errors from
      // ancillary phases (source list discovery, GitHub Projects, push)
      // are logged in the errors array but don't mark the sync as failed.
      // Only the catch block below (truly failed syncs) sets success=false.
      const result: SyncResult = {
        connectorId,
        success: true,
        tasksAdded,
        tasksUpdated,
        tasksRemoved,
        notificationsAdded,
        errors,
        syncedAt: new Date().toISOString(),
        ...(domainDataResult?.status ? { domainStatus: domainDataResult.status } : {}),
        ...(domainDataResult?.datasetErrors
          ? { datasetErrors: domainDataResult.datasetErrors }
          : {}),
      };
      const successLog = {
        id: randomUUID(),
        connectorId,
        success: true,
        tasksAdded,
        tasksUpdated,
        tasksRemoved,
        tasksPushed: pushResult.pushed,
        localOnlyProtected,
        notificationsAdded,
        errors: errors as unknown as string,
        details: details as unknown as string,
        syncedAt: result.syncedAt,
        durationMs: Date.now() - startTime,
        identityMode: identitySnapshot?.effectiveMode ?? null,
        identityModeRevision: identitySnapshot?.modeRevision ?? null,
      };
      runTransaction((tx) => {
        tx.insert(syncLog).values(successLog).run();
        identityComparison?.completeInTransaction(tx, 'succeeded');
      });

      this.lastSyncResults.set(connectorId, result);
      syncEventBus.emitSyncEvent({
        type: 'sync:complete',
        connectorId,
        queueRemaining: this.getQueueRemaining(),
        result: {
          tasksAdded,
          tasksUpdated,
          tasksRemoved,
          tasksPushed: pushResult.pushed,
          localOnlyProtected,
          notificationsAdded,
          totalLists: discoveredLists.length,
          durationMs: Date.now() - startTime,
          parentTasksAdded: upsertResult.parentTasksAdded,
          subtasksAdded: upsertResult.subtasksAdded,
        },
      });
      emitEvent({
        type: 'sync.completed',
        timestamp: result.syncedAt,
        payload: {
          connectorId,
          success: result.success,
          tasksAdded,
          tasksUpdated,
          tasksRemoved,
          notificationsAdded,
          errors,
        },
      }).catch((e) => syncLogger.error({ err: e, connectorId }, 'Failed to emit sync.completed event'));

      // Pre-warm search indexes in background so first Ctrl+K is instant
      warmUpSearchAfterSync().catch(() => {});

      syncLogger.info({
        connectorId,
        success: true,
        tasksAdded,
        tasksUpdated,
        tasksRemoved,
        notificationsAdded,
        durationMs: Date.now() - startTime,
        errors: errors.length,
      }, 'Sync completed');

      // ─── DURATION BUDGET GUARD ─────────────────────────────────────────
      const syncDurationMs = Date.now() - startTime;
      const durationBudgetMs = getSyncDurationBudgetMs();
      if (syncDurationMs > durationBudgetMs) {
        syncLogger.warn({
          connectorId,
          durationMs: syncDurationMs,
          tasksAdded,
          tasksUpdated,
          tasksRemoved,
          full: options?.full ?? false,
          durationBudgetMs,
        }, 'Sync exceeded configured duration budget');
        syncEventBus.emitSyncEvent({
          type: 'sync:degradation',
          connectorId,
          durationMs: syncDurationMs,
          reason: `Sync duration exceeded ${durationBudgetMs}ms budget`,
        });
      }

      return result;
    } catch (err) {
      const result: SyncResult = {
        connectorId,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        syncedAt: new Date().toISOString(),
      };

      const failureLog = {
        id: randomUUID(),
        connectorId,
        success: false,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 0,
        notificationsAdded: 0,
        errors: result.errors as unknown as string,
        details: details as unknown as string,
        syncedAt: result.syncedAt,
        durationMs: Date.now() - startTime,
        identityMode: identitySnapshot?.effectiveMode ?? null,
        identityModeRevision: identitySnapshot?.modeRevision ?? null,
      };
      try {
        runTransaction((tx) => {
          tx.insert(syncLog).values(failureLog).run();
          identityComparison?.completeInTransaction(
            tx,
            options?.signal?.aborted ? 'cancelled' : 'failed',
            options?.signal?.aborted ? 'sync_cancelled' : 'sync_failed',
          );
        });
      } catch (finalizationError) {
        syncLogger.error(
          { err: finalizationError, connectorId },
          'Failed to atomically finalize sync and GitHub identity comparison',
        );
        await db.insert(syncLog).values(failureLog).catch((logError) => {
          syncLogger.error({ err: logError, connectorId }, 'Failed to write error to sync_log');
        });
      }

      // Do NOT update lastSyncResults here. A failed sync should not advance the
      // `since` baseline — otherwise tasks updated during the failed window are
      // permanently missed until the next nightly full sync.
      // this.lastSyncResults.set(connectorId, result);  // intentionally removed

      syncEventBus.emitSyncEvent({
        type: 'sync:error',
        connectorId,
        queueRemaining: this.getQueueRemaining(),
        error: err instanceof Error ? err.message : String(err),
        runtimeRelease: publicRuntimeRelease(),
      });
      emitEvent({
        type: 'sync.failed',
        timestamp: result.syncedAt,
        payload: {
          connectorId,
          errors: result.errors,
        },
      }).catch((e) => syncLogger.error({ err: e, connectorId }, 'Failed to emit sync.failed event'));

      syncLogger.error({
        connectorId,
        err,
        durationMs: Date.now() - startTime,
      }, 'Sync failed');
      return result;
    } finally {
      this.syncInProgress.delete(connectorId);
    }
    });
  }

  /**
   * Refresh a connector from persisted config before each sync.
   */
  async initializeConnectorFromDb(connectorId: string): Promise<IConnector | null> {
    const [row] = await db.select().from(connectorConfigs).where(and(eq(connectorConfigs.id, connectorId), isNull(connectorConfigs.deletedAt))).limit(1);
    if (!row) {
      syncLogger.error({ connectorId }, 'No config row found in DB');
      return null;
    }

    const credentials = (typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials) || {};
    const settings = (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) || {};
    const capabilities = (typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities) || {};
    const syncedLists = (typeof row.syncedLists === 'string' ? JSON.parse(row.syncedLists) : row.syncedLists) || [];

    const config: ConnectorConfig = {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled ?? true,
      syncMode: (row.syncMode as ConnectorConfig['syncMode']) || 'poll',
      pollIntervalMinutes: row.pollIntervalMinutes ?? 5,
      capabilities: capabilities as ConnectorConfig['capabilities'],
      credentials,
      settings,
      syncedLists,
    };

    syncLogger.info({ connectorId, type: row.type, hasCredentials: !!credentials?.accessToken }, 'Refreshing connector from DB');
    return connectorRegistry.replaceConnector(config);
  }

  // ─── Notifications upsert ──────────────────────────────────────────────────

  private async upsertNotifications(
    connectorId: string,
    connectorType: string,
    remoteNotifications: InboundNotification[],
  ): Promise<number> {
    const now = new Date().toISOString();

    // ─── Resolve source-provider signatures, presentation, and actions ───
    const { enrichAlertBatch } = await import('@/lib/notifications/enrichment');
    const { materializeNotificationActions } = await import('@/lib/notifications/providers');
    const alertItemsForEnrichment = remoteNotifications.map(a => ({
        id: a.id,
        sourceId: a.id,
        connectorType,
        connectorInstanceId: connectorId,
        title: a.title,
        body: a.body,
        level: a.level,
        category: a.category,
        isRead: a.isRead,
        isActionable: a.isActionable || !!a.actionUrl,
        actionUrl: a.actionUrl,
        receivedAt: a.receivedAt,
        hubProjectIds: [],
        tags: [],
        metadata: a.metadata || {},
      }));

    const enrichedResults = alertItemsForEnrichment.length > 0
      ? await enrichAlertBatch(alertItemsForEnrichment, { enableAI: false })
      : [];

    // Build a lookup map: original alert id → enrichment result
    const enrichmentMap = new Map<string, typeof enrichedResults[number]>();
    for (const enriched of enrichedResults) {
      enrichmentMap.set(enriched.original.id, enriched);
    }

    const prepared: Array<{
      input: CreateNotificationInput;
      actionRecords: ReturnType<typeof materializeNotificationActions>;
      search: {
        id: string;
        title: string;
        body: string | null;
        severity: string;
        category: string;
        isActionable: boolean;
        receivedAt: string;
      };
      enrichment: typeof enrichedResults[number] | undefined;
      sourceMetadata: Record<string, unknown> | undefined;
    }> = [];

    for (let ai = 0; ai < remoteNotifications.length; ai++) {
      const alert = remoteNotifications[ai];
      // Yield every 10 notifications to keep healthchecks responsive
      if (ai > 0 && ai % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const sourceId = `${connectorId}:${alert.id}`;
      const enriched = enrichmentMap.get(alert.id);

      // Use enriched values if available, fall back to raw
      const title = enriched?.title || alert.title;
      const body = enriched?.body || alert.body || null;
      const category = enriched?.category || alert.category || 'general';
      const templateKey = enriched?.templateKey || alert.templateKey || null;
      const { level } = normalizeNotificationLevel(alert.level);
      const notificationId = randomUUID();
      const actionDrafts = enriched?.actions || [];
      const actionRecords = materializeNotificationActions(
        notificationId,
        actionDrafts,
        randomUUID,
      );
      const primaryAction = actionRecords.find(action => action.isPrimary) || null;
      const isActionable = enriched?.isActionable ?? alert.isActionable;

      const metadata = enriched?.metadata || alert.metadata || {};
      const presentation = enriched?.presentation || {};

      prepared.push({
        input: {
          id: notificationId,
          sourceId,
          connectorType,
          connectorInstanceId: connectorId,
          title,
          body,
          level,
          category,
          templateKey,
          readState: alert.isRead ? 'read' : 'unread',
          sourceState: alert.sourceState ?? 'active',
          sourceActivityAt: alert.sourceActivityAt ?? null,
          sourceActivityKey: alert.sourceActivityKey ?? null,
          reopenPolicy: alert.reopenPolicy ?? 'handled',
          occurrenceKey: alert.sourceActivityKey
            ?? alert.sourceActivityAt
            ?? 'initial',
          isActionable,
          primaryActionId: primaryAction?.id || null,
          receivedAt: alert.receivedAt || now,
          sortAt: alert.receivedAt || now,
          relatedTaskId: enriched?.relatedTaskId || null,
          relatedProjectId: enriched?.relatedProjectId || null,
          relatedEntityType: enriched?.relatedEntityType || null,
          relatedEntityId: enriched?.relatedEntityId || null,
          navigationTarget: enriched?.navigationTarget || null,
          metadata,
          presentation,
        },
        actionRecords,
        search: {
          id: notificationId,
          title,
          body,
          severity: alert.level || 'digest',
          category,
          isActionable,
          receivedAt: alert.receivedAt || now,
        },
        enrichment: enriched,
        sourceMetadata: alert.metadata,
      });
    }

    const creationResults = db.transaction(transaction => {
      const results = createNotificationsInTransaction(
        transaction,
        prepared.map(item => item.input),
      );
      results.forEach((result, index) => {
        if (!result.created || prepared[index].actionRecords.length === 0) return;
        transaction.insert(notificationActions)
          .values(prepared[index].actionRecords)
          .run();
      });
      return results;
    });
    if (creationResults.some(result => result.deliveryEvent?.status === 'pending')) {
      wakeNotificationDeliveryDispatcher();
    }

    let added = 0;
    for (let index = 0; index < creationResults.length; index++) {
      if (!creationResults[index].created) continue;
      const item = prepared[index];
      await indexAlertForSearch({
        ...item.search,
        isRead: item.input.readState === 'read',
        connectorType,
      });
      added++;

      // ─── Async AI enrichment (fire-and-forget after persist) ──────────
      if (item.enrichment && item.sourceMetadata) {
        this.scheduleAIEnrichment(
          item.search.id,
          item.search.title,
          item.search.body,
          connectorType,
          item.search.category,
          item.sourceMetadata,
          item.enrichment.presentation,
        );
      }
    }

    return added;
  }

  /**
   * Schedule AI enrichment to run asynchronously after the notification is persisted.
   * Updates the notification in-place once AI completes.
   */
  private scheduleAIEnrichment(
    notificationId: string,
    title: string,
    body: string | null,
    connectorType: string,
    category: string,
    metadata: Record<string, unknown>,
    presentation: Record<string, unknown>,
  ): void {
    // Fire-and-forget — don't block sync
    setImmediate(async () => {
      try {
        const { enrichWithAI } = await import('@/lib/notifications/enrichment/ai-enrichment');
        const result = await enrichWithAI({
          notificationId,
          title,
          body,
          connectorType,
          category,
          metadata,
          presentation,
        });

        if (result) {
          const existingRow = await db.select({ metadata: notificationsTable.metadata })
            .from(notificationsTable)
            .where(eq(notificationsTable.id, notificationId))
            .limit(1);

          if (existingRow.length > 0) {
            const existingMeta = typeof existingRow[0].metadata === 'string'
              ? JSON.parse(existingRow[0].metadata)
              : existingRow[0].metadata || {};

            const updatedMeta = {
              ...existingMeta,
              aiSummary: result.summary,
              aiSuggestedAction: result.suggestedAction,
              aiSuggestedActionReason: result.suggestedActionReason,
              aiContextTags: result.contextTags,
              aiEnrichedAt: new Date().toISOString(),
            };

            await db.update(notificationsTable)
              .set({ metadata: JSON.stringify(updatedMeta) })
              .where(eq(notificationsTable.id, notificationId));
          }
        }
      } catch {
        // Silent — AI enrichment is optional
      }
    });
  }

  // ─── Notification Reconciliation ──────────────────────────────────────────

  /** Maximum days a notification can remain unverifiable before auto-archival */
  private static STALE_ARCHIVE_DAYS = 7;
  /** Maximum reconcile failures before marking as stale */
  private static STALE_AFTER_ATTEMPTS = 3;
  /** Max notifications to deep-check per sync (avoids API rate limits) */
  private static RECONCILE_BATCH_LIMIT = 25;

  /**
   * Reconcile existing active notifications against their upstream source.
   *
   * Two strategies:
   * 1. "Clear and refresh" (getActiveAlertSourceIds): connector returns all
   *    currently-active IDs. Anything NOT in that set is resolved.
   * 2. "Per-ID check" (reconcileAlerts): connector checks specific IDs.
   *
   * Staleness fallback: if reconciliation fails repeatedly, notifications
   * get archived after STALE_ARCHIVE_DAYS to avoid unbounded growth.
   */
  private async reconcileStaleNotifications(
    connectorId: string,
    connector: IConnector,
    since?: Date,
  ): Promise<number> {
    // Skip if connector doesn't support any reconciliation
    if (!connector.getActiveAlertSourceIds && !connector.reconcileAlerts) {
      return this.archiveStaleNotifications(connectorId);
    }

    const now = new Date().toISOString();
    let resolved = 0;

    // Reconcile every source-active notification, independent of local disposition.
    const activeNotifications = await db.select({
      id: notificationsTable.id,
      sourceId: notificationsTable.sourceId,
      reconcileAttempts: notificationsTable.reconcileAttempts,
      staleSince: notificationsTable.staleSince,
    })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.connectorInstanceId, connectorId),
          inArray(notificationsTable.sourceState, ['active', 'unknown']),
          sql`(${notificationsTable.templateKey} IS NULL OR ${notificationsTable.templateKey} <> 'workflow_result')`,
        )
      );

    if (activeNotifications.length === 0) return 0;

    // Strategy 1: Full refresh — "give me everything that's still active"
    // Notifications not in the upstream set get auto-resolved. Those still
    // present are collected for deeper per-ID checks (Strategy 2) since the
    // upstream source may still list a notification even when the underlying
    // subject (e.g. a PR) has been merged/closed.
    let remainingAfterStrategy1 = activeNotifications;

    if (connector.getActiveAlertSourceIds) {
      try {
        const activeUpstream = await connector.getActiveAlertSourceIds(since);
        if (activeUpstream !== null) {
          const activeSet = new Set(activeUpstream.map(id => `${connectorId}:${id}`));
          const stillActive: typeof activeNotifications = [];

          for (const notification of activeNotifications) {
            if (!activeSet.has(notification.sourceId)) {
              // No longer reported by source — auto-resolve
              await db.update(notificationsTable)
                .set({
                  state: sql`CASE
                    WHEN ${notificationsTable.disposition} = 'dismissed' THEN 'dismissed'
                    ELSE 'resolved'
                  END`,
                  sourceState: 'resolved',
                  resolvedAt: now,
                  sourceResolvedAt: now,
                  lastReconciledAt: now,
                  reconcileAttempts: 0,
                  staleSince: null,
                  autoResolveReason: 'not_in_source',
                })
                .where(eq(notificationsTable.id, notification.id));
              resolved++;
            } else {
              stillActive.push(notification);
            }
          }

          remainingAfterStrategy1 = stillActive;
        }
      } catch (err) {
        syncLogger.warn({ connectorId, err }, 'getActiveAlertSourceIds failed, falling through to per-ID reconciliation');
        // Fall through to per-ID or staleness handling
      }
    }

    if (remainingAfterStrategy1.length === 0) return resolved;

    // Strategy 2: Per-ID reconciliation — checks underlying subject state
    // (e.g. PR merged, issue closed) even if the notification is still in
    // the user's upstream inbox. Capped to avoid API rate-limit exhaustion.
    if (connector.reconcileAlerts) {
      const batch = remainingAfterStrategy1.slice(0, SyncScheduler.RECONCILE_BATCH_LIMIT);
      const sourceIds = batch.map(n => n.sourceId);
      try {
        const results = await connector.reconcileAlerts(sourceIds);
        const resultMap = new Map(results.map(r => [r.sourceId, r]));

        for (const notification of batch) {
          const result = resultMap.get(notification.sourceId);
          if (result?.resolved) {
            await db.update(notificationsTable)
              .set({
                state: sql`CASE
                  WHEN ${notificationsTable.disposition} = 'dismissed' THEN 'dismissed'
                  ELSE 'resolved'
                END`,
                sourceState: 'resolved',
                resolvedAt: result.resolvedAt || now,
                sourceResolvedAt: result.resolvedAt || now,
                lastReconciledAt: now,
                reconcileAttempts: 0,
                staleSince: null,
                autoResolveReason: result.reason || 'handled_upstream',
              })
              .where(eq(notificationsTable.id, notification.id));
            resolved++;
          } else {
            // Verified still active
            await db.update(notificationsTable)
              .set({
                lastReconciledAt: now,
                reconcileAttempts: 0,
                staleSince: null,
              })
              .where(eq(notificationsTable.id, notification.id));
          }
        }

        return resolved;
      } catch (err) {
        syncLogger.warn({ connectorId, err }, 'reconcileAlerts failed, incrementing staleness');
        // Increment reconcile attempts on failure
        for (const notification of batch) {
          const newAttempts = (notification.reconcileAttempts || 0) + 1;
          const staleSince = notification.staleSince || now;
          await db.update(notificationsTable)
            .set({
              reconcileAttempts: newAttempts,
              staleSince,
            })
            .where(eq(notificationsTable.id, notification.id));
        }
      }
    }

    // Staleness fallback: archive notifications that have been unverifiable too long
    resolved += await this.archiveStaleNotifications(connectorId);
    return resolved;
  }

  /**
   * Archive notifications that have exceeded the staleness threshold.
   * This is the fail-closed safety valve: if we can't reach the source
   * to verify a notification is still relevant, eventually archive it
   * rather than letting stale items pile up indefinitely.
   */
  private async archiveStaleNotifications(connectorId: string): Promise<number> {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - SyncScheduler.STALE_ARCHIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const staleNotifications = await db.select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.connectorInstanceId, connectorId),
          inArray(notificationsTable.sourceState, ['active', 'unknown']),
          sql`(${notificationsTable.templateKey} IS NULL OR ${notificationsTable.templateKey} <> 'workflow_result')`,
          sql`${notificationsTable.staleSince} IS NOT NULL AND ${notificationsTable.staleSince} < ${cutoff}`,
          sql`${notificationsTable.reconcileAttempts} >= ${SyncScheduler.STALE_AFTER_ATTEMPTS}`,
        )
      );

    if (staleNotifications.length === 0) return 0;

    const ids = staleNotifications.map(n => n.id);
    await db.update(notificationsTable)
      .set({
        state: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN 'dismissed'
          ELSE 'archived'
        END`,
        disposition: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN 'dismissed'
          ELSE 'handled'
        END`,
        sourceState: 'unknown',
        handledAt: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN ${notificationsTable.handledAt}
          ELSE ${now}
        END`,
        handledSourceActivityAt: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN ${notificationsTable.handledSourceActivityAt}
          ELSE ${notificationsTable.lastSourceActivityAt}
        END`,
        handledSourceActivityKey: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN ${notificationsTable.handledSourceActivityKey}
          ELSE ${notificationsTable.lastSourceActivityKey}
        END`,
        archivedAt: sql`CASE
          WHEN ${notificationsTable.disposition} = 'dismissed' THEN ${notificationsTable.archivedAt}
          ELSE ${now}
        END`,
        autoResolveReason: 'stale_unverifiable',
      })
      .where(inArray(notificationsTable.id, ids));

    syncLogger.info({ connectorId, count: ids.length }, 'Auto-archived stale unverifiable notifications');
    return ids.length;
  }

  // ─── GitHub Projects → Hub Projects ─────────────────────────────────────

  /**
   * Creates/updates Hub Projects from GitHub Projects V2 and links tasks
   * via the taskProjects junction table. This allows issues to stay in their
   * repo source list while also appearing under Projects in the sidebar.
   */
  private async syncGitHubProjectsAsHubProjects(
    connectorId: string,
    associations: Array<{
      project: {
        id: string;
        number: number;
        title: string;
        shortDescription: string | null;
        url: string;
      };
      taskSourceIds: string[];
    }>,
    stableIdentity?: {
      stableProjectTaskIds: ReadonlyMap<number, ReadonlySet<string>>;
      blockedStableProjects: ReadonlySet<number>;
    },
    assertIdentityCurrent?: () => void,
  ): Promise<void> {
    if (associations.length === 0) {
      syncLogger.debug({ connectorId }, 'No GitHub Project associations to sync');
      return;
    }

    syncLogger.info({ connectorId, projectCount: associations.length }, 'Syncing GitHub Projects as Hub Projects');

    const now = new Date().toISOString();

    for (const { project, taskSourceIds } of associations) {
      assertIdentityCurrent?.();
      if (stableIdentity?.blockedStableProjects.has(project.number)) {
        syncLogger.warn(
          { connectorId, projectNumber: project.number },
          'Stable GitHub project association was fenced by identity evidence',
        );
        continue;
      }
      // Stable hub project ID derived from connector + project number
      const hubProjectId = `gh-project:${connectorId}:${project.number}`;

      // Upsert the hub project
      const [existing] = await db.select({
        id: hubProjects.id,
        metadata: hubProjects.metadata,
      })
        .from(hubProjects)
        .where(eq(hubProjects.id, hubProjectId))
        .limit(1);

      if (existing) {
        const existingIdentityDigest = (
          existing.metadata
          && typeof existing.metadata === 'object'
          && 'githubProjectIdentityDigest' in existing.metadata
          && typeof existing.metadata.githubProjectIdentityDigest === 'string'
        )
          ? existing.metadata.githubProjectIdentityDigest
          : undefined;
        const projectIdentityDigest = resolveGitHubProjectIdentityDigest(
          project,
          existingIdentityDigest,
        );
        assertIdentityCurrent?.();
        await db.update(hubProjects)
          .set({
            name: project.title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]+\s*/u, ''),
            description: project.shortDescription || undefined,
            metadata: {
              githubProjectNumber: project.number,
              githubProjectUrl: project.url,
              githubProjectIdentityDigest: projectIdentityDigest,
              connectorId,
              syncManaged: true,
            },
            updatedAt: now,
          })
          .where(eq(hubProjects.id, hubProjectId));
      } else {
        const projectIdentityDigest = resolveGitHubProjectIdentityDigest(project);
        assertIdentityCurrent?.();
        await db.insert(hubProjects).values({
          id: hubProjectId,
          name: project.title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]+\s*/u, ''),
          description: project.shortDescription || undefined,
          color: '#6e40c9', // GitHub purple
          icon: null,
          sourceBindings: [{
            connectorId,
            type: 'github-project',
            projectNumber: project.number,
          }],
          metadata: {
            githubProjectNumber: project.number,
            githubProjectUrl: project.url,
            githubProjectIdentityDigest: projectIdentityDigest,
            connectorId,
            syncManaged: true,
          },
          createdAt: now,
          updatedAt: now,
        });
      }

      // Resolve sourceIds to task DB IDs
      if (taskSourceIds.length === 0 && !stableIdentity) continue;

      const stableTaskIds = stableIdentity?.stableProjectTaskIds.get(project.number);
      const matchingTasks = stableIdentity
        ? (
            stableTaskIds && stableTaskIds.size > 0
              ? await db.select({
                  id: tasksTable.id,
                  sourceId: tasksTable.sourceId,
                }).from(tasksTable).where(and(
                  eq(tasksTable.connectorInstanceId, connectorId),
                  inArray(tasksTable.id, [...stableTaskIds]),
                ))
              : []
          )
        : await db.select({
            id: tasksTable.id,
            sourceId: tasksTable.sourceId,
          })
            .from(tasksTable)
            .where(
              and(
                eq(tasksTable.connectorInstanceId, connectorId),
                inArray(tasksTable.sourceId, taskSourceIds),
              ),
            );

      if (matchingTasks.length === 0 && !stableIdentity) continue;

      // Get existing associations for this hub project
      const existingAssocs = await db.select({ taskId: taskProjects.taskId })
        .from(taskProjects)
        .where(eq(taskProjects.projectId, hubProjectId));
      const existingTaskIds = new Set(existingAssocs.map(a => a.taskId));

      // Insert new associations (skip already-linked tasks)
      const newAssocs = matchingTasks
        .filter(t => !existingTaskIds.has(t.id))
        .map(t => ({ taskId: t.id, projectId: hubProjectId }));

      if (newAssocs.length > 0) {
        assertIdentityCurrent?.();
        await db.insert(taskProjects).values(newAssocs).onConflictDoNothing();
      }

      // Remove associations for tasks no longer in the project
      const currentTaskIds = new Set(matchingTasks.map(t => t.id));
      const staleTaskIds = existingAssocs
        .filter(a => !currentTaskIds.has(a.taskId))
        .map(a => a.taskId);

      if (staleTaskIds.length > 0) {
        for (const staleId of staleTaskIds) {
          assertIdentityCurrent?.();
          await db.delete(taskProjects).where(
            and(
              eq(taskProjects.taskId, staleId),
              eq(taskProjects.projectId, hubProjectId),
            ),
          );
        }
      }

      syncLogger.info({
        connectorId,
        projectNumber: project.number,
        projectTitle: project.title,
        tasksLinked: newAssocs.length,
        tasksUnlinked: staleTaskIds.length,
      }, 'Synced GitHub Project as Hub Project');
    }
  }

  // ─── Orchestration ──────────────────────────────────────────────────────

  /**
   * Run sync for ALL active connectors.
   */
  async runAll(full?: boolean): Promise<SyncResult[]> {
    const allConfigs = await db.select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));

    const connectorIds = allConfigs.map(c => c.id);
    for (const c of connectorRegistry.getAllConnectors()) {
      if (!connectorIds.includes(c.id)) connectorIds.push(c.id);
    }

    const results = await Promise.allSettled(
      connectorIds.map(id => this.runSync(id, { full, source: 'api' }))
    );
    return results
      .filter((r): r is PromiseFulfilledResult<SyncResult> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  /**
   * Get the last sync result for a connector.
   */
  getLastResult(connectorId: string): SyncResult | undefined {
    return isDurableSyncMode()
      ? getLatestDurableSyncResult(connectorId)
      : this.lastSyncResults.get(connectorId);
  }

  /**
   * Get status of all scheduled jobs.
   */
  getStatus(): Array<{
    connectorId: string;
    intervalMinutes: number;
    isRunning: boolean;
    lastResult?: SyncResult;
  }> {
    const activeConnectorIds = isDurableSyncMode()
      ? new Set(getActiveSyncJobConnectorIds())
      : this.syncInProgress;
    const schedules = isDurableSyncMode()
      ? getSyncSchedules()
      : Array.from(this.jobs.values());
    return schedules.map(job => ({
      connectorId: job.connectorId,
      intervalMinutes: job.intervalMinutes,
      isRunning: activeConnectorIds.has(job.connectorId),
      lastResult: this.getLastResult(job.connectorId),
    }));
  }

  /** Returns true if any connector is currently syncing. */
  isSyncing(): boolean {
    return isDurableSyncMode()
      ? getSyncQueueMetrics().running > 0
      : this.syncInProgress.size > 0;
  }

  /** Returns the set of connector IDs currently syncing. */
  getActiveSyncs(): string[] {
    return isDurableSyncMode()
      ? getActiveSyncJobConnectorIds()
      : Array.from(this.syncInProgress);
  }

  private getQueueRemaining(): number {
    if (isDurableSyncMode()) {
      return countRemainingSyncJobs(getSyncQueueMetrics());
    }
    return this.syncQueue.length + Math.max(0, this.activeSyncCount - 1);
  }

  /**
   * Load all enabled connectors from the DB and schedule their cron jobs.
   */
  async scheduleAll(): Promise<void> {
    try {
      const rows = await db.select().from(connectorConfigs)
        .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));

      let scheduled = 0;
      for (const row of rows) {
        if (this.jobs.has(row.id)) continue;

        try {
          const config: ConnectorConfig = {
            id: row.id,
            type: row.type,
            name: row.name,
            enabled: row.enabled ?? true,
            syncMode: (row.syncMode as ConnectorConfig['syncMode']) || 'poll',
            pollIntervalMinutes: row.pollIntervalMinutes ?? 5,
            capabilities: (typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities) as ConnectorConfig['capabilities'],
            credentials: (typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials) || {},
            settings: (typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings) || {},
            syncedLists: (typeof row.syncedLists === 'string' ? JSON.parse(row.syncedLists) : row.syncedLists) || [],
          };

          this.schedule(config, scheduled);
          scheduled++;
        } catch (connectorErr) {
          syncLogger.error({ err: connectorErr, connectorId: row.id }, 'Failed to schedule individual connector');
        }
      }

      syncLogger.info({ scheduled, alreadyScheduled: this.jobs.size - scheduled, total: rows.length }, 'Scheduled all connectors from DB');
    } catch (err) {
      syncLogger.error({ err }, 'Failed to schedule connectors from DB');
      throw err;
    }
  }

  /**
   * Stop all scheduled jobs.
   */
  async stopAll(): Promise<void> {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
    this.jobs.clear();
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.nightlyFullSyncTask) {
      this.nightlyFullSyncTask.stop();
      this.nightlyFullSyncTask = null;
    }
    if (this.dependencyReconciliationResumeTimer) {
      clearInterval(this.dependencyReconciliationResumeTimer);
      this.dependencyReconciliationResumeTimer = null;
    }
    if (this.dependencyRelationshipPollTimer) {
      clearInterval(this.dependencyRelationshipPollTimer);
      this.dependencyRelationshipPollTimer = null;
    }
    this.dependencyRelationshipPollEnabled = false;
    this.dependencyRelationshipPollAbortController?.abort(
      new Error('Dependency relationship polling stopped'),
    );
    this.dependencyReconciliationResumeEnabled = false;
    this.dependencyReconciliationFollowUpRequested = false;
    for (const timer of this.dependencyReconciliationRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.dependencyReconciliationRetryTimers.clear();
    this.dependencyReconciliationBusyRetryCounts.clear();

    const activeDependencyRuns: Array<{
      promise: Promise<void>;
      timeoutMs: number;
      warning: string;
      settled: boolean;
    }> = [];
    const activeResume = this.dependencyReconciliationResumeRun;
    if (activeResume) {
      activeDependencyRuns.push({
        promise: activeResume,
        timeoutMs: dependencyShutdownTimeoutMs(
          'MC_DEPENDENCY_RECONCILIATION_SHUTDOWN_TIMEOUT_MS',
        ),
        warning: 'Dependency reconciliation resume did not drain before shutdown timeout',
        settled: false,
      });
    }
    const activePoll = this.dependencyRelationshipPollRun;
    if (activePoll) {
      activeDependencyRuns.push({
        promise: activePoll,
        timeoutMs: dependencyShutdownTimeoutMs(
          'MC_DEPENDENCY_RELATIONSHIP_POLL_SHUTDOWN_TIMEOUT_MS',
        ),
        warning: 'Dependency relationship poll did not drain before shutdown timeout',
        settled: false,
      });
    }
    if (activeDependencyRuns.length > 0) {
      // Concurrent runs share the larger configured budget so neither legacy setting is shortened.
      const timeoutMs = Math.max(...activeDependencyRuns.map((run) => run.timeoutMs));
      const failures: unknown[] = [];
      const drain = Promise.all(activeDependencyRuns.map((run) =>
        run.promise.then(
          () => {
            run.settled = true;
          },
          (error: unknown) => {
            run.settled = true;
            failures.push(error);
          },
        ),
      ));
      let deadlineReached = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          drain,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              deadlineReached = true;
              resolve();
            }, timeoutMs);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (deadlineReached) {
        for (const run of activeDependencyRuns) {
          if (!run.settled) {
            syncLogger.warn({ timeoutMs }, run.warning);
          }
        }
      }
      if (failures.length > 0) {
        throw failures[0];
      }
    }
  }

  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly STALE_THRESHOLD_MS = 20 * 60 * 1000;

  /**
   * Schedule a nightly full sync at 3:00 AM for all enabled connectors.
   * Catches transferred/deleted items that incremental syncs miss.
   */
  startNightlyFullSync(): void {
    if (this.nightlyFullSyncTask) return;

    // Run at 3:00 AM every day
    this.nightlyFullSyncTask = cron.schedule('0 3 * * *', async () => {
      syncLogger.info('Nightly full sync starting');
      try {
        const rows = await db.select({ id: connectorConfigs.id })
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));

        for (const row of rows) {
          try {
            await this.runSync(row.id, { full: true, source: 'nightly' });
          } catch (err) {
            syncLogger.error({ err, connectorId: row.id }, 'Nightly full sync failed for connector');
          }
        }
        syncLogger.info({ connectorCount: rows.length }, 'Nightly full sync complete');
      } catch (err) {
        syncLogger.error({ err }, 'Nightly full sync failed');
      }
    });

    this.nightlyFullSyncTask.start();
    syncLogger.info('Nightly full sync scheduled for 3:00 AM');
  }

  async resumeDependencyReconciliations(
    trigger: DependencyResumeTrigger = 'manual',
    onlyConnectorIds?: ReadonlySet<string>,
  ): Promise<void> {
    if (this.dependencyReconciliationResumeRun) {
      syncLogger.info(
        { trigger, reason: 'previous-run-active' },
        'Dependency reconciliation resume run deferred',
      );
      if (trigger === 'retry' && onlyConnectorIds) {
        for (const connectorId of onlyConnectorIds) {
          this.scheduleDependencyReconciliationRetry(connectorId);
        }
      } else if (trigger === 'recurring') {
        this.dependencyReconciliationFollowUpRequested = true;
      }
      return;
    }

    const run = this.executeDependencyReconciliationResume(trigger, onlyConnectorIds);
    this.dependencyReconciliationResumeRun = run;
    try {
      await run;
    } finally {
      if (this.dependencyReconciliationResumeRun === run) {
        this.dependencyReconciliationResumeRun = null;
      }
      if (
        this.dependencyReconciliationFollowUpRequested
        && this.dependencyReconciliationResumeEnabled
      ) {
        this.dependencyReconciliationFollowUpRequested = false;
        void this.resumeDependencyReconciliations('recurring').catch((error) => {
          syncLogger.error(
            { err: error },
            'Coalesced dependency reconciliation resume failed',
          );
        });
      }
    }
  }

  private async executeDependencyReconciliationResume(
    trigger: DependencyResumeTrigger,
    onlyConnectorIds?: ReadonlySet<string>,
  ): Promise<void> {
    const candidates = (await getResumableDependencyReconciliations())
      .filter(({ connectorId }) => !onlyConnectorIds || onlyConnectorIds.has(connectorId));
    const summary: DependencyResumeSummary = {
      attempted: candidates.length,
      advanced: 0,
      deferred: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      if (trigger !== 'retry') {
        this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
      }
      await this.resumeDependencyReconciliationCandidate(candidate, trigger, summary);
    }

    syncLogger.info(
      { trigger, ...summary },
      candidates.length === 0
        ? 'Dependency reconciliation resume run found no active snapshots'
        : 'Dependency reconciliation resume run completed',
    );
  }

  private async resumeDependencyReconciliationCandidate(
    candidate: DependencyReconciliationResumeCandidate,
    trigger: DependencyResumeTrigger,
    summary: DependencyResumeSummary,
  ): Promise<void> {
    const attemptedAt = new Date().toISOString();
    if (
      candidate.status === 'failed'
      && candidate.nextAttemptAt
      && candidate.nextAttemptAt > attemptedAt
    ) {
      summary.deferred++;
      await this.recordDependencyResumeOutcome(
        candidate,
        trigger,
        'deferred',
        'retry-backoff',
        attemptedAt,
      );
      return;
    }

    try {
      const result = await this.runExclusiveConnectorOperation(
        candidate.connectorId,
        async () => {
          const connector = connectorRegistry.getConnector(candidate.connectorId)
            ?? await this.initializeConnectorFromDb(candidate.connectorId);
          if (!connector) return null;
          return withSyncPhaseTiming(
            candidate.connectorId,
            'dependency-reconciliation-resume',
            () => reconcileTaskDependencies(
              candidate.connectorId,
              connector,
              {
                full: true,
                resumeGenerationId: candidate.generationId,
              },
            ),
          );
        },
      );

      if (!result) {
        this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
        summary.deferred++;
        await this.recordDependencyResumeOutcome(
          candidate,
          trigger,
          'deferred',
          'connector-unavailable',
          attemptedAt,
        );
        return;
      }

      if (result.resumeSkippedReason) {
        this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
        summary.deferred++;
        await this.recordDependencyResumeOutcome(
          candidate,
          trigger,
          'deferred',
          result.resumeSkippedReason,
          attemptedAt,
        );
        return;
      }

      const progress = result.snapshot;
      if (!progress || (
        progress.status === 'failed'
        && progress.processed === candidate.processed
      )) {
        this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
        summary.deferred++;
        await this.recordDependencyResumeOutcome(
          candidate,
          trigger,
          'deferred',
          progress ? 'retry-backoff' : 'dependency-capability-unavailable',
          attemptedAt,
        );
        return;
      }

      this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
      summary.advanced++;
      await this.recordDependencyResumeOutcome(
        candidate,
        trigger,
        'advanced',
        progress.status === 'running' ? 'batch-advanced' : `snapshot-${progress.status}`,
        attemptedAt,
      );
    } catch (error) {
      if (error instanceof ConnectorOperationBusyError) {
        summary.deferred++;
        await this.recordDependencyResumeOutcome(
          candidate,
          trigger,
          'deferred',
          'connector-busy',
          attemptedAt,
        );
        this.scheduleDependencyReconciliationRetry(candidate.connectorId);
        return;
      }

      summary.failed++;
      this.dependencyReconciliationBusyRetryCounts.delete(candidate.connectorId);
      await this.recordDependencyResumeOutcome(
        candidate,
        trigger,
        'failed',
        'batch-failed',
        attemptedAt,
      );
      syncLogger.warn(
        {
          err: error,
          connectorId: candidate.connectorId,
          dependencySnapshotId: candidate.generationId,
          trigger,
        },
        'Scheduled dependency reconciliation resume failed',
      );
    }
  }

  private async recordDependencyResumeOutcome(
    candidate: DependencyReconciliationResumeCandidate,
    trigger: DependencyResumeTrigger,
    outcome: 'advanced' | 'deferred' | 'failed',
    reason: string,
    attemptedAt: string,
  ): Promise<void> {
    await recordDependencyReconciliationResumeOutcome(
      candidate.generationId,
      outcome,
      reason,
      attemptedAt,
    );
    syncLogger.info({
      connectorId: candidate.connectorId,
      dependencySnapshotId: candidate.generationId,
      trigger,
      outcome,
      reason,
      processed: candidate.processed,
      total: candidate.total,
    }, 'Dependency reconciliation resume attempt recorded');
  }

  private scheduleDependencyReconciliationRetry(connectorId: string): void {
    if (
      !this.dependencyReconciliationResumeEnabled
      || this.dependencyReconciliationRetryTimers.has(connectorId)
    ) {
      return;
    }
    const retryCount = this.dependencyReconciliationBusyRetryCounts.get(connectorId) ?? 0;
    if (retryCount >= 3) {
      syncLogger.warn(
        { connectorId, retryCount, reason: 'busy-retry-limit-reached' },
        'Dependency reconciliation busy retries exhausted until next cadence',
      );
      return;
    }
    this.dependencyReconciliationBusyRetryCounts.set(connectorId, retryCount + 1);
    const configured = Number(
      process.env.MC_DEPENDENCY_RECONCILIATION_BUSY_RETRY_MS,
    );
    const delayMs = Number.isFinite(configured) && configured > 0
      ? Math.min(Math.floor(configured), 5 * 60_000)
      : 60_000;
    const timer = setTimeout(() => {
      this.dependencyReconciliationRetryTimers.delete(connectorId);
      if (!this.dependencyReconciliationResumeEnabled) return;
      void this.resumeDependencyReconciliations(
        'retry',
        new Set([connectorId]),
      ).catch((error) => {
        syncLogger.error(
          { err: error, connectorId },
          'Dependency reconciliation busy retry failed',
        );
      });
    }, delayMs);
    timer.unref();
    this.dependencyReconciliationRetryTimers.set(connectorId, timer);
  }

  startDependencyReconciliationResume(): void {
    if (this.dependencyReconciliationResumeTimer) return;
    const configuredMinutes = Number(
      process.env.MC_DEPENDENCY_RECONCILIATION_RESUME_MINUTES,
    );
    const requestedMinutes = Math.floor(configuredMinutes);
    const maxIntervalMinutes = Math.floor(2_147_483_647 / 60_000);
    const minutes = Number.isFinite(configuredMinutes)
      && requestedMinutes >= 1
      && requestedMinutes <= maxIntervalMinutes
      ? requestedMinutes
      : 15;
    this.dependencyReconciliationResumeEnabled = true;
    this.dependencyReconciliationResumeTimer = setInterval(() => {
      syncLogger.info(
        { trigger: 'recurring', intervalMinutes: minutes },
        'Dependency reconciliation resume tick fired',
      );
      void this.resumeDependencyReconciliations('recurring').catch((error) => {
        syncLogger.error(
          { err: error },
          'Dependency reconciliation resume scheduler failed',
        );
      });
    }, minutes * 60_000);
    this.dependencyReconciliationResumeTimer.unref();
    this.resumeDependencyReconciliations('startup').catch((error) => {
      syncLogger.warn(
        { err: error },
        'Initial dependency reconciliation resume failed',
      );
    });
    syncLogger.info(
      { intervalMinutes: minutes },
      'Dependency reconciliation resume scheduler started',
    );
  }

  async pollDueDependencyRelationships(trigger: 'startup' | 'recurring' | 'manual' = 'manual'): Promise<void> {
    if (this.dependencyRelationshipPollRun) {
      syncLogger.info({ trigger }, 'Dependency relationship poll deferred because a poll run is active');
      return this.dependencyRelationshipPollRun;
    }
    const run = this.executeDueDependencyRelationshipPolls(trigger);
    this.dependencyRelationshipPollRun = run;
    try {
      await run;
    } finally {
      if (this.dependencyRelationshipPollRun === run) {
        this.dependencyRelationshipPollRun = null;
      }
    }
  }

  private async executeDueDependencyRelationshipPolls(
    trigger: 'startup' | 'recurring' | 'manual',
  ): Promise<void> {
    const intervalMinutes = this.getDependencyRelationshipPollIntervalMinutes();
    const dueBefore = Date.now() - intervalMinutes * 60_000;
    const [configs, health] = await Promise.all([
      db.select({
        id: connectorConfigs.id,
        type: connectorConfigs.type,
        capabilities: connectorConfigs.capabilities,
      }).from(connectorConfigs).where(and(
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
        eq(connectorConfigs.type, 'github-issues'),
      )),
      getDependencyReconciliationHealth(),
    ]);

    for (const config of configs) {
      if (!this.dependencyRelationshipPollEnabled && trigger !== 'manual') return;
      const capabilities = typeof config.capabilities === 'string'
        ? JSON.parse(config.capabilities) as ConnectorConfig['capabilities']
        : config.capabilities as ConnectorConfig['capabilities'];
      if (capabilities?.dependencyRead === false) continue;
      const relationshipHealth = health.get(config.id);
      const completedAt = relationshipHealth?.lastCompletedAt;
      if (completedAt && new Date(completedAt).getTime() > dueBefore) continue;
      if (relationshipHealth?.collectionPhase === 'collecting'
        || relationshipHealth?.reconciliationPhase === 'reconciling') {
        syncLogger.info(
          { connectorId: config.id, trigger, reason: 'active-generation' },
          'Dependency relationship poll deferred',
        );
        continue;
      }

      syncLogger.info(
        { connectorId: config.id, trigger, intervalMinutes, lastCompletedAt: completedAt },
        'Dependency relationship poll due',
      );
      try {
        await this.runExclusiveConnectorOperation(config.id, async () => {
          const connector = connectorRegistry.getConnector(config.id)
            ?? await this.initializeConnectorFromDb(config.id);
          if (
            !connector
            || connector.dependencySnapshotStrategy !== 'task-stream'
            || !connector.capabilities.dependencyRead
          ) return;
          const identitySnapshot = getGitHubIdentityModeSnapshot(config.id);
          const generation = await beginDependencySnapshotGeneration(
            config.id,
            identitySnapshot,
          );
          if (!generation) {
            syncLogger.info(
              { connectorId: config.id, trigger, reason: 'active-generation' },
              'Dependency relationship poll deferred',
            );
            return;
          }
          const identityComparison = (
            identitySnapshot.effectiveMode === 'comparison'
            || identitySnapshot.effectiveMode === 'stable'
          )
            ? new GitHubIdentityComparisonRuntime({
                connectorInstanceId: config.id,
                modeSnapshot: identitySnapshot,
                syncKind: 'incremental',
              })
            : undefined;
          const hierarchyObservations = new Map<string, GitHubHierarchyObservation>();
          let hierarchyGenerationComplete = true;
          try {
            const relationshipPages = connector.fetchTasks(undefined, {
              dependencyGeneration: generation,
              signal: this.dependencyRelationshipPollAbortController?.signal,
            });
            for await (const page of relationshipPages) {
              identityComparison?.markNetworkPage();
              for (const task of page) {
                const hierarchyObservation = readGitHubHierarchyObservation(task, config.id);
                if (hierarchyObservation.kind === 'incomplete') {
                  hierarchyGenerationComplete = false;
                  identityComparison?.markIneligible(hierarchyObservation.reasonCode);
                } else if (hierarchyObservation.kind === 'complete') {
                  if (!mergeGitHubHierarchyObservation(
                    hierarchyObservations,
                    hierarchyObservation.observation,
                  )) {
                    hierarchyGenerationComplete = false;
                    identityComparison?.markIneligible('sub_issue_observation_conflict');
                  }
                }
              }
            }
            const observationState = (
              connector as IConnector & {
                getIdentityObservationState?: () => Array<{
                  sourceId: string;
                  state: 'complete' | 'partial' | 'inaccessible';
                }>;
              }
            ).getIdentityObservationState?.() ?? [];
            const repositoryAliases = (
              connector as IConnector & {
                getHierarchyRepositoryAliases?: () => Array<{
                  sourceId: string;
                  canonicalSourceId: string;
                }>;
              }
            ).getHierarchyRepositoryAliases?.() ?? [];
            await reconcileGitHubTaskHierarchy(
              config.id,
              hierarchyObservations,
              new Set(observationState.map((state) => state.sourceId)),
              hierarchyGenerationComplete
                && observationState.length > 0
                && observationState.every((state) => state.state === 'complete'),
              new Map(repositoryAliases.map((alias) => [
                alias.sourceId,
                alias.canonicalSourceId,
              ])),
              { identityComparison },
            );
            const dependencyResult = await reconcileTaskDependencies(config.id, connector, {
              full: true,
              identityComparison,
            });
            if (dependencyResult.resumeSkippedReason === 'identity-context-changed') {
              identityComparison?.markIneligible('dependency_identity_context_changed');
              identityComparison?.complete(
                'cancelled',
                'dependency_identity_context_changed',
              );
            } else {
              identityComparison?.complete('succeeded');
            }
          } catch (error) {
            identityComparison?.complete(
              this.dependencyRelationshipPollAbortController?.signal.aborted
                ? 'cancelled'
                : 'failed',
              this.dependencyRelationshipPollAbortController?.signal.aborted
                ? 'dependency_poll_cancelled'
                : 'dependency_poll_failed',
            );
            throw error;
          }
        });
        syncLogger.info(
          { connectorId: config.id, trigger },
          'Dependency relationship poll collection completed',
        );
      } catch (error) {
        if (error instanceof ConnectorOperationBusyError) {
          syncLogger.info(
            { connectorId: config.id, trigger, reason: 'connector-busy' },
            'Dependency relationship poll deferred',
          );
        } else {
          syncLogger.warn(
            { err: error, connectorId: config.id, trigger },
            'Dependency relationship poll failed',
          );
        }
      }
    }
  }

  private getDependencyRelationshipPollIntervalMinutes(): number {
    const configured = Number(process.env.MC_GITHUB_DEPENDENCY_POLL_INTERVAL_MINUTES);
    return Number.isFinite(configured) && configured >= 1
      ? Math.min(Math.floor(configured), 30 * 24 * 60)
      : 24 * 60;
  }

  startDependencyRelationshipPolling(): void {
    if (this.dependencyRelationshipPollTimer) return;
    const pollIntervalMinutes = this.getDependencyRelationshipPollIntervalMinutes();
    const cadenceMinutes = Math.min(pollIntervalMinutes, 15);
    this.dependencyRelationshipPollEnabled = true;
    this.dependencyRelationshipPollAbortController = new AbortController();
    this.dependencyRelationshipPollTimer = setInterval(() => {
      void this.pollDueDependencyRelationships('recurring').catch((error) => {
        syncLogger.error({ err: error }, 'Dependency relationship poll scheduler failed');
      });
    }, cadenceMinutes * 60_000);
    this.dependencyRelationshipPollTimer.unref();
    void (async () => {
      await this.resumeDependencyReconciliations('startup');
      if (this.dependencyReconciliationResumeRun) {
        await this.dependencyReconciliationResumeRun;
      }
      if (this.dependencyRelationshipPollEnabled) {
        await this.pollDueDependencyRelationships('startup');
      }
    })().catch((error) => {
      syncLogger.warn({ err: error }, 'Initial dependency relationship poll failed');
    });
    syncLogger.info(
      { pollIntervalMinutes, cadenceMinutes },
      'Dependency relationship poll scheduler started',
    );
  }

  /**
   * Start a watchdog that periodically checks if scheduled jobs are still alive.
   */
  startWatchdog(): void {
    if (this.watchdogTimer) return;

    this.watchdogTimer = setInterval(async () => {
      try {
        const rows = await db.select().from(connectorConfigs)
          .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)));

        const pollConnectors = rows.filter(r => (r.syncMode || 'poll') === 'poll');

        if (!isDurableSyncMode() && pollConnectors.length > 0 && this.jobs.size === 0) {
          syncLogger.warn(
            { expected: pollConnectors.length, actual: this.jobs.size },
            'Watchdog: no cron jobs found, re-scheduling all connectors'
          );
          await this.scheduleAll();
        }

        for (const row of pollConnectors) {
          if (this.syncInProgress.has(row.id)) continue;

          const lastResult = this.lastSyncResults.get(row.id);
          // Skip connectors that haven't completed their first sync yet —
          // without a baseline timestamp, elapsed would be measured from epoch (1970),
          // producing a bogus multi-decade staleness value.
          if (!lastResult) continue;

          const lastSyncTime = new Date(lastResult.syncedAt).getTime();
          const elapsed = Date.now() - lastSyncTime;
          const expectedInterval = (row.pollIntervalMinutes ?? 5) * 60 * 1000;
          const threshold = Math.max(expectedInterval * 3, SyncScheduler.STALE_THRESHOLD_MS);

          if (elapsed > threshold) {
            syncLogger.warn(
              { connectorId: row.id, elapsedMs: elapsed, thresholdMs: threshold },
              'Watchdog: connector sync is stale, triggering immediate sync'
            );
            this.requestSync(row.id, { source: 'watchdog' }).catch((err) => {
              syncLogger.error({ err, connectorId: row.id }, 'Watchdog: triggered sync failed');
            });
          }
        }
      } catch (err) {
        syncLogger.error({ err }, 'Watchdog: check failed');
      }
    }, SyncScheduler.WATCHDOG_INTERVAL_MS);
  }

  private intervalToCron(minutes: number): string {
    if (minutes <= 1) return '* * * * *';
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.floor(minutes / 60);
    return `0 */${hours} * * *`;
  }
}

// Singleton
export const syncScheduler = new SyncScheduler();

// Auto-schedule all connectors from DB on first import (server-side only).
if (
  !isPublicDemoMode()
  && !isDurableSyncMode()
) {
  syncScheduler.scheduleAll().catch((err) => {
    syncLogger.error({ err }, 'Initial scheduleAll failed — instrumentation hook will retry');
  });

  // Schedule nightly full sync to catch transferred/deleted items.
  syncScheduler.startNightlyFullSync();
  syncScheduler.startDependencyReconciliationResume();
  syncScheduler.startDependencyRelationshipPolling();
}

// ─── Write-through logging ──────────────────────────────────────────────────

/**
 * Log a write-through operation to sync_log so it appears in sync history.
 * Called after immediate push-on-write (task create, subtask create, updates).
 */
export async function logWriteThrough(params: {
  connectorId: string;
  action: 'created' | 'updated' | 'subtask_created' | 'completed';
  taskId: string;
  taskTitle: string;
  taskSourceId: string;
}): Promise<void> {
  try {
    const now = new Date().toISOString();
    const details: SyncAuditEntry[] = [{
      action: 'pushed',
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      taskSourceId: params.taskSourceId,
      reason: `Write-through: ${params.action}`,
    }];

    await db.insert(syncLog).values({
      id: randomUUID(),
      connectorId: params.connectorId,
      success: true,
      tasksAdded: params.action === 'created' || params.action === 'subtask_created' ? 1 : 0,
      tasksUpdated: params.action === 'updated' ? 1 : 0,
      tasksRemoved: 0,
      tasksPushed: 1,
      localOnlyProtected: 0,
      notificationsAdded: 0,
      errors: [] as unknown as string,
      details: details as unknown as string,
      syncedAt: now,
      durationMs: 0,
    });
  } catch (err) {
    syncLogger.error({ err, ...params }, 'Failed to log write-through to sync_log');
  }
}
