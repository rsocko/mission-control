import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import { energyCheckins } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/energy — Get today's energy check-in (if any)
 * Query params: ?date=YYYY-MM-DD (optional, defaults to today)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();

  const checkins = await db.select()
    .from(energyCheckins)
    .where(eq(energyCheckins.date, date))
    .limit(1);

  return NextResponse.json({ checkin: checkins[0] || null });
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

  // Atomic upsert: delete + insert in a single transaction
  runTransaction((tx) => {
    tx.delete(energyCheckins).where(eq(energyCheckins.date, date)).run();
    tx.insert(energyCheckins).values({
      id: `energy-${date}-${Date.now()}`,
      date,
      level,
      note: note || null,
      createdAt: now,
    }).run();
  });

  return NextResponse.json({ success: true, date, level });
}
