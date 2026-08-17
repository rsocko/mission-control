import { describe, expect, it } from 'vitest';
import {
  HEALTH_SNAPSHOT_SCHEMA_VERSION,
  HealthSnapshotDeferredError,
  classifyWorkerHealthSnapshot,
  ensureHealthSnapshotCanRun,
  mergeHealthDatabaseSeverity,
} from '@/lib/telemetry/health-snapshot-status';
import type { RuntimeTelemetryRecord } from '@/lib/telemetry/runtime';

const now = new Date('2026-08-16T12:00:00.000Z').getTime();

function workerRuntime(heartbeatAt = '2026-08-16T11:59:50.000Z'): RuntimeTelemetryRecord {
  return {
    role: 'worker',
    instanceId: 'worker-1',
    pid: 1,
    startedAt: '2026-08-16T11:00:00.000Z',
    heartbeatAt,
    metrics: {} as RuntimeTelemetryRecord['metrics'],
  };
}

function snapshot(generatedAt = '2026-08-16T11:59:30.000Z') {
  return {
    schemaVersion: HEALTH_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    worker: { instanceId: 'worker-1', revision: 'revision-1' },
  };
}

describe('worker health snapshot status', () => {
  it('reports a fresh snapshot from the current worker as healthy', () => {
    expect(classifyWorkerHealthSnapshot(snapshot(), workerRuntime(), { now })).toEqual({
      status: 'healthy',
      ageMs: 30_000,
    });
  });

  it('reports an old snapshot as stale while the worker heartbeat is fresh', () => {
    expect(classifyWorkerHealthSnapshot(
      snapshot('2026-08-16T11:55:00.000Z'),
      workerRuntime(),
      { now, snapshotStaleMs: 120_000 },
    )).toEqual({ status: 'stale', ageMs: 300_000 });
  });

  it('reports a missing snapshot explicitly', () => {
    expect(classifyWorkerHealthSnapshot(null, workerRuntime(), { now })).toEqual({
      status: 'missing',
      ageMs: null,
    });
  });

  it('reports worker-down when the heartbeat is absent or stale', () => {
    expect(classifyWorkerHealthSnapshot(snapshot(), undefined, { now }).status).toBe('worker-down');
    expect(classifyWorkerHealthSnapshot(
      snapshot(),
      workerRuntime('2026-08-16T11:58:00.000Z'),
      { now, telemetryStaleMs: 30_000 },
    ).status).toBe('worker-down');
  });

  it('defers materialization as soon as sync work becomes pending', () => {
    expect(() => ensureHealthSnapshotCanRun(() => true))
      .toThrow(HealthSnapshotDeferredError);
    expect(() => ensureHealthSnapshotCanRun(() => false)).not.toThrow();
  });

  it('preserves the most severe database state across worker and web telemetry', () => {
    expect(mergeHealthDatabaseSeverity('healthy', 'critical')).toBe('critical');
    expect(mergeHealthDatabaseSeverity('critical', 'degraded')).toBe('critical');
    expect(mergeHealthDatabaseSeverity('error', 'healthy')).toBe('error');
  });
});
