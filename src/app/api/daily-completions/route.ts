import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks } from '@/db/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import logger from '@/lib/logger';
import { getLocalDayBoundsISO } from '@/lib/utils/date';

export async function GET() {
  try {
    // Get today's date boundaries in the configured local timezone
    const { todayStart, tomorrowStart } = getLocalDayBoundsISO();

    const [result] = await db.select({
      count: sql<number>`count(*)`,
    }).from(tasks).where(
      and(
        eq(tasks.status, 'done'),
        gte(tasks.completedAt, todayStart),
        lt(tasks.completedAt, tomorrowStart),
      )
    );

    return NextResponse.json({ count: Number(result?.count || 0) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch daily completions');
    return NextResponse.json({ count: 0 });
  }
}
