import { NextResponse } from 'next/server';
import { getLocalToday } from '@/lib/utils/date';
import {
  createRoutineCompletion,
  deleteRoutineCompletionById,
  deleteRoutineCompletionsForDate,
  listRoutineCompletions,
} from '@/lib/routines/service';

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
    const completions = await listRoutineCompletions({
      fromInclusive: startDate,
      toInclusive: endDate,
      routineId: routineId || undefined,
      order: 'unspecified',
    });

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

    const id = `rc-${crypto.randomUUID().slice(0, 8)}`;
    const result = await createRoutineCompletion({
      id,
      routineId,
      date,
      notes: notes || null,
      completedAt: new Date().toISOString(),
    });
    if (result.outcome === 'routine-not-found') {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }
    if (result.outcome === 'duplicate') {
      return NextResponse.json({ error: 'Already completed for this day' }, { status: 409 });
    }

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
      await deleteRoutineCompletionById(id);
    } else if (routineId && date) {
      await deleteRoutineCompletionsForDate(routineId, date);
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
