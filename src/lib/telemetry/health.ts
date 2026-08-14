import type { SyncQueueMetrics } from '@/lib/sync/job-queue';
import type {
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from './runtime';
import type { DatabaseTelemetrySeverity } from './database';
import { getRuntimeAlerts } from './analysis';

export function includeRuntimeHealthHistory(detail: string | null): boolean {
  return detail !== 'summary';
}

export function getFreshDatabaseSeverity(
  processes: RuntimeTelemetryRecord[],
  now: number,
  telemetryStaleMs: number,
): DatabaseTelemetrySeverity {
  const severities = processes
    .filter(
      (runtime) => now - new Date(runtime.heartbeatAt).getTime() <= telemetryStaleMs,
    )
    .map((runtime) => runtime.metrics.database?.severity);
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('degraded')) return 'degraded';
  return 'healthy';
}

export function getRuntimeDegradations(
  processes: RuntimeTelemetryRecord[],
  syncQueue: SyncQueueMetrics,
  options: {
    durableSyncMode: boolean;
    now?: number;
    telemetryStaleMs?: number;
    history?: RuntimeTelemetrySample[];
    instances?: RuntimeTelemetryInstance[];
  },
): string[] {
  const degradations: string[] = [];
  const now = options.now ?? Date.now();
  const telemetryStaleMs = options.telemetryStaleMs ?? 30_000;

  for (const runtime of processes) {
    const telemetryIsStale = now - new Date(runtime.heartbeatAt).getTime() > telemetryStaleMs;
    if (runtime.metrics.eventLoop.degraded) {
      degradations.push(`${runtime.role} event-loop lag is sustained`);
    }
    if (runtime.metrics.container.memoryPressure === 'critical') {
      degradations.push(`critical: ${runtime.role} container memory pressure is critical`);
    } else if (runtime.metrics.container.memoryPressure === 'warning') {
      degradations.push(`${runtime.role} container memory pressure is elevated`);
    }
    if (!telemetryIsStale) {
      for (const reason of runtime.metrics.database?.reasons ?? []) {
        const prefix = runtime.metrics.database?.severity === 'critical' ? 'critical: ' : '';
        degradations.push(`${prefix}${runtime.role} ${reason}`);
      }
    }
    if (runtime.metrics.liveness?.startupProbeMissed) {
      degradations.push('liveness health check missed its startup deadline');
    }
    if (telemetryIsStale) {
      degradations.push(`${runtime.role} telemetry heartbeat is stale`);
    }
  }
  if (options.durableSyncMode && !processes.some((runtime) => runtime.role === 'worker')) {
    degradations.push('sync worker has not reported telemetry');
  }
  if (syncQueue.missedSchedules > 0) {
    degradations.push(
      `${syncQueue.missedSchedules} connector schedule${syncQueue.missedSchedules === 1 ? ' is' : 's are'} overdue`,
    );
  }
  if (syncQueue.overBudget > 0) {
    degradations.push(`${syncQueue.overBudget} sync job(s) exceeded their duration budget`);
  }
  if (syncQueue.expiredLeases > 0) {
    degradations.push(
      `action required: ${syncQueue.expiredLeases} sync job lease(s) expired`,
    );
  }
  const freshProcesses = processes.filter(
    (runtime) => now - new Date(runtime.heartbeatAt).getTime() <= telemetryStaleMs,
  );
  for (const alert of getRuntimeAlerts(
    freshProcesses,
    options.history,
    options.instances,
  )) {
    if (!degradations.includes(alert.message)) degradations.push(alert.message);
  }
  return degradations;
}
