import {
  getRuntimeTelemetry,
  getRuntimeTelemetryHistory,
  getRuntimeTelemetryInstances,
} from '@/lib/telemetry/runtime';
import {
  correlateRuntimeWorkloads,
  getRuntimeAlerts,
  summarizeRuntimeTelemetry,
} from '@/lib/telemetry/analysis';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestedHours = Number(new URL(request.url).searchParams.get('hours'));
  const hours = Number.isFinite(requestedHours)
    ? Math.min(72, Math.max(1, Math.floor(requestedHours)))
    : 72;
  const [current, history, instances] = await Promise.all([
    getRuntimeTelemetry(),
    getRuntimeTelemetryHistory(hours),
    getRuntimeTelemetryInstances(hours),
  ]);
  const series = history.map((sample) => ({
    sampledAt: sample.sampledAt,
    role: sample.role,
    instanceId: sample.instanceId,
    resolutionSeconds: sample.resolutionSeconds,
    rssBytes: sample.metrics.process.rssBytes,
    heapUsedBytes: sample.metrics.process.heapUsedBytes,
    externalBytes: sample.metrics.process.externalBytes,
    arrayBuffersBytes: sample.metrics.process.arrayBuffersBytes,
    highWaterRssBytes: sample.metrics.memory.intervalHighWater.rssBytes,
    highWaterExternalBytes: sample.metrics.memory.intervalHighWater.externalBytes,
    postGcFloorBytes: sample.metrics.memory.postGcFloor?.heapUsedBytes ?? null,
    eventLoopP99Ms: sample.metrics.eventLoop.p99Ms,
    cgroupCurrentBytes: sample.metrics.container.memoryCurrentBytes,
    cgroupLimitBytes: sample.metrics.container.memoryLimitBytes,
  }));

  return Response.json({
    sampledAt: new Date().toISOString(),
    retentionHours: 72,
    current,
    series,
    instances,
    summaries: summarizeRuntimeTelemetry(current, history),
    workloadCorrelations: correlateRuntimeWorkloads(history),
    alerts: getRuntimeAlerts(current, history, instances),
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
