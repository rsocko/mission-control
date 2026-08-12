import { NextResponse } from 'next/server';
import db from '@/db';
import { routineCompletions, routines } from '@/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/routines/completions — Get completions for a date range
 * Query params:
 *   ?routineId=xxx (optional, filter by routine)
 *   ?startDate=YYYY-MM-DD (optional, defaults to 28 days ago)
 *   ?endDate=YYYY-MM-DD (optional, defaults to today)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const routineId = searchParams.get('routineId');
  const today = getLocalToday();
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');
  if ((startDateParam && !DATE_RE.test(startDateParam)) || (endDateParam && !DATE_RE.test(endDateParam))) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
  }
  const endDate = endDateParam || today;

  const defaultStart = new Date(today + 'T12:00:00');
  defaultStart.setDate(defaultStart.getDate() - 28);
  const startDate = startDateParam || `${defaultStart.getFullYear()}-${String(defaultStart.getMonth() + 1).padStart(2, '0')}-${String(defaultStart.getDate()).padStart(2, '0')}`;

  try {
    const conditions = [
      gte(routineCompletions.date, startDate),
      lte(routineCompletions.date, endDate),
    ];
    if (routineId) {
      conditions.push(eq(routineCompletions.routineId, routineId));
    }

    const completions = await db.select()
      .from(routineCompletions)
      .where(and(...conditions));

    return NextResponse.json({ completions, startDate, endDate });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch completions' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/routines/completions — Log a completion
 * Body: { routineId, date?, notes? }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { routineId, notes } = body;
    const date = body.date || getLocalToday();

    if (!routineId) {
      return NextResponse.json({ error: 'routineId is required' }, { status: 400 });
    }
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
    }

    // Verify routine exists
    const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    if (!routine) {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }

    // For daily/specific_days, check for duplicate on same day
    if (['daily', 'specific_days'].includes(routine.cadenceType)) {
      const existing = await db.select()
        .from(routineCompletions)
        .where(and(
          eq(routineCompletions.routineId, routineId),
          eq(routineCompletions.date, date),
        ));
      if (existing.length > 0) {
        return NextResponse.json({ error: 'Already completed for this day' }, { status: 409 });
      }
    }

    const id = `rc-${crypto.randomUUID().slice(0, 8)}`;

    await db.insert(routineCompletions).values({
      id,
      routineId,
      date,
      notes: notes || null,
      completedAt: new Date().toISOString(),
    });

    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to log completion' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/routines/completions — Remove a completion (undo)
 * Query params: ?id=rc-xxx  OR  ?routineId=xxx&date=YYYY-MM-DD
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const routineId = searchParams.get('routineId');
  const date = searchParams.get('date');

  if (date && !DATE_RE.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
  }

  try {
    if (id) {
      await db.delete(routineCompletions).where(eq(routineCompletions.id, id));
    } else if (routineId && date) {
      await db.delete(routineCompletions).where(
        and(eq(routineCompletions.routineId, routineId), eq(routineCompletions.date, date)),
      );
    } else {
      return NextResponse.json({ error: 'id or (routineId + date) required' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to remove completion' },
      { status: 500 },
    );
  }
}
