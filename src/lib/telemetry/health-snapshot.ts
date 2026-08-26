import { performance } from 'node:perf_hooks';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import db, { withoutDatabaseObservation } from '@/db';
import { connectorConfigs, syncLog } from '@/db/schema';
import { resolveDatabaseBackend } from '@/db/runtime-backend';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import { getProviderInfo } from '@/lib/ai/provider-factory';
import { getDisabledConnectorFeatures } from '@/lib/connectors/disabled-features';
import logger from '@/lib/logger';
import { getDependencyRelationshipDegradation } from '@/lib/sync/dependency-health';
import {
  getSyncJobRepository,
  type SyncQueueMetrics,
} from '@/lib/sync/job-queue';
import {
  getDependencyReconciliationHealth,
  type DependencyReconciliationProgress,
} from '@/lib/sync/task-dependency-manager';
import { publicRuntimeRelease } from '@/lib/runtime/release';
import {
  getRuntimeTelemetry,
  type RuntimeTelemetryRecord,
} from './runtime';
import {
  getFreshDatabaseSeverity,
  getRuntimeDegradations,
} from './health';
import {
  HEALTH_SNAPSHOT_SCHEMA_VERSION,
  HealthSnapshotDeferredError,
  ensureHealthSnapshotCanRun,
  type WorkerHealthSnapshotIdentity,
} from './health-snapshot-status';
import {
  createHealthSnapshotStore,
  databaseHealthProbe,
} from './database-health-runtime';

export type ConnectorHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'error'
  | 'disabled'
  | 'unconfigured';
export type OverallHealthStatus = 'healthy' | 'attention' | 'informational';

export interface ConnectorHealth {
  id: string;
  type: string;
  name: string;
  status: ConnectorHealthStatus;
  message: string;
  lastSyncAt?: string;
  lastSyncSuccess?: boolean;
  lastSuccessfulSyncAt?: string;
  dependencyReconciliation?: DependencyReconciliationProgress;
}

export interface MaterializedHealthSummary {
  overall: OverallHealthStatus;
  message: string;
  database: {
    status: 'healthy' | 'degraded' | 'critical' | 'error';
    message: string;
    sizeBytes?: number;
  };
  connectors: ConnectorHealth[];
  ai: {
    status: 'healthy' | 'disabled' | 'error';
    provider?: string;
    model?: string;
    message: string;
  };
  disabledFeatures: string[];
  runtime: {
    processes: RuntimeTelemetryRecord[];
    syncQueue: SyncQueueMetrics;
    degradations: string[];
  };
}

export interface WorkerHealthSnapshot extends WorkerHealthSnapshotIdentity {
  generationDurationMs: number;
  summary: MaterializedHealthSummary;
}

const MAX_CONNECTORS = 1_000;
const healthSnapshotStore = createHealthSnapshotStore<MaterializedHealthSummary>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function buildMaterializedHealthSummary(
  shouldDefer?: () => boolean,
): Promise<MaterializedHealthSummary> {
  let database: MaterializedHealthSummary['database'];
  try {
    const result = await databaseHealthProbe.inspect();
    database = result.connected
      ? {
          status: result.severity,
          message: result.message,
          sizeBytes: result.sizeBytes,
        }
      : { status: result.severity, message: result.message };
  } catch (error) {
    database = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Connection failed',
    };
  }

  const {
    configs,
    latestSyncPerConnector,
    latestSuccessfulSyncPerConnector,
    dependencyHealth,
    workerProcesses,
    syncQueue,
  } = await withoutDatabaseObservation(async () => {
    if (resolveDatabaseBackend() === 'postgres') {
      const [{ getPostgresPersistenceBackend }, { collectPostgresHealthSnapshotData }] = await Promise.all([
        import('@/db/runtime'),
        import('@/db/postgres/health-snapshot-data'),
      ]);
      const {
        configs,
        latestSyncPerConnector,
        latestSuccessfulSyncPerConnector,
        dependencyHealth,
      } = await collectPostgresHealthSnapshotData(
        getPostgresPersistenceBackend().context.db,
        { maxConnectors: MAX_CONNECTORS, shouldDefer },
      );
      return {
        configs,
        latestSyncPerConnector,
        latestSuccessfulSyncPerConnector,
        dependencyHealth,
        workerProcesses: (await getRuntimeTelemetry()).filter((runtime) => runtime.role === 'worker'),
        syncQueue: await (await getSyncJobRepository()).getMetrics(),
      };
    }

    const configs = await db
      .select()
      .from(connectorConfigs)
      .where(isNull(connectorConfigs.deletedAt))
      .limit(MAX_CONNECTORS + 1);
    if (configs.length > MAX_CONNECTORS) {
      throw new Error(`Health snapshot connector limit of ${MAX_CONNECTORS} exceeded`);
    }
    ensureHealthSnapshotCanRun(shouldDefer);
    const connectorIds = configs.map((config) => config.id);
    let latestSyncPerConnector: Array<typeof syncLog.$inferSelect> = [];
    let latestSuccessfulSyncPerConnector: Array<{
      connectorId: string;
      syncedAt: string;
    }> = [];
    let dependencyHealth = new Map<string, DependencyReconciliationProgress>();
    if (connectorIds.length > 0) {
      latestSyncPerConnector = await db
        .select()
        .from(syncLog)
        .where(and(
          inArray(syncLog.connectorId, connectorIds),
          eq(
            syncLog.id,
            sql`(SELECT id FROM sync_log AS sl WHERE sl.connector_id = ${syncLog.connectorId} ORDER BY sl.synced_at DESC LIMIT 1)`,
          ),
        ));
      ensureHealthSnapshotCanRun(shouldDefer);
      latestSuccessfulSyncPerConnector = await db
        .select({
          connectorId: syncLog.connectorId,
          syncedAt: sql<string>`max(${syncLog.syncedAt})`.as('synced_at'),
        })
        .from(syncLog)
        .where(and(
          inArray(syncLog.connectorId, connectorIds),
          eq(syncLog.success, true),
        ))
        .groupBy(syncLog.connectorId);
      ensureHealthSnapshotCanRun(shouldDefer);
      dependencyHealth = await getDependencyReconciliationHealth(connectorIds, shouldDefer);
      ensureHealthSnapshotCanRun(shouldDefer);
    }
    return {
      configs,
      latestSyncPerConnector,
      latestSuccessfulSyncPerConnector,
      dependencyHealth,
      workerProcesses: (await getRuntimeTelemetry()).filter((runtime) => runtime.role === 'worker'),
      syncQueue: await (await getSyncJobRepository()).getMetrics(),
    };
  });

  const telemetryStaleMs = Math.max(
    30_000,
    Number(process.env.MC_TELEMETRY_STALE_MS) || 30_000,
  );
  const relationshipPollMinutes = Math.max(
    1,
    Number(process.env.MC_GITHUB_DEPENDENCY_POLL_INTERVAL_MINUTES) || 24 * 60,
  );
  const relationshipStaleMinutes = Math.max(
    relationshipPollMinutes,
    Number(process.env.MC_GITHUB_DEPENDENCY_STALE_MINUTES) || relationshipPollMinutes * 2,
  );
  const degradations = getRuntimeDegradations(workerProcesses, syncQueue, {
    durableSyncMode: true,
    telemetryStaleMs,
  });
  if (database.status !== 'error') {
    const severity = getFreshDatabaseSeverity(workerProcesses, Date.now(), telemetryStaleMs);
    if (severity === 'critical') {
      database = { ...database, status: 'critical', message: 'Critical database degradation detected' };
    } else if (severity === 'degraded') {
      database = { ...database, status: 'degraded', message: 'Database degradation detected' };
    }
  }

  const connectors: ConnectorHealth[] = configs.map((config) => {
    const dependencyReconciliation = dependencyHealth.get(config.id);
    if (!config.enabled) {
      return {
        id: config.id,
        type: config.type,
        name: config.name,
        status: 'disabled',
        message: 'Disabled by user',
        dependencyReconciliation,
      };
    }
    const lastSync = latestSyncPerConnector.find((entry) => entry.connectorId === config.id);
    const lastSuccessfulSyncAt = latestSuccessfulSyncPerConnector
      .find((entry) => entry.connectorId === config.id)?.syncedAt;
    const capabilities = typeof config.capabilities === 'string'
      ? JSON.parse(config.capabilities) as { dependencyRead?: boolean }
      : config.capabilities as { dependencyRead?: boolean } | null;
    const relationshipProblem = config.type !== 'github-issues'
      || capabilities?.dependencyRead === false
      ? null
      : getDependencyRelationshipDegradation(
          dependencyReconciliation,
          relationshipStaleMinutes * 60_000,
        );
    if (!lastSync) {
      return {
        id: config.id,
        type: config.type,
        name: config.name,
        status: relationshipProblem ? 'degraded' : 'healthy',
        message: relationshipProblem ?? 'Enabled, awaiting first sync',
        lastSuccessfulSyncAt,
        dependencyReconciliation,
      };
    }
    return {
      id: config.id,
      type: config.type,
      name: config.name,
      status: lastSync.success && !relationshipProblem ? 'healthy' : lastSync.success ? 'degraded' : 'error',
      message: !lastSync.success ? 'Last sync failed' : relationshipProblem ?? 'Last sync successful',
      lastSyncAt: lastSync.syncedAt,
      lastSyncSuccess: lastSync.success,
      lastSuccessfulSyncAt,
      dependencyReconciliation,
    };
  });

  const aiInfo = getProviderInfo();
  const aiConfigured = getResolvedAIConfig().configured;
  const ai = aiConfigured
    ? {
        status: 'healthy' as const,
        provider: aiInfo.provider,
        model: aiInfo.model,
        message: 'Configured',
      }
    : { status: 'disabled' as const, message: 'No AI provider configured' };
  const disabledFeatures = getDisabledConnectorFeatures(configs);
  if (!aiConfigured) disabledFeatures.push('AI Assistant');
  const enabledConnectors = connectors.filter(
    (connector) => connector.status !== 'disabled' && connector.status !== 'unconfigured',
  );
  const connectorErrors = enabledConnectors.filter(
    (connector) => connector.status === 'error' || connector.status === 'degraded',
  ).length;
  const overall = connectorErrors > 0 || degradations.length > 0
    ? 'attention'
    : enabledConnectors.length === 0 && configs.length === 0
      ? 'informational'
      : 'healthy';
  const message = connectorErrors > 0
    ? `${connectorErrors} connector sync${connectorErrors > 1 ? 's' : ''} need${connectorErrors === 1 ? 's' : ''} attention`
    : degradations[0]
      ?? (configs.length === 0
        ? 'No connectors configured yet'
        : enabledConnectors.length > 0
          ? `All ${enabledConnectors.length} active connector sync${enabledConnectors.length > 1 ? 's' : ''} healthy`
          : 'No active connectors');

  return {
    overall,
    message,
    database,
    connectors,
    ai,
    disabledFeatures,
    runtime: { processes: workerProcesses, syncQueue, degradations },
  };
}

export async function generateWorkerHealthSnapshot(
  workerInstanceId: string,
  shouldDefer?: () => boolean,
): Promise<WorkerHealthSnapshot> {
  const startedAt = performance.now();
  const summary = await buildMaterializedHealthSummary(shouldDefer);
  const snapshot: WorkerHealthSnapshot = {
    schemaVersion: HEALTH_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    worker: {
      instanceId: workerInstanceId,
      revision: publicRuntimeRelease(),
    },
    generationDurationMs: Math.round(performance.now() - startedAt),
    summary,
  };
  await healthSnapshotStore.write(
    snapshot,
    () => ensureHealthSnapshotCanRun(shouldDefer),
  );
  return snapshot;
}

export async function readWorkerHealthSnapshot(): Promise<WorkerHealthSnapshot | null> {
  return healthSnapshotStore.read();
}

export class WorkerHealthSnapshotScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private readonly workerInstanceId: string,
    private readonly isSyncActive: () => boolean,
    private readonly intervalMs = positiveInteger(
      process.env.MC_HEALTH_SNAPSHOT_INTERVAL_MS,
      60_000,
    ),
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    this.schedule(0);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.stopping) return;
    if (this.isSyncActive()) {
      this.schedule(Math.min(this.intervalMs, 5_000));
      return;
    }
    let nextDelayMs = this.intervalMs;
    try {
      const snapshot = await generateWorkerHealthSnapshot(
        this.workerInstanceId,
        this.isSyncActive,
      );
      logger.info(
        {
          generationDurationMs: snapshot.generationDurationMs,
          generatedAt: snapshot.generatedAt,
        },
        'Worker health snapshot materialized',
      );
    } catch (error) {
      if (error instanceof HealthSnapshotDeferredError) {
        nextDelayMs = Math.min(this.intervalMs, 5_000);
        logger.debug('Worker health snapshot deferred for pending sync work');
      } else {
        logger.error({ err: error }, 'Worker health snapshot generation failed');
      }
    } finally {
      if (!this.stopping) this.schedule(nextDelayMs);
    }
  }
}
