import { NextResponse } from 'next/server';
import { sqlite, withoutDatabaseObservation } from '@/db';
import { isPublicDemoMode } from '@/lib/public-demo';
import { getRuntimeLifecycleSnapshot, isRuntimeReady } from '@/lib/runtime/lifecycle';
import { runtimeRelease } from '@/lib/runtime/release';

export async function GET() {
  try {
    const lifecycle = getRuntimeLifecycleSnapshot();
    const seeded = withoutDatabaseObservation(() => {
      sqlite.prepare('SELECT 1').get();
      return !isPublicDemoMode() || Boolean(
        sqlite.prepare("SELECT seeded_at FROM public_demo_runtime WHERE id = 'seed'").get(),
      );
    });
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
