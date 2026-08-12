import { NextResponse } from 'next/server';
import db from '@/db';
import { smartScoreSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

export async function GET() {
  try {
    const rows = db.select().from(smartScoreSettings).all();
    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return NextResponse.json({ settings });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch smart score settings');
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { key, value } = body;

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'key and value are required' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const existing = db.select().from(smartScoreSettings).where(eq(smartScoreSettings.key, key)).get();

    if (existing) {
      db.update(smartScoreSettings)
        .set({ value: String(value), updatedAt: now })
        .where(eq(smartScoreSettings.key, key))
        .run();
    } else {
      db.insert(smartScoreSettings).values({
        key,
        value: String(value),
        updatedAt: now,
      }).run();
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update smart score setting');
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 });
  }
}
