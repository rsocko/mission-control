import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import {
  pushNotificationScheduler,
  scheduledSummariesEnabled,
  SCHEDULED_SUMMARIES_SETTING_KEY,
} from '@/lib/push/scheduler';

function persistSchedulerState(enabled: boolean, now: string): void {
  db.insert(appSettings).values({
    key: SCHEDULED_SUMMARIES_SETTING_KEY,
    value: enabled,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: appSettings.key,
    set: { value: enabled, updatedAt: now },
  }).run();
}

/** GET /api/push/scheduler — Get scheduler status */
export async function GET() {
  return NextResponse.json({
    running: pushNotificationScheduler.isRunning(),
    enabled: scheduledSummariesEnabled(),
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
    const now = new Date().toISOString();

    switch (action) {
      case 'start':
        persistSchedulerState(true, now);
        await pushNotificationScheduler.start();
        break;
      case 'stop':
        persistSchedulerState(false, now);
        await pushNotificationScheduler.stop();
        break;
      case 'restart':
        persistSchedulerState(true, now);
        await pushNotificationScheduler.restart();
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
      enabled: scheduledSummariesEnabled(),
      jobs: pushNotificationScheduler.getStatus(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to control scheduler' }, { status: 500 });
  }
}
