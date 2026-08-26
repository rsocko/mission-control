import { getRuntimeTelemetry } from '@/lib/telemetry/runtime';
import { formatCurrentRuntimePrometheusMetrics } from '@/lib/telemetry/prometheus';

export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(
    formatCurrentRuntimePrometheusMetrics(getRuntimeTelemetry()),
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
