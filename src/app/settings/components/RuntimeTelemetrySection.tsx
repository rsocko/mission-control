'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Activity, Cpu, HardDrive, RefreshCw } from 'lucide-react';
import type {
  RuntimeAlert,
  RuntimeRoleSummary,
  RuntimeWorkloadCorrelation,
} from '@/lib/telemetry/analysis';

interface RuntimeSeriesPoint {
  sampledAt: string;
  role: 'web' | 'worker';
  instanceId: string;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  highWaterRssBytes: number;
  postGcFloorBytes: number | null;
  eventLoopP99Ms: number;
}

interface TelemetryResponse {
  sampledAt: string;
  retentionHours: number;
  summaries: RuntimeRoleSummary[];
  series: RuntimeSeriesPoint[];
  workloadCorrelations: RuntimeWorkloadCorrelation[];
  alerts: RuntimeAlert[];
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function formatRate(bytes: number): string {
  return `${bytes >= 0 ? '+' : ''}${formatBytes(bytes)}/h`;
}

export function RuntimeTelemetrySection() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/telemetry/runtime?hours=72', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Telemetry request failed (${response.status})`);
        setData(await response.json() as TelemetryResponse);
        setError(null);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Telemetry request failed');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const chartData = useMemo(() => {
    if (!data) return [];
    const buckets = new Map<string, Record<string, string | number>>();
    for (const point of data.series) {
      const row = buckets.get(point.sampledAt) ?? { sampledAt: point.sampledAt };
      row[`${point.role}Rss`] = Math.round(point.rssBytes / 1024 / 1024);
      row[`${point.role}HighWater`] = Math.round(point.highWaterRssBytes / 1024 / 1024);
      if (point.postGcFloorBytes !== null) {
        row[`${point.role}HeapFloor`] = Math.round(point.postGcFloorBytes / 1024 / 1024);
      }
      buckets.set(point.sampledAt, row);
    }
    return [...buckets.values()].sort((left, right) =>
      String(left.sampledAt).localeCompare(String(right.sampledAt)));
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <h2 className="text-xl font-semibold text-[var(--text-primary)]">Runtime telemetry</h2>
        <div className="h-64 animate-pulse rounded-xl bg-[var(--surface-2)]" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300" role="alert">
        {error ?? 'Runtime telemetry is unavailable'}
      </div>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="runtime-telemetry-heading">
      <div>
        <h2 id="runtime-telemetry-heading" className="text-xl font-semibold text-[var(--text-primary)]">
          Runtime telemetry
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Current pressure, interval peaks, growth floors, and workload correlation across the last {data.retentionHours} hours.
        </p>
      </div>

      {data.alerts.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" role="alert">
          <div className="flex items-center gap-2 font-medium text-amber-300">
            <AlertTriangle size={17} />
            Runtime alerts
          </div>
          <ul className="mt-2 space-y-1 text-sm text-amber-100/80">
            {data.alerts.map((alert) => (
              <li key={`${alert.instanceId}-${alert.code}`}>{alert.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {data.summaries.map((summary) => (
          <article key={summary.instanceId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium capitalize text-[var(--text-primary)]">
                <Cpu size={16} className="text-blue-400" />
                {summary.role}
              </div>
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {summary.instanceId.slice(0, 8)}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-[var(--text-muted)]">RSS</dt><dd>{formatBytes(summary.rssBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">Interval peak</dt><dd>{formatBytes(summary.intervalHighWaterRssBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">Heap used</dt><dd>{formatBytes(summary.heapUsedBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">Post-GC floor</dt><dd>{formatBytes(summary.postGcFloorBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">External</dt><dd>{formatBytes(summary.externalBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">ArrayBuffers</dt><dd>{formatBytes(summary.arrayBuffersBytes)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">RSS slope</dt><dd>{formatRate(summary.rssGrowthBytesPerHour)}</dd></div>
              <div><dt className="text-[var(--text-muted)]">Headroom</dt><dd>{formatBytes(summary.cgroupHeadroomBytes)}</dd></div>
            </dl>
          </article>
        ))}
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
        <div className="mb-4 flex items-center gap-2 font-medium text-[var(--text-primary)]">
          <Activity size={16} className="text-emerald-400" />
          Memory history (MiB)
        </div>
        <div className="h-80" aria-label="Runtime memory history chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                dataKey="sampledAt"
                minTickGap={48}
                tickFormatter={(value: string) => new Date(value).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                })}
              />
              <YAxis width={56} />
              <Tooltip labelFormatter={(value) => new Date(String(value)).toLocaleString()} />
              <Legend />
              <Line type="monotone" dataKey="webRss" name="Web RSS" dot={false} stroke="#60a5fa" connectNulls />
              <Line type="monotone" dataKey="webHighWater" name="Web high-water" dot={false} stroke="#f59e0b" connectNulls />
              <Line type="monotone" dataKey="workerRss" name="Worker RSS" dot={false} stroke="#34d399" connectNulls />
              <Line type="monotone" dataKey="workerHighWater" name="Worker high-water" dot={false} stroke="#fb7185" connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
        <div className="mb-3 flex items-center gap-2 font-medium text-[var(--text-primary)]">
          <HardDrive size={16} className="text-violet-400" />
          Workload correlation
        </div>
        {data.workloadCorrelations.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No expensive operations overlapped retained samples.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[var(--text-muted)]">
                <tr><th className="pb-2">Operation</th><th className="pb-2">Samples</th><th className="pb-2">Peak RSS</th><th className="pb-2">Peak external</th></tr>
              </thead>
              <tbody>
                {data.workloadCorrelations.map((correlation) => (
                  <tr key={correlation.operation} className="border-t border-[var(--border)]">
                    <td className="py-2 font-mono text-xs">{correlation.operation}</td>
                    <td className="py-2">{correlation.samples}</td>
                    <td className="py-2">{formatBytes(correlation.peakRssBytes)}</td>
                    <td className="py-2">{formatBytes(correlation.peakExternalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <RefreshCw size={12} />
        Refreshes every 30 seconds. Raw samples are downsampled after six hours and removed after 72 hours.
      </p>
    </section>
  );
}
