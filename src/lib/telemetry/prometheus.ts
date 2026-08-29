import type { DatabaseTelemetrySnapshot } from './database';
import type { RuntimeRole, RuntimeTelemetryRecord } from './runtime';

type PrometheusDatabaseSnapshot = Pick<
  DatabaseTelemetrySnapshot,
  'contention' | 'operations' | 'severity' | 'slowOperations' | 'thresholds' | 'wal'
>;

interface PrometheusRuntimeRecord {
  role: RuntimeRole;
  heartbeatAt: string;
  metrics: {
    database?: PrometheusDatabaseSnapshot;
  };
}

interface MetricDefinition {
  name: string;
  help: string;
  type: 'gauge';
}

const definitions: MetricDefinition[] = [
  {
    name: 'mission_control_runtime_heartbeat_age_seconds',
    help: 'Age of the latest persisted runtime heartbeat.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_health_status',
    help: 'Current SQLite health status as a one-hot gauge.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_operation_latency_milliseconds',
    help: 'Rolling SQLite operation latency percentile by category.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_operation_samples',
    help: 'SQLite operation samples retained in the rolling observation window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_operation_failures',
    help: 'Failed SQLite operation samples retained in the rolling observation window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_slow_operations',
    help: 'Slow SQLite operations retained in the rolling observation window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_writer_acquisition_latency_milliseconds',
    help: 'Rolling SQLite writer-lock acquisition latency percentile.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_writer_lock_waits',
    help: 'Successful SQLite writer-lock waits above the warning threshold in the rolling window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_busy_failures',
    help: 'SQLite busy or locked failures retained in the rolling observation window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_busy_timeouts',
    help: 'SQLite busy timeouts retained in the rolling observation window.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_wal_available',
    help: 'Whether SQLite write-ahead log telemetry is currently available.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_wal_size_bytes',
    help: 'Current SQLite write-ahead log allocation in bytes.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_wal_pending_frames',
    help: 'Current SQLite write-ahead log frames awaiting checkpoint.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_wal_checkpoint_age_seconds',
    help: 'Age of the last complete SQLite write-ahead log checkpoint.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_wal_starved',
    help: 'Whether SQLite write-ahead log checkpoint progress is starved.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_latency_threshold_milliseconds',
    help: 'Configured SQLite latency alert threshold.',
    type: 'gauge',
  },
  {
    name: 'mission_control_sqlite_observation_window_seconds',
    help: 'Configured rolling SQLite telemetry observation window.',
    type: 'gauge',
  },
];

function labels(values: Record<string, string>): string {
  const serialized = Object.entries(values)
    .map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',');
  return `{${serialized}}`;
}

function sample(
  lines: string[],
  name: string,
  value: number,
  labelValues: Record<string, string>,
): void {
  if (!Number.isFinite(value)) return;
  lines.push(`${name}${labels(labelValues)} ${value}`);
}

function operationSamples(
  lines: string[],
  role: RuntimeRole,
  database: PrometheusDatabaseSnapshot,
): void {
  const aggregates = {
    overall: database.operations.total,
    ...database.operations.byCategory,
  };
  for (const [category, aggregate] of Object.entries(aggregates)) {
    if (!aggregate) continue;
    const baseLabels = { role, category };
    sample(lines, 'mission_control_sqlite_operation_samples', aggregate.count, baseLabels);
    sample(lines, 'mission_control_sqlite_operation_failures', aggregate.failureCount, baseLabels);
    for (const [quantile, value] of [
      ['0.5', aggregate.p50Ms],
      ['0.95', aggregate.p95Ms],
      ['0.99', aggregate.p99Ms],
    ] as const) {
      sample(
        lines,
        'mission_control_sqlite_operation_latency_milliseconds',
        value,
        { ...baseLabels, quantile },
      );
    }
  }
}

export function formatRuntimePrometheusMetrics(
  records: readonly PrometheusRuntimeRecord[],
  now = Date.now(),
): string {
  const lines = definitions.flatMap(({ name, help, type }) => [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
  ]);

  for (const record of records) {
    const roleLabels = { role: record.role };
    const heartbeatAgeSeconds = Math.max(
      0,
      (now - new Date(record.heartbeatAt).getTime()) / 1_000,
    );
    sample(
      lines,
      'mission_control_runtime_heartbeat_age_seconds',
      heartbeatAgeSeconds,
      roleLabels,
    );

    const database = record.metrics.database;
    if (!database) continue;
    for (const status of ['healthy', 'degraded', 'critical'] as const) {
      sample(
        lines,
        'mission_control_sqlite_health_status',
        database.severity === status ? 1 : 0,
        { ...roleLabels, status },
      );
    }
    operationSamples(lines, record.role, database);
    sample(
      lines,
      'mission_control_sqlite_slow_operations',
      database.slowOperations.length,
      roleLabels,
    );
    for (const [quantile, value] of [
      ['0.95', database.contention.writerAcquisitionP95Ms],
      ['0.99', database.contention.writerAcquisitionP99Ms],
    ] as const) {
      sample(
        lines,
        'mission_control_sqlite_writer_acquisition_latency_milliseconds',
        value,
        { ...roleLabels, quantile },
      );
    }
    sample(
      lines,
      'mission_control_sqlite_writer_lock_waits',
      database.contention.successfulWaitCount,
      roleLabels,
    );
    sample(
      lines,
      'mission_control_sqlite_busy_failures',
      database.contention.busyFailureCount,
      roleLabels,
    );
    sample(
      lines,
      'mission_control_sqlite_busy_timeouts',
      database.contention.busyTimeoutCount,
      roleLabels,
    );
    sample(
      lines,
      'mission_control_sqlite_wal_available',
      database.wal.available ? 1 : 0,
      roleLabels,
    );
    if (database.wal.available && database.wal.sizeBytes !== null) {
      sample(lines, 'mission_control_sqlite_wal_size_bytes', database.wal.sizeBytes, roleLabels);
    }
    if (database.wal.available && database.wal.pendingFrames !== null) {
      sample(
        lines,
        'mission_control_sqlite_wal_pending_frames',
        database.wal.pendingFrames,
        roleLabels,
      );
    }
    if (database.wal.available && database.wal.checkpointAgeMs !== null) {
      sample(
        lines,
        'mission_control_sqlite_wal_checkpoint_age_seconds',
        database.wal.checkpointAgeMs / 1_000,
        roleLabels,
      );
    }
    if (database.wal.available) {
      sample(
        lines,
        'mission_control_sqlite_wal_starved',
        database.wal.starved ? 1 : 0,
        roleLabels,
      );
    }
    sample(
      lines,
      'mission_control_sqlite_latency_threshold_milliseconds',
      database.thresholds.latencyP95WarningMs,
      { ...roleLabels, quantile: '0.95', severity: 'warning' },
    );
    sample(
      lines,
      'mission_control_sqlite_latency_threshold_milliseconds',
      database.thresholds.latencyP99CriticalMs,
      { ...roleLabels, quantile: '0.99', severity: 'critical' },
    );
    sample(
      lines,
      'mission_control_sqlite_observation_window_seconds',
      database.thresholds.observationWindowMs / 1_000,
      roleLabels,
    );
  }

  return `${lines.join('\n')}\n`;
}

export function formatCurrentRuntimePrometheusMetrics(
  records: readonly RuntimeTelemetryRecord[],
  now = Date.now(),
): string {
  return formatRuntimePrometheusMetrics(records, now);
}
