import type { RuntimeTelemetryRecord } from './runtime';

export const HEALTH_SNAPSHOT_SCHEMA_VERSION = 1;

export type WorkerHealthSnapshotState = 'healthy' | 'stale' | 'missing' | 'worker-down';
export type HealthDatabaseSeverity = 'healthy' | 'degraded' | 'critical' | 'error';

export class HealthSnapshotDeferredError extends Error {
  constructor() {
    super('Health snapshot deferred because sync work became pending');
  }
}

export interface WorkerHealthSnapshotIdentity {
  schemaVersion: number;
  generatedAt: string;
  worker: {
    instanceId: string;
    revision: string;
  };
}

export function ensureHealthSnapshotCanRun(shouldDefer?: () => boolean): void {
  if (shouldDefer?.()) throw new HealthSnapshotDeferredError();
}

export function mergeHealthDatabaseSeverity(
  materialized: HealthDatabaseSeverity,
  web: Exclude<HealthDatabaseSeverity, 'error'>,
): HealthDatabaseSeverity {
  if (materialized === 'error') return 'error';
  if (materialized === 'critical' || web === 'critical') return 'critical';
  if (materialized === 'degraded' || web === 'degraded') return 'degraded';
  return 'healthy';
}

export function classifyWorkerHealthSnapshot(
  snapshot: WorkerHealthSnapshotIdentity | null,
  workerRuntime: RuntimeTelemetryRecord | undefined,
  options: {
    now?: number;
    snapshotStaleMs?: number;
    telemetryStaleMs?: number;
  } = {},
): { status: WorkerHealthSnapshotState; ageMs: number | null } {
  if (!snapshot) return { status: 'missing', ageMs: null };

  const now = options.now ?? Date.now();
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  const ageMs = Number.isFinite(generatedAt) ? Math.max(0, now - generatedAt) : null;
  const telemetryStaleMs = options.telemetryStaleMs ?? 30_000;
  const workerHeartbeatAt = workerRuntime
    ? new Date(workerRuntime.heartbeatAt).getTime()
    : Number.NaN;
  if (
    !workerRuntime
    || !Number.isFinite(workerHeartbeatAt)
    || now - workerHeartbeatAt > telemetryStaleMs
  ) {
    return { status: 'worker-down', ageMs };
  }

  const snapshotStaleMs = options.snapshotStaleMs ?? 150_000;
  if (
    snapshot.schemaVersion !== HEALTH_SNAPSHOT_SCHEMA_VERSION
    || ageMs === null
    || ageMs > snapshotStaleMs
    || snapshot.worker.instanceId !== workerRuntime.instanceId
  ) {
    return { status: 'stale', ageMs };
  }

  return { status: 'healthy', ageMs };
}
