import { NextResponse } from 'next/server';
import db from '@/db';
import { routines, routineCompletions } from '@/db/schema';
import { eq, and, gte, lte, desc, asc } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { calculateStreak, getIntervalStatus, getWeeklyProgress } from '@/lib/routines/streaks';
import type { CadenceConfig } from '@/lib/routines/streaks';
import { ApiErrors } from '@/lib/api-error';

/** Format a Date as YYYY-MM-DD in local time (avoids UTC rollover). */
function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDateLocal(d);
}

function getWeekSunday(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return formatDateLocal(d);
}

/**
 * GET /api/routines — List all active routines with streak + weekly completions
 * Query params:
 *   ?date=YYYY-MM-DD (optional, defaults to today — used for streak calculations)
 *   ?weekOf=YYYY-MM-DD (optional, defaults to date — which week's completions to return)
 *   ?includeArchived=true (optional)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get('date');
  const weekOfParam = searchParams.get('weekOf');
  if ((dateParam && !DATE_RE.test(dateParam)) || (weekOfParam && !DATE_RE.test(weekOfParam))) {
    return ApiErrors.badRequest('Invalid date format. Use YYYY-MM-DD.');
  }
  const today = dateParam || getLocalToday();
  const weekOfDate = weekOfParam || today;
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const weekMonday = getWeekMonday(weekOfDate);
  const weekSunday = getWeekSunday(weekMonday);

  try {
    // Fetch routines
    const allRoutines = await db.select()
      .from(routines)
      .where(includeArchived ? undefined : eq(routines.isArchived, false))
      .orderBy(asc(routines.sortOrder), asc(routines.createdAt));

    // Fetch all completions for the current week
    const weekCompletions = await db.select()
      .from(routineCompletions)
      .where(and(
        gte(routineCompletions.date, weekMonday),
        lte(routineCompletions.date, weekSunday),
      ))
      .orderBy(asc(routineCompletions.date));

    // Fetch last 365 days of completions for streak calculation
    const streakStartDate = new Date(today + 'T12:00:00');
    streakStartDate.setDate(streakStartDate.getDate() - 365);
    const streakStartStr = formatDateLocal(streakStartDate);

    const allCompletions = await db.select()
      .from(routineCompletions)
      .where(gte(routineCompletions.date, streakStartStr))
      .orderBy(desc(routineCompletions.date));

    // Build response
    const result = allRoutines.map(routine => {
      const config = (routine.cadenceConfig || {}) as CadenceConfig;
      const routineWeekCompletions = weekCompletions.filter(c => c.routineId === routine.id);
      const routineAllCompletions = allCompletions.filter(c => c.routineId === routine.id);

      const streak = calculateStreak(routine.cadenceType, config, routineAllCompletions, today);

      // Compute cadence-specific data
      let intervalStatus = null;
      let weeklyProgress = null;

      if (['every_n_days', 'weekly', 'monthly', 'quarterly'].includes(routine.cadenceType)) {
        const lastCompletion = routineAllCompletions.length > 0 ? routineAllCompletions[0].date : null;
        intervalStatus = getIntervalStatus(routine.cadenceType, config, lastCompletion, today);
      }

      if (routine.cadenceType === 'x_per_week') {
        weeklyProgress = getWeeklyProgress(config, routineWeekCompletions);
      }

      return {
        ...routine,
        streak,
        weekCompletions: routineWeekCompletions.map(c => ({ date: c.date, id: c.id })),
        intervalStatus,
        weeklyProgress,
      };
    });

    return NextResponse.json({
      date: today,
      weekMonday,
      weekSunday,
      routines: result,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch routines' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/routines — Create a new routine
 * Body: { name, cadenceType, cadenceConfig?, description?, icon? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, cadenceType, cadenceConfig, description, icon } = body;

    if (!name || !cadenceType) {
      return ApiErrors.badRequest('name and cadenceType are required');
    }

    const validCadences = ['daily', 'specific_days', 'x_per_week', 'every_n_days', 'weekly', 'monthly', 'quarterly'];
    if (!validCadences.includes(cadenceType)) {
      return ApiErrors.badRequest(`Invalid cadenceType. Must be one of: ${validCadences.join(', ')}`);
    }

    const id = `routine-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Get next sort order
    const existing = await db.select({ sortOrder: routines.sortOrder })
      .from(routines)
      .orderBy(desc(routines.sortOrder));
    const nextOrder = existing.length > 0 ? (existing[0].sortOrder || 0) + 1 : 0;

    await db.insert(routines).values({
      id,
      name,
      cadenceType,
      cadenceConfig: cadenceConfig || {},
      description: description || null,
      icon: icon || null,
      sortOrder: nextOrder,
      isActive: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to create routine' },
      { status: 500 },
    );
  }
}
