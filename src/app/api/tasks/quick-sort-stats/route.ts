import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import db from '@/db';
import { quickSortLog } from '@/db/schema';
import { gte, sql } from 'drizzle-orm';

/**
 * GET /api/tasks/quick-sort-stats
 *
 * Returns Quick Sort activity stats for motivational feedback:
 * - thisWeek: total tasks triaged + breakdown by mode
 * - streak: consecutive days with at least one quick sort action
 */
export async function GET() {
  // Week boundary: Monday 00:00 local-ish (use ISO week start)
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysFromMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekStartIso = weekStart.toISOString();

  // Aggregate this-week counts by mode (exclude skipped)
  const weekRows = await db
    .select({
      mode: quickSortLog.mode,
      count: sql<number>`count(*)`.as('count'),
    })
    .from(quickSortLog)
    .where(gte(quickSortLog.triagedAt, weekStartIso))
    .groupBy(quickSortLog.mode);

  const byMode: Record<string, number> = {};
  let weekTotal = 0;
  for (const row of weekRows) {
    byMode[row.mode] = row.count;
    weekTotal += row.count;
  }

  // Streak: fetch distinct calendar dates (UTC) with at least one action,
  // ordered most-recent first, for up to 90 days.
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setUTCDate(now.getUTCDate() - 90);
  const ninetyDaysAgoIso = ninetyDaysAgo.toISOString();

  const dateRows = await db
    .selectDistinct({
      day: sql<string>`substr(${quickSortLog.triagedAt}, 1, 10)`.as('day'),
    })
    .from(quickSortLog)
    .where(gte(quickSortLog.triagedAt, ninetyDaysAgoIso))
    .orderBy(sql`substr(${quickSortLog.triagedAt}, 1, 10) DESC`);

  const todayStr = now.toISOString().slice(0, 10);
  let streak = 0;

  if (dateRows.length > 0) {
    // Check consecutive days ending today (or yesterday if today has no actions)
    const activeDays = new Set(dateRows.map((r) => r.day));
    const startDay = activeDays.has(todayStr) ? todayStr : (() => {
      const yesterday = new Date(now);
      yesterday.setUTCDate(now.getUTCDate() - 1);
      return yesterday.toISOString().slice(0, 10);
    })();

    if (activeDays.has(startDay)) {
      streak = 1;
      const cursor = new Date(`${startDay}T00:00:00Z`);
      while (true) {
        cursor.setUTCDate(cursor.getUTCDate() - 1);
        const prevDay = cursor.toISOString().slice(0, 10);
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
