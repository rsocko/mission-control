import { NextResponse } from 'next/server';
import {
  getRuntimeTelemetryHistory,
  type RuntimeRole,
} from '@/lib/telemetry/runtime';

const VALID_ROLES = new Set<RuntimeRole>(['web', 'worker']);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const roleValue = searchParams.get('role');
  if (roleValue && !VALID_ROLES.has(roleValue as RuntimeRole)) {
    return NextResponse.json({ error: 'role must be web or worker' }, { status: 400 });
  }

  const sinceValue = searchParams.get('since');
  if (sinceValue && Number.isNaN(Date.parse(sinceValue))) {
    return NextResponse.json({ error: 'since must be an ISO-8601 timestamp' }, { status: 400 });
  }
  const since = sinceValue ? new Date(sinceValue).toISOString() : undefined;

  const limitValue = searchParams.get('limit');
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)) {
    return NextResponse.json({ error: 'limit must be an integer from 1 to 10000' }, { status: 400 });
  }

  const samples = getRuntimeTelemetryHistory({
    role: roleValue as RuntimeRole | undefined,
    since,
    limit,
  });
  return NextResponse.json({
    samples,
    retention: {
      hours: 72,
      rawHours: 6,
      downsampleSeconds: 300,
    },
  });
}
