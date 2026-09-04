import {
  ConnectorWritebackError,
  type NotificationWritebackAction,
} from '@/lib/connectors/notification-writeback-contract';
import logger from '@/lib/logger';
import type { ConnectorConfig } from '@/types';
import type { ConnectorCapabilities } from '@/types';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { NotificationWebPersistence, WritebackClaimRow, NotificationMutationAction, NotificationMutationResult, NotificationMutationItemResult } from '@/db/persistence/notification-web';
export { MAX_NOTIFICATION_BULK_IDS, normalizeNotificationBulkIds } from './bulk';
export type { NotificationMutationAction, NotificationMutationResult, NotificationMutationItemResult };

const WRITEBACK_BATCH_SIZE = 50;
const WRITEBACK_LEASE_MS = 60_000;
const WRITEBACK_RETRY_BASE_MS = 5_000;
const WRITEBACK_MAX_RETRY_MS = 5 * 60_000;
const WRITEBACK_MIN_REQUEST_INTERVAL_MS = 100;
const WRITEBACK_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRACKED_SINGLE_JOB_CONNECTORS = 1_000;

type WritebackRow = WritebackClaimRow;

let dispatcherPromise: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const singleJobConnectorIds = new Set<string>();

let _web: NotificationWebPersistence | null = null;

async function resolveWeb(): Promise<NotificationWebPersistence> {
  if (_web) return _web;
  const repositories = await getWorkerPersistenceRepositories();
  _web = repositories.notificationDelivery.web;
  return _web;
}

function requireWeb(): NotificationWebPersistence {
  if (!_web) throw new Error('Notification web persistence not yet initialized; call resolveWeb() first');
  return _web;
}

export async function enqueueNotificationDismissalWritebacks(
  notificationIds: string[],
): Promise<number> {
  const web = await resolveWeb();
  const result = web.dismissNotificationsAndEnqueueWritebacks(notificationIds, new Date().toISOString());
  return result.queuedCount;
}

export function mutateNotificationsAndEnqueueWritebacks(
  notificationIds: string[],
  action: NotificationMutationAction,
  changedAt: string,
): NotificationMutationResult {
  return requireWeb().mutateNotificationsAndEnqueueWritebacks(notificationIds, action, changedAt);
}

export function dismissNotificationsAndEnqueueWritebacks(
  notificationIds: string[],
  dismissedAt: string,
): { updatedCount: number; queuedCount: number } {
  return requireWeb().dismissNotificationsAndEnqueueWritebacks(notificationIds, dismissedAt);
}

export function wakeNotificationWritebackDispatcher(): void {
  if (dispatcherPromise) return;
  dispatcherPromise = Promise.resolve()
    .then(dispatchNotificationWritebacks)
    .catch((error) => {
      logger.error({ err: error }, 'Notification writeback dispatcher failed');
    })
    .finally(() => {
      dispatcherPromise = null;
      scheduleNextWriteback();
    });
}

export async function dispatchNotificationWritebacks(): Promise<void> {
  const web = await resolveWeb();
  while (true) {
    const jobs = web.claimNextConnectorBatch({
      batchSize: WRITEBACK_BATCH_SIZE,
      leaseMs: WRITEBACK_LEASE_MS,
      singleJobConnectorIds,
    });
    if (jobs.length === 0) return;
    await processWritebackBatch(jobs);
  }
}

function normalizeWritebackSourceId(sourceId: string): string {
  const separator = sourceId.indexOf(':');
  const connectorSourceId = separator === -1 ? sourceId : sourceId.slice(separator + 1);
  return connectorSourceId.replace(/^docintel-/, '');
}

async function processWritebackBatch(jobs: WritebackRow[]): Promise<void> {
  const web = requireWeb();
  let connector: Awaited<ReturnType<typeof loadConnector>>;
  try {
    connector = await withWritebackTimeout(
      loadConnector(jobs[0]!.connectorInstanceId),
      'Connector initialization',
    );
  } catch (error) {
    failJobs(jobs, error);
    return;
  }
  jobs = web.renewWritebackLeases(jobs, WRITEBACK_LEASE_MS);
  if (jobs.length === 0) return;
  if (
    !connector?.writeNotificationAction
    && !connector?.dismissAlert
    && !connector?.dismissAlerts
  ) {
    failJobs(jobs, new ConnectorWritebackError(
      connector
        ? 'Connector does not support notification writeback'
        : 'Connector is unavailable or has been removed',
      false,
    ));
    return;
  }

  if (
    connector.dismissAlerts
    && jobs.every((job) => job.actionType === 'mark_done')
  ) {
    try {
      await withWritebackTimeout(
        connector.dismissAlerts(jobs.map((job) => job.sourceId)),
        'Notification dismissal batch',
      );
      web.completeWritebackJobs(jobs);
    } catch (error) {
      failJobs(jobs, error);
    }
    return;
  }

  rememberSingleJobConnector(jobs[0]!.connectorInstanceId);
  web.releaseUnattemptedWritebackJobs(jobs.slice(1));
  const job = jobs[0]!;
  try {
    if (connector.writeNotificationAction) {
      await withAbortableWritebackTimeout(
        (signal) => connector.writeNotificationAction!(job.sourceId, job.actionType, signal),
        `Notification ${job.actionType}`,
      );
    } else {
      await withWritebackTimeout(
        connector.dismissAlert!(job.sourceId),
        `Notification ${job.actionType}`,
      );
    }
    web.completeWritebackJobs([job]);
  } catch (error) {
    failJobs([job], error);
  }
  await new Promise((resolve) => setTimeout(resolve, WRITEBACK_MIN_REQUEST_INTERVAL_MS));
}

async function loadConnector(instanceId: string) {
  const { connectorRegistry, registerDefaultConnectorFactories } = await import('@/lib/connectors');
  const { CAPABILITY_DEFAULTS } = await import('@/lib/connectors/capabilities');
  registerDefaultConnectorFactories();
  const registered = connectorRegistry.getConnector(instanceId);
  if (registered) return registered;

  const repositories = await getWorkerPersistenceRepositories();
  const config = await repositories.connectors.get(instanceId);
  if (!config || config.deletedAt) return null;

  const storedCapabilities = parseRecord(config.capabilities);
  const capabilities = {
    ...(CAPABILITY_DEFAULTS[config.type] ?? {}),
    ...storedCapabilities,
  } as ConnectorCapabilities;
  return connectorRegistry.createConnector({
    id: config.id,
    type: config.type,
    name: config.name,
    enabled: !!config.enabled,
    syncMode: (config.syncMode as ConnectorConfig['syncMode']) || 'poll',
    capabilities,
    settings: parseRecord(config.settings),
    credentials: parseRecord(config.credentials) as Record<string, string>,
    syncedLists: parseStringArray(config.syncedLists),
  });
}

function failJobs(jobs: WritebackRow[], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = !(error instanceof ConnectorWritebackError) || error.retryable;
  const providerRetryAt = error instanceof ConnectorWritebackError
    ? error.retryAt
    : undefined;
  requireWeb().failWritebackJobs(
    jobs,
    { message, retryable, retryAt: providerRetryAt },
    WRITEBACK_MAX_RETRY_MS,
    WRITEBACK_RETRY_BASE_MS,
  );
  logger.warn(
    { err: error, connectorId: jobs[0]?.connectorInstanceId, jobCount: jobs.length },
    'Notification writeback batch failed',
  );
}

function scheduleNextWriteback(): void {
  if (retryTimer) clearTimeout(retryTimer);
  try {
    const next = requireWeb().getNextScheduledWriteback();
    if (!next) return;
    const delay = Math.max(0, Math.min(
      WRITEBACK_MAX_RETRY_MS,
      Date.parse(next.nextAttemptAt) - Date.now(),
    ));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      wakeNotificationWritebackDispatcher();
    }, delay);
    retryTimer.unref?.();
  } catch {
    // Web persistence not yet initialized; skip scheduling
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function parseStringArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return value as string[];
}

async function withWritebackTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${WRITEBACK_REQUEST_TIMEOUT_MS}ms`));
    }, WRITEBACK_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortableWritebackTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(
    new Error(`${label} timed out after ${WRITEBACK_REQUEST_TIMEOUT_MS}ms`),
  ), WRITEBACK_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function rememberSingleJobConnector(connectorInstanceId: string): void {
  if (
    !singleJobConnectorIds.has(connectorInstanceId)
    && singleJobConnectorIds.size >= MAX_TRACKED_SINGLE_JOB_CONNECTORS
  ) {
    const oldest = singleJobConnectorIds.values().next().value;
    if (oldest) singleJobConnectorIds.delete(oldest);
  }
  singleJobConnectorIds.add(connectorInstanceId);
}

/** @deprecated Dismissals are queued; use enqueueNotificationDismissalWritebacks. */
export async function writebackNotificationDismissals(notificationIds: string[]): Promise<number> {
  const queued = await enqueueNotificationDismissalWritebacks(notificationIds);
  if (queued > 0) wakeNotificationWritebackDispatcher();
  return queued;
}

/** @deprecated Dismissals are queued; use enqueueNotificationDismissalWritebacks. */
export const writebackAlertDismissals = writebackNotificationDismissals;
