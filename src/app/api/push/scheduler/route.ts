import { NextResponse } from 'next/server';
import {
  pushNotificationScheduler,
  scheduledSummariesEnabled,
} from '@/lib/push/scheduler';

/** GET /api/push/scheduler — Get scheduler status */
export async function GET() {
  return NextResponse.json({
    running: pushNotificationScheduler.isRunning(),
    enabled: await scheduledSummariesEnabled(),
    jobs: pushNotificationScheduler.getStatus(),
  });
}

/**
 * POST /api/push/scheduler — Control the scheduler
 * Body: { action: 'start' | 'stop' | 'restart' }
 *
 * 'restart' re-reads preferences so schedule changes take effect immediately.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = body.action;
    switch (action) {
      case 'start':
        await pushNotificationScheduler.startAndPersist();
        break;
      case 'stop':
        await pushNotificationScheduler.stopAndPersist();
        break;
      case 'restart':
        await pushNotificationScheduler.restartAndPersist();
        break;
      default:
        return NextResponse.json(
          { error: 'action must be start|stop|restart' },
          { status: 400 },
        );
    }

    return NextResponse.json({
      status: action === 'stop' ? 'stopped' : 'running',
      running: pushNotificationScheduler.isRunning(),
      enabled: await scheduledSummariesEnabled(),
      jobs: pushNotificationScheduler.getStatus(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to control scheduler' }, { status: 500 });
  }
}
