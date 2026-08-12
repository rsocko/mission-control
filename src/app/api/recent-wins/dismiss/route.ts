import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

const SNOOZE_KEY = 'recent-wins-snoozed';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    let value: unknown;
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
        await db.delete(appSettings).where(eq(appSettings.key, SNOOZE_KEY));
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SNOOZE_KEY));

    if (existing) {
      await db
        .update(appSettings)
        .set({ value, updatedAt: now })
        .where(eq(appSettings.key, SNOOZE_KEY));
    } else {
      await db.insert(appSettings).values({ key: SNOOZE_KEY, value, updatedAt: now });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to dismiss recent wins');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
