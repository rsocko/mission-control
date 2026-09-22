import { NextResponse } from 'next/server';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import logger from '@/lib/logger';

const SNOOZE_KEY = 'recent-wins-snoozed';

type SnoozeValue = {
  type: 'day' | 'until-noteworthy';
  until?: string;
  minCount?: number;
  snoozedAt?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    const settings = getCorePersistenceRepositories().settings;
    let value: SnoozeValue;
    const now = new Date().toISOString();

    switch (action) {
      case 'snooze-day': {
        const until = new Date();
        until.setDate(until.getDate() + 1);
        until.setHours(0, 0, 0, 0);
        value = { type: 'day', until: until.toISOString() };
        break;
      }
      case 'snooze-until-noteworthy': {
        // Will re-show when there are 5+ new completions after snooze
        value = { type: 'until-noteworthy', minCount: 5, snoozedAt: now };
        break;
      }
      case 'clear': {
        await settings.delete(SNOOZE_KEY);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // A single atomic key upsert replaces the previous read-then-write pair.
    await settings.set(SNOOZE_KEY, value);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to dismiss recent wins');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
