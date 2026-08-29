import { describe, expect, it } from 'vitest';
import type { DatabaseTelemetrySnapshot } from '@/lib/telemetry/database';
import { formatRuntimePrometheusMetrics } from '@/lib/telemetry/prometheus';

function databaseSnapshot(): DatabaseTelemetrySnapshot {
  const aggregate = {
    count: 4,
    failureCount: 1,
    totalDurationMs: 600,
    maxDurationMs: 548,
    p50Ms: 2,
    p95Ms: 120,
    p99Ms: 548,
  };
  return {
    sampledAt: '2026-08-26T02:40:00.000Z',
    windowStartedAt: '2026-08-26T02:35:00.000Z',
    sampleInterval: {
      startedAt: '2026-08-26T02:39:50.000Z',
      operationCount: 4,
      synchronousDatabaseTimeMs: 600,
      contentionFailureCount: 1,
      busyTimeoutCount: 0,
    },
    operations: {
      total: aggregate,
      byCategory: { transaction: aggregate },
      byOperation: { TRANSACTION: aggregate },
    },
    contention: {
      writerAcquisitionCount: 2,
      writerAcquisitionDurationMs: 140,
      writerAcquisitionP95Ms: 110,
      writerAcquisitionP99Ms: 110,
      successfulWaitCount: 1,
      successfulWaitDurationMs: 110,
      busyFailureCount: 1,
      busyTimeoutCount: 0,
      lastBusyAt: '2026-08-26T02:39:00.000Z',
    },
    wal: {
      available: true,
      sizeBytes: 4_096,
      allocationState: 'pending',
      checkpointBusy: false,
      logFrames: 12,
      checkpointedFrames: 8,
      pendingFrames: 4,
      checkpointProbeDurationMs: 1,
      checkpointAgeMs: 2_000,
      checkpointAttemptedAt: '2026-08-26T02:39:58.000Z',
      starved: false,
      errorCode: null,
    },
    slowOperations: [{
      operation: 'TRANSACTION',
      category: 'transaction',
      durationMs: 548,
      failed: false,
      errorCode: null,
      observedAt: '2026-08-26T02:39:00.000Z',
    }],
    thresholds: {
      slowOperationMs: 100,
      latencyP95WarningMs: 100,
      latencyP99CriticalMs: 500,
      busyWaitWarningMs: 100,
      busyTimeoutMs: 5_000,
      walWarningBytes: 64 * 1024 * 1024,
      walCriticalBytes: 256 * 1024 * 1024,
      checkpointStarvationMs: 60_000,
      checkpointPendingFrames: 1_000,
      checkpointProbeIntervalMs: 60_000,
      observationWindowMs: 300_000,
    },
    severity: 'critical',
    reasons: ['SQLite transaction latency p99 is 548ms'],
  };
}

describe('Prometheus runtime metrics', () => {
  it('exports bounded SQLite and heartbeat gauges without diagnostic reason labels', () => {
    const metrics = formatRuntimePrometheusMetrics([{
      role: 'worker',
      heartbeatAt: '2026-08-26T02:39:50.000Z',
      metrics: { database: databaseSnapshot() },
    }], new Date('2026-08-26T02:40:00.000Z').getTime());

    expect(metrics).toContain(
      'mission_control_runtime_heartbeat_age_seconds{role="worker"} 10',
    );
    expect(metrics).toContain(
      'mission_control_sqlite_health_status{role="worker",status="critical"} 1',
    );
    expect(metrics).toContain(
      'mission_control_sqlite_operation_latency_milliseconds{role="worker",category="transaction",quantile="0.99"} 548',
    );
    expect(metrics).toContain(
      'mission_control_sqlite_busy_failures{role="worker"} 1',
    );
    expect(metrics).toContain(
      'mission_control_sqlite_wal_pending_frames{role="worker"} 4',
    );
    expect(metrics).toContain(
      'mission_control_sqlite_wal_available{role="worker"} 1',
    );
    expect(metrics).not.toContain('SQLite transaction latency');
  });

  it('omits unavailable WAL values and invalid heartbeat ages', () => {
    const database = databaseSnapshot();
    database.wal.available = false;
    database.wal.sizeBytes = null;
    database.wal.pendingFrames = null;
    database.wal.checkpointAgeMs = null;

    const metrics = formatRuntimePrometheusMetrics([{
      role: 'web',
      heartbeatAt: 'invalid',
      metrics: { database },
    }]);

    expect(metrics).not.toContain('mission_control_runtime_heartbeat_age_seconds{role="web"}');
    expect(metrics).not.toContain('mission_control_sqlite_wal_size_bytes{role="web"}');
    expect(metrics).not.toContain('mission_control_sqlite_wal_pending_frames{role="web"}');
    expect(metrics).not.toContain('mission_control_sqlite_wal_checkpoint_age_seconds{role="web"}');
    expect(metrics).not.toContain('mission_control_sqlite_wal_starved{role="web"}');
    expect(metrics).toContain('mission_control_sqlite_wal_available{role="web"} 0');
  });
});
