import { NextRequest, NextResponse } from 'next/server';
import db from '@/db';
import { sqlite, withoutDatabaseObservation } from '@/db';
import { connectorConfigs, syncLog } from '@/db/schema';
import { eq, isNull, sql } from 'drizzle-orm';
import { getProviderInfo, getResolvedAIConfig } from '@/lib/ai';
import logger from '@/lib/logger';
import {
  getDependencyReconciliationHealth,
  type DependencyReconciliationProgress,
} from '@/lib/sync/task-dependency-manager';
import {
  getSyncQueueMetrics,
  isDurableSyncMode,
  type SyncQueueMetrics,
} from '@/lib/sync/job-queue';
import {
  getRuntimeTelemetry,
  getRuntimeTelemetryAlertHistory,
  getRuntimeTelemetryInstances,
  type RuntimeTelemetryRecord,
} from '@/lib/telemetry/runtime';
import {
  getFreshDatabaseSeverity,
  getRuntimeDegradations,
  includeRuntimeHealthHistory,
} from '@/lib/telemetry/health';
import { getDisabledConnectorFeatures } from '@/lib/connectors/disabled-features';
import { getDependencyRelationshipDegradation } from '@/lib/sync/dependency-health';

/**
 * Health status for the app.
 * 
 * States per connector:
 * - "healthy" — enabled and last sync succeeded
 * - "degraded" — enabled but last sync had errors
 * - "error" — enabled but unreachable/broken
 * - "disabled" — explicitly disabled by user (NOT an error)
 * - "unconfigured" — not set up yet
 * 
 * Overall health:
 * - "healthy" — all enabled connectors working
 * - "attention" — at least one enabled connector has issues (degraded/error)
 * - "informational" — some features disabled but nothing broken
 */

export type ConnectorHealthStatus = 'healthy' | 'degraded' | 'error' | 'disabled' | 'unconfigured';
export type OverallHealthStatus = 'healthy' | 'attention' | 'informational';

interface ConnectorHealth {
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

interface HealthResponse {
  overall: OverallHealthStatus;
  message: string;
  uptime: number;
  version: string;
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

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const includeHistory = includeRuntimeHealthHistory(
    request.nextUrl.searchParams.get('detail'),
  );
  try {
    // ─── DB Connectivity Check ────────────────────────────────────────
    let dbHealth: HealthResponse['database'];
    try {
      const { result, pageCount, pageSize } = withoutDatabaseObservation(() => ({
        result: sqlite.prepare("SELECT 1 as ok").get() as { ok: number } | undefined,
        pageCount: sqlite.prepare("PRAGMA page_count").get() as
          | { page_count: number }
          | undefined,
        pageSize: sqlite.prepare("PRAGMA page_size").get() as
          | { page_size: number }
          | undefined,
      }));
      const sizeBytes = (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0);
      dbHealth = result?.ok === 1
        ? { status: 'healthy', message: 'Connected', sizeBytes }
        : { status: 'error', message: 'Query returned unexpected result' };
    } catch (dbErr) {
      dbHealth = { status: 'error', message: dbErr instanceof Error ? dbErr.message : 'Connection failed' };
    }

    const {
      configs,
      latestSyncPerConnector,
      latestSuccessfulSyncPerConnector,
      dependencyHealth,
      runtimeProcesses,
      syncQueue,
      runtimeHistory,
      runtimeInstances,
    } = await withoutDatabaseObservation(async () => {
      const configs = await db
        .select()
        .from(connectorConfigs)
        .where(isNull(connectorConfigs.deletedAt));
      // Get the most recent sync log per connector (not a flat LIMIT which can
      // miss connectors when others sync frequently).
      const latestSyncPerConnector = await db
        .select()
        .from(syncLog)
        .where(
          eq(
            syncLog.id,
            sql`(SELECT id FROM sync_log AS sl WHERE sl.connector_id = ${syncLog.connectorId} ORDER BY sl.synced_at DESC LIMIT 1)`
          )
        );
      const latestSuccessfulSyncPerConnector = await db
        .select({
          connectorId: syncLog.connectorId,
          syncedAt: sql<string>`max(${syncLog.syncedAt})`.as('synced_at'),
        })
        .from(syncLog)
        .where(eq(syncLog.success, true))
        .groupBy(syncLog.connectorId);
      const dependencyHealth = await getDependencyReconciliationHealth();
      return {
        configs,
        latestSyncPerConnector,
        latestSuccessfulSyncPerConnector,
        dependencyHealth,
        runtimeProcesses: getRuntimeTelemetry(),
        runtimeHistory: includeHistory ? getRuntimeTelemetryAlertHistory(1) : undefined,
        runtimeInstances: includeHistory ? getRuntimeTelemetryInstances(1) : undefined,
        syncQueue: getSyncQueueMetrics(),
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
    const degradations = getRuntimeDegradations(runtimeProcesses, syncQueue, {
      durableSyncMode: isDurableSyncMode(),
      telemetryStaleMs,
      history: runtimeHistory,
      instances: runtimeInstances,
    });
    if (dbHealth.status !== 'error') {
      const databaseSeverity = getFreshDatabaseSeverity(
        runtimeProcesses,
        Date.now(),
        telemetryStaleMs,
      );
      if (databaseSeverity === 'critical') {
        dbHealth.status = 'critical';
        dbHealth.message = 'Critical SQLite degradation detected';
      } else if (databaseSeverity === 'degraded') {
        dbHealth.status = 'degraded';
        dbHealth.message = 'SQLite degradation detected';
      }
    }

    const connectorHealths: ConnectorHealth[] = configs.map(config => {
      const dependencyReconciliation = dependencyHealth.get(config.id);
      if (!config.enabled) {
        return {
          id: config.id,
          type: config.type,
          name: config.name,
          status: 'disabled' as const,
          message: 'Disabled by user',
          dependencyReconciliation,
        };
      }

      // Find most recent sync log for this connector
      const lastSync = latestSyncPerConnector.find(l => l.connectorId === config.id);
      const lastSuccessfulSyncAt = latestSuccessfulSyncPerConnector
        .find(l => l.connectorId === config.id)?.syncedAt;
      const capabilities = typeof config.capabilities === 'string'
        ? JSON.parse(config.capabilities) as { dependencyRead?: boolean }
        : config.capabilities as { dependencyRead?: boolean } | null;
      const relationshipHealthApplies = config.type === 'github-issues'
        && capabilities?.dependencyRead !== false;
      const relationshipProblem = !relationshipHealthApplies
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
          status: relationshipProblem ? 'degraded' as const : 'healthy' as const,
          message: relationshipProblem ?? 'Enabled, awaiting first sync',
          lastSuccessfulSyncAt,
          dependencyReconciliation,
        };
      }

      if (lastSync.success) {
        return {
          id: config.id,
          type: config.type,
          name: config.name,
          status: relationshipProblem ? 'degraded' as const : 'healthy' as const,
          message: relationshipProblem ?? 'Last sync successful',
          lastSyncAt: lastSync.syncedAt,
          lastSyncSuccess: true,
          lastSuccessfulSyncAt,
          dependencyReconciliation,
        };
      }

      return {
        id: config.id,
        type: config.type,
        name: config.name,
        status: 'error' as const,
        message: 'Last sync failed',
        lastSyncAt: lastSync.syncedAt,
        lastSyncSuccess: false,
        lastSuccessfulSyncAt,
        dependencyReconciliation,
      };
    });

    // AI health
    const aiInfo = getProviderInfo();
    const aiConfigured = getResolvedAIConfig().configured;
    const aiHealth = aiConfigured
      ? { status: 'healthy' as const, provider: aiInfo.provider, model: aiInfo.model, message: 'Configured' }
      : { status: 'disabled' as const, message: 'No AI provider configured' };

    // Determine disabled features
    const disabledFeatures = getDisabledConnectorFeatures(configs);
    if (!aiConfigured) disabledFeatures.push('AI Assistant');

    // Overall status
    const enabledConnectors = connectorHealths.filter(c => c.status !== 'disabled' && c.status !== 'unconfigured');
    const hasErrors = enabledConnectors.some(c => c.status === 'error' || c.status === 'degraded');

    let overall: OverallHealthStatus;
    let message: string;

    if (hasErrors || degradations.length > 0) {
      overall = 'attention';
      const errorCount = enabledConnectors.filter(c => c.status === 'error' || c.status === 'degraded').length;
      message = errorCount > 0
        ? `${errorCount} connector${errorCount > 1 ? 's' : ''} need${errorCount === 1 ? 's' : ''} attention`
        : degradations[0];
    } else if (enabledConnectors.length === 0 && configs.length === 0) {
      overall = 'informational';
      message = 'No connectors configured yet';
    } else {
      overall = 'healthy';
      message = enabledConnectors.length > 0
        ? `All ${enabledConnectors.length} active connector${enabledConnectors.length > 1 ? 's' : ''} healthy`
        : 'No active connectors';
    }

    const response: HealthResponse = {
      overall,
      message,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '0.1.0',
      database: dbHealth,
      connectors: connectorHealths,
      ai: aiHealth,
      disabledFeatures,
      runtime: {
        processes: runtimeProcesses,
        syncQueue,
        degradations,
      },
    };

    logger.info({ overall, durationMs: Date.now() - startTime }, 'Health check completed');
    return NextResponse.json(response);
  } catch (error) {
    logger.error({ err: error }, 'Health check failed');
    return NextResponse.json({
      overall: 'attention',
      message: 'Failed to check health',
      uptime: process.uptime(),
      version: process.env.npm_package_version || '0.1.0',
      database: { status: 'error', message: 'Health check failed' },
      connectors: [],
      ai: { status: 'error', message: 'Health check failed' },
      disabledFeatures: [],
      runtime: {
        processes: [],
        syncQueue: {
          queued: 0,
          running: 0,
          retrying: 0,
          cancelled: 0,
          oldestQueuedAgeMs: 0,
          missedSchedules: 0,
          oldestScheduleOverdueMs: 0,
          overBudget: 0,
          expiredLeases: 0,
        },
        degradations: ['health telemetry unavailable'],
      },
    });
  }
}
