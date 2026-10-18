import { NextResponse } from 'next/server';
import { getLocalToday } from '@/lib/utils/date';
import {
  createRoutineSkip,
  deleteRoutineSkipForDate,
} from '@/lib/routines/service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }
    const routineId = typeof body.routineId === 'string' ? body.routineId.trim() : '';
    const date = body.date || getLocalToday();

    if (!routineId) {
      return NextResponse.json({ error: 'routineId is required' }, { status: 400 });
    }
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
    }

    const result = await createRoutineSkip({
      id: `rs-${crypto.randomUUID().slice(0, 8)}`,
      routineId,
      date,
      skippedAt: new Date().toISOString(),
    });

    if (result.outcome === 'routine-not-found') {
      return NextResponse.json({ error: 'Routine not found' }, { status: 404 });
    }
    if (result.outcome === 'already-completed') {
      return NextResponse.json({ error: 'Completed routines cannot be skipped' }, { status: 409 });
    }
    if (result.outcome === 'duplicate') {
      return NextResponse.json({ error: 'Routine already skipped for this day' }, { status: 409 });
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Failed to skip routine' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const routineId = searchParams.get('routineId');
  const date = searchParams.get('date');

  if (!routineId || !date) {
    return NextResponse.json({ error: 'routineId and date are required' }, { status: 400 });
  }
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
  }

  try {
    await deleteRoutineSkipForDate(routineId, date);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed to restore routine' }, { status: 500 });
  }
}
