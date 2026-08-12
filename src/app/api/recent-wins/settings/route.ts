import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

const SETTINGS_KEY = 'recent-wins-deprioritized-lists';

export async function GET() {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY));

    return NextResponse.json({
      deprioritizedLists: row ? (row.value as string[]) : [],
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch recent wins settings');
    return NextResponse.json({ deprioritizedLists: [] });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { deprioritizedLists } = body as { deprioritizedLists: string[] };

    if (!Array.isArray(deprioritizedLists)) {
      return NextResponse.json({ error: 'deprioritizedLists must be an array' }, { status: 400 });
    }

    // Prevent abuse: limit count and string lengths
    if (deprioritizedLists.length > 100) {
      return NextResponse.json({ error: 'Too many entries (max 100)' }, { status: 400 });
    }
    if (deprioritizedLists.some((s) => typeof s !== 'string' || s.length > 200)) {
      return NextResponse.json({ error: 'Invalid entry: must be strings under 200 chars' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const [existing] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY));

    if (existing) {
      await db
        .update(appSettings)
        .set({ value: deprioritizedLists, updatedAt: now })
        .where(eq(appSettings.key, SETTINGS_KEY));
    } else {
      await db.insert(appSettings).values({
        key: SETTINGS_KEY,
        value: deprioritizedLists,
        updatedAt: now,
      });
    }

    return NextResponse.json({ ok: true, deprioritizedLists });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update recent wins settings');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
