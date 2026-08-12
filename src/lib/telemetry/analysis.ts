import type {
  RuntimeRole,
  RuntimeTelemetryInstance,
  RuntimeTelemetryRecord,
  RuntimeTelemetrySample,
} from './runtime';

export type RuntimeAlertCode =
  | 'memory-ceiling'
  | 'heap-growth'
  | 'external-pressure'
  | 'event-loop-lag'
  | 'repeated-restarts'
  | 'low-cgroup-headroom';

export interface RuntimeAlert {
  code: RuntimeAlertCode;
  severity: 'warning' | 'critical';
  role: RuntimeRole;
  instanceId: string;
  message: string;
}

export interface RuntimeRoleSummary {
  role: RuntimeRole;
  instanceId: string;
  sampledAt: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  intervalHighWaterRssBytes: number;
  postGcFloorBytes: number | null;
  rssGrowthBytesPerHour: number;
  postGcFloorGrowthBytesPerHour: number;
  cgroupHeadroomBytes: number | null;
  cgroupHeadroomPercent: number | null;
}

export interface RuntimeWorkloadCorrelation {
  operation: string;
  samples: number;
  peakRssBytes: number;
  peakExternalBytes: number;
}

function slopePerHour(
  samples: RuntimeTelemetrySample[],
  select: (sample: RuntimeTelemetrySample) => number,
): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedHours = (
    new Date(last.sampledAt).getTime() - new Date(first.sampledAt).getTime()
  ) / 3_600_000;
  if (elapsedHours <= 0) return 0;
  return Math.round((select(last) - select(first)) / elapsedHours);
}

function nullableSlopePerHour(
  samples: RuntimeTelemetrySample[],
  select: (sample: RuntimeTelemetrySample) => number | null,
): number {
  const observed = samples.filter((sample) => select(sample) !== null);
  return slopePerHour(observed, (sample) => select(sample) ?? 0);
}

export function summarizeRuntimeTelemetry(
  current: RuntimeTelemetryRecord[],
  history: RuntimeTelemetrySample[],
): RuntimeRoleSummary[] {
  return current.map((record) => {
    const samples = history.filter((sample) => sample.instanceId === record.instanceId);
    const { metrics } = record;
    const currentBytes = metrics.container.memoryCurrentBytes;
    const limitBytes = metrics.container.memoryLimitBytes;
    const headroom = currentBytes !== null && limitBytes !== null
      ? Math.max(0, limitBytes - currentBytes)
      : null;
    return {
      role: record.role,
      instanceId: record.instanceId,
      sampledAt: metrics.sampledAt,
      rssBytes: metrics.process.rssBytes,
      heapUsedBytes: metrics.process.heapUsedBytes,
      externalBytes: metrics.process.externalBytes,
      arrayBuffersBytes: metrics.process.arrayBuffersBytes,
      intervalHighWaterRssBytes: metrics.memory.intervalHighWater.rssBytes,
      postGcFloorBytes: metrics.memory.postGcFloor?.heapUsedBytes ?? null,
      rssGrowthBytesPerHour: slopePerHour(samples, (sample) => sample.metrics.process.rssBytes),
      postGcFloorGrowthBytesPerHour: nullableSlopePerHour(
        samples,
        (sample) => sample.metrics.memory.postGcFloor?.heapUsedBytes ?? null,
      ),
      cgroupHeadroomBytes: headroom,
      cgroupHeadroomPercent: headroom !== null && limitBytes
        ? Math.round(headroom / limitBytes * 10_000) / 100
        : null,
    };
  });
}

export function correlateRuntimeWorkloads(
  history: RuntimeTelemetrySample[],
): RuntimeWorkloadCorrelation[] {
  const correlations = new Map<string, RuntimeWorkloadCorrelation>();
  for (const sample of history) {
    const labels = new Set(
      sample.metrics.workload.active.map((operation) =>
        [
          operation.kind,
          operation.routeFamily,
          operation.connectorId,
          operation.phase,
        ].filter(Boolean).join(':')),
    );
    for (const operation of labels) {
      const current = correlations.get(operation) ?? {
        operation,
        samples: 0,
        peakRssBytes: 0,
        peakExternalBytes: 0,
      };
      current.samples++;
      current.peakRssBytes = Math.max(
        current.peakRssBytes,
        sample.metrics.memory.intervalHighWater.rssBytes,
      );
      current.peakExternalBytes = Math.max(
        current.peakExternalBytes,
        sample.metrics.memory.intervalHighWater.externalBytes,
      );
      correlations.set(operation, current);
    }
  }
  return [...correlations.values()]
    .sort((left, right) => right.peakRssBytes - left.peakRssBytes)
    .slice(0, 20);
}

export function getRuntimeAlerts(
  current: RuntimeTelemetryRecord[],
  history: RuntimeTelemetrySample[] = [],
  instances: RuntimeTelemetryInstance[] = [],
): RuntimeAlert[] {
  const alerts: RuntimeAlert[] = [];
  const absoluteCeiling = Number(process.env.MC_MEMORY_CEILING_BYTES) || 1.5 * 1024 ** 3;
  const externalCeiling = Number(process.env.MC_EXTERNAL_MEMORY_WARNING_BYTES)
    || 256 * 1024 ** 2;
  const floorGrowthCeiling = Number(process.env.MC_HEAP_FLOOR_GROWTH_BYTES_PER_HOUR)
    || 64 * 1024 ** 2;
  const summaries = summarizeRuntimeTelemetry(current, history);

  for (const record of current) {
    const metrics = record.metrics;
    const cgroupCeiling = metrics.container.memoryLimitBytes === null
      ? Number.POSITIVE_INFINITY
      : metrics.container.memoryLimitBytes * 0.9;
    if (metrics.memory.intervalHighWater.rssBytes >= Math.min(absoluteCeiling, cgroupCeiling)) {
      alerts.push({
        code: 'memory-ceiling',
        severity: 'critical',
        role: record.role,
        instanceId: record.instanceId,
        message: `${record.role} RSS reached its configured memory ceiling`,
      });
    }
    if (
      metrics.memory.intervalHighWater.externalBytes >= externalCeiling
      && metrics.memory.intervalHighWater.externalBytes
        / Math.max(1, metrics.memory.intervalHighWater.rssBytes) >= 0.25
    ) {
      alerts.push({
        code: 'external-pressure',
        severity: 'warning',
        role: record.role,
        instanceId: record.instanceId,
        message: `${record.role} external-memory pressure is elevated`,
      });
    }
    if (metrics.eventLoop.degraded) {
      alerts.push({
        code: 'event-loop-lag',
        severity: 'critical',
        role: record.role,
        instanceId: record.instanceId,
        message: `${record.role} event-loop lag is sustained`,
      });
    }
    const currentBytes = metrics.container.memoryCurrentBytes;
    const limitBytes = metrics.container.memoryLimitBytes;
    if (currentBytes !== null && limitBytes !== null && currentBytes / limitBytes >= 0.9) {
      alerts.push({
        code: 'low-cgroup-headroom',
        severity: 'critical',
        role: record.role,
        instanceId: record.instanceId,
        message: `${record.role} cgroup memory headroom is below 10%`,
      });
    }
  }

  for (const summary of summaries) {
    const instanceSamples = history.filter(
      (sample) => sample.instanceId === summary.instanceId
        && sample.metrics.memory.postGcFloor !== null,
    );
    const sampleSpanMs = instanceSamples.length < 2
      ? 0
      : new Date(instanceSamples[instanceSamples.length - 1].sampledAt).getTime()
        - new Date(instanceSamples[0].sampledAt).getTime();
    if (
      sampleSpanMs >= 30 * 60_000
      && summary.postGcFloorGrowthBytesPerHour >= floorGrowthCeiling
    ) {
      alerts.push({
        code: 'heap-growth',
        severity: 'warning',
        role: summary.role,
        instanceId: summary.instanceId,
        message: `${summary.role} post-GC heap floor is growing persistently`,
      });
    }
  }

  const recentRestartCutoff = Date.now() - 60 * 60_000;
  for (const role of ['web', 'worker'] as const) {
    const roleInstances = instances.filter(
      (instance) => instance.role === role
        && instance.stoppedAt !== null
        && new Date(instance.stoppedAt).getTime() >= recentRestartCutoff,
    );
    const currentRecord = current.find((record) => record.role === role);
    if (roleInstances.length >= 2 && currentRecord) {
      alerts.push({
        code: 'repeated-restarts',
        severity: 'critical',
        role,
        instanceId: currentRecord.instanceId,
        message: `${role} restarted ${roleInstances.length} times in the last hour`,
      });
    }
  }
  return alerts;
}
