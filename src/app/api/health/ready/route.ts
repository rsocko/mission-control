import { NextResponse } from 'next/server';
import { isPublicDemoMode } from '@/lib/public-demo';
import { getRuntimeLifecycleSnapshot, isRuntimeReady } from '@/lib/runtime/lifecycle';
import { runtimeRelease } from '@/lib/runtime/release';
import { databaseHealthProbe } from '@/lib/telemetry/database-health-runtime';

export async function GET() {
  try {
    const lifecycle = getRuntimeLifecycleSnapshot();
    const database = await databaseHealthProbe.inspect();
    const seeded = database.connected
      && (!isPublicDemoMode() || await databaseHealthProbe.hasSeedMarker());
    const ready = seeded && isRuntimeReady();
    return NextResponse.json(
      {
        ready,
        mode: isPublicDemoMode() ? 'public-demo' : 'standard',
        revision: runtimeRelease,
        lifecycle,
      },
      { status: ready ? 200 : 503 },
    );
  } catch {
    return NextResponse.json(
      {
        ready: false,
        mode: isPublicDemoMode() ? 'public-demo' : 'standard',
        revision: runtimeRelease,
      },
      { status: 503 },
    );
  }
}
