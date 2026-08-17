import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import db from '@/db';
import { quickSortLog } from '@/db/schema';
import { and, gte, isNull, ne, sql } from 'drizzle-orm';
import {
  formatDateInLocalTimezone,
  getLocalDateBoundsISO,
  getLocalToday,
} from '@/lib/utils/date';

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function getWeekMonday(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  const day = value.getUTCDay();
  return shiftDate(date, day === 0 ? -6 : 1 - day);
}

/**
 * GET /api/tasks/quick-sort-stats
 *
 * Returns Quick Sort activity stats for motivational feedback:
 * - thisWeek: total tasks triaged + breakdown by mode
 * - streak: consecutive days with at least one quick sort action
 */
export async function GET() {
  const today = getLocalToday();
  const weekStartDate = getWeekMonday(today);
  const { dayStart: weekStartIso } = getLocalDateBoundsISO(weekStartDate);

  // Aggregate this-week counts by mode (exclude skipped)
  const weekRows = await db
    .select({
      mode: quickSortLog.mode,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(quickSortLog)
    .where(and(
      gte(quickSortLog.triagedAt, weekStartIso),
      isNull(quickSortLog.reversedAt),
      ne(quickSortLog.action, 'skipped'),
    ))
    .groupBy(quickSortLog.mode);

  const byMode: Record<string, number> = {};
  let weekTotal = 0;
  for (const row of weekRows) {
    byMode[row.mode] = row.count;
    weekTotal += row.count;
  }

  // Streak: fetch recent timestamps, then bucket them in the configured timezone.
  const ninetyDaysAgo = shiftDate(today, -90);
  const { dayStart: ninetyDaysAgoIso } = getLocalDateBoundsISO(ninetyDaysAgo);

  const dateRows = await db
    .select({
      triagedAt: quickSortLog.triagedAt,
    })
    .from(quickSortLog)
    .where(and(
      gte(quickSortLog.triagedAt, ninetyDaysAgoIso),
      isNull(quickSortLog.reversedAt),
      ne(quickSortLog.action, 'skipped'),
    ));

  let streak = 0;

  if (dateRows.length > 0) {
    // Check consecutive days ending today (or yesterday if today has no actions)
    const activeDays = new Set(dateRows.map((row) => (
      formatDateInLocalTimezone(new Date(row.triagedAt))
    )));
    const startDay = activeDays.has(today) ? today : shiftDate(today, -1);

    if (activeDays.has(startDay)) {
      streak = 1;
      let cursor = startDay;
      while (true) {
        cursor = shiftDate(cursor, -1);
        const prevDay = cursor;
        if (activeDays.has(prevDay)) {
          streak++;
        } else {
          break;
        }
      }
    }
  }

  return NextResponse.json({
    thisWeek: {
      total: weekTotal,
      byMode: {
        no_priority: byMode['no_priority'] ?? 0,
        no_effort: byMode['no_effort'] ?? 0,
        no_tags: byMode['no_tags'] ?? 0,
        no_due_date: byMode['no_due_date'] ?? 0,
      },
    },
    streak,
  });
}

/**
 * POST /api/tasks/quick-sort-stats
 *
 * Body: { taskId: string; mode: string; action: string }
 * Logs a single quick sort action for stats tracking.
 */
export async function POST(request: Request) {
  let body: { taskId?: string; mode?: string; action?: string };
  try {
    body = (await request.json()) as { taskId?: string; mode?: string; action?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { taskId, mode, action } = body;
  if (!taskId || !mode || !action) {
    return NextResponse.json({ error: 'taskId, mode, and action are required' }, { status: 400 });
  }

  const validModes = ['no_priority', 'no_effort', 'no_tags', 'no_due_date'];
  const validActions = ['applied', 'suggestion_accepted', 'skipped'];
  if (!validModes.includes(mode) || !validActions.includes(action)) {
    return NextResponse.json({ error: 'Invalid mode or action' }, { status: 400 });
  }

  await db.insert(quickSortLog).values({
    id: randomUUID(),
    taskId,
    mode,
    action,
    triagedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
