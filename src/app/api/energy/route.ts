import { NextResponse } from 'next/server';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';

async function energyRepository() {
  const { dailyPlanning } = await getWorkerPersistenceRepositories();
  if (!dailyPlanning) throw new Error('Daily planning persistence is unavailable');
  return dailyPlanning.energy;
}

/**
 * GET /api/energy — Get today's energy check-in (if any)
 * Query params: ?date=YYYY-MM-DD (optional, defaults to today)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();

  const checkin = await (await energyRepository()).getForDate(date);

  return NextResponse.json({ checkin });
}

/**
 * POST /api/energy — Save energy check-in for today
 * Body: { level: 'high' | 'medium' | 'low', note?: string, date?: string }
 */
export async function POST(request: Request) {
  const body = await request.json();
  const { level, note } = body;

  if (!level || !['high', 'medium', 'low'].includes(level)) {
    return ApiErrors.badRequest('level must be high, medium, or low');
  }

  const date = body.date || getLocalToday();
  const now = new Date().toISOString();

  // Atomic date-keyed replace: at most one check-in survives per date.
  await (await energyRepository()).replaceForDate({
    id: `energy-${date}-${Date.now()}`,
    date,
    level,
    note: note || null,
    createdAt: now,
  });

  return NextResponse.json({ success: true, date, level });
}
