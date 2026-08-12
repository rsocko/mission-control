import { NextResponse } from 'next/server';
import { triggerMorningNotification, triggerTriageNudge, triggerCarryForwardReminder } from '@/lib/push/triggers';

/**
 * Cron-style endpoint to trigger push notifications.
 * Call with ?type=morning|triage|carryforward
 *
 * In production, this would be invoked by a scheduler (Vercel cron, external cron, etc.)
 * Protected by a simple bearer token check.
 */
export async function POST(request: Request) {
  // Require CRON_SECRET to be configured — deny all requests if missing
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'Push trigger not configured (CRON_SECRET missing)' }, { status: 503 });
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  try {
    let sent = false;
    switch (type) {
      case 'morning':
        sent = await triggerMorningNotification();
        break;
      case 'triage':
        sent = await triggerTriageNudge();
        break;
      case 'carryforward':
        sent = await triggerCarryForwardReminder();
        break;
      default:
        return NextResponse.json({ error: 'type must be morning|triage|carryforward' }, { status: 400 });
    }

    return NextResponse.json({ type, sent });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to trigger notification' }, { status: 500 });
  }
}
