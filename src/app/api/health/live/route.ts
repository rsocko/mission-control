import { NextResponse } from 'next/server';
import { performance } from 'node:perf_hooks';
import { publicRuntimeRelease } from '@/lib/runtime/release';
import { recordLivenessProbe } from '@/lib/telemetry/runtime';

export async function GET() {
  const startedAt = performance.now();
  const response = NextResponse.json({
    live: true,
    revision: publicRuntimeRelease(),
  });
  recordLivenessProbe(performance.now() - startedAt);
  return response;
}
