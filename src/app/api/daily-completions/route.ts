import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import logger from '@/lib/logger';
import { getLocalDayBoundsISO } from '@/lib/utils/date';
import { timestampGte, timestampLt } from '@/lib/utils/sqlite-date';

export async function GET() {
  try {
    // Get today's date boundaries in the configured local timezone
    const { todayStart, tomorrowStart } = getLocalDayBoundsISO();

    const [result] = await db.select({
      count: sql<number>`count(*)`,
    }).from(tasks).where(
      and(
        eq(tasks.status, 'done'),
        timestampGte(tasks.completedAt, todayStart),
        timestampLt(tasks.completedAt, tomorrowStart),
      )
    );

    return NextResponse.json({ count: Number(result?.count || 0) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch daily completions');
    return NextResponse.json({ count: 0 });
  }
}
