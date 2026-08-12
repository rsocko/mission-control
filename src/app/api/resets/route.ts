import { NextResponse } from 'next/server';
import db from '@/db';
import { resets } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/resets — List resets or get a specific one
 * Query params:
 *   ?type=weekly|monthly (optional, filter by type)
 *   ?periodStart=YYYY-MM-DD (optional, get specific period)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const periodStart = searchParams.get('periodStart');

  try {
    if (type && periodStart) {
      // Get specific reset
      const result = await db.select()
        .from(resets)
        .where(and(eq(resets.type, type), eq(resets.periodStart, periodStart)))
        .limit(1);
      return NextResponse.json({ reset: result[0] || null });
    }

    // List recent resets
    const conditions = type ? eq(resets.type, type) : undefined;
    const result = await db.select()
      .from(resets)
      .where(conditions)
      .orderBy(desc(resets.periodStart))
      .limit(20);

    return NextResponse.json({ resets: result });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch resets' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/resets — Create or update a reset (upsert by type + periodStart)
 * Body: { type, periodStart, periodEnd, wentWell?, needsAdjustment?, ... }
 */
export async function POST(request: Request) {
  const body = await request.json();
  const { type, periodStart, periodEnd } = body;

  if (!type || !periodStart || !periodEnd) {
    return NextResponse.json(
      { error: 'type, periodStart, and periodEnd are required' },
      { status: 400 },
    );
  }

  if (!['weekly', 'monthly'].includes(type)) {
    return NextResponse.json(
      { error: 'type must be weekly or monthly' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();

  try {
    // Check if a reset already exists for this period
    const existing = await db.select({ id: resets.id })
      .from(resets)
      .where(and(eq(resets.type, type), eq(resets.periodStart, periodStart)))
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      await db.update(resets)
        .set({
          wentWell: body.wentWell,
          needsAdjustment: body.needsAdjustment,
          notes: body.notes,
          stats: body.stats,
          aiSummary: body.aiSummary,
          staleActions: body.staleActions ?? [],
          carryForwardItems: body.carryForwardItems ?? [],
          monthlyWin: body.monthlyWin,
          monthlyChange: body.monthlyChange,
          intentions: body.intentions,
          completedAt: body.completedAt,
          updatedAt: now,
        })
        .where(eq(resets.id, existing[0].id));

      const updated = await db.select().from(resets).where(eq(resets.id, existing[0].id)).limit(1);
      return NextResponse.json({ reset: updated[0] });
    }

    // Create new
    const id = `reset-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(resets).values({
      id,
      type,
      periodStart,
      periodEnd,
      wentWell: body.wentWell || null,
      needsAdjustment: body.needsAdjustment || null,
      notes: body.notes || null,
      stats: body.stats || null,
      aiSummary: body.aiSummary || null,
      staleActions: body.staleActions ?? [],
      carryForwardItems: body.carryForwardItems ?? [],
      monthlyWin: body.monthlyWin || null,
      monthlyChange: body.monthlyChange || null,
      intentions: body.intentions || null,
      completedAt: body.completedAt || null,
      createdAt: now,
      updatedAt: now,
    });

    const created = await db.select().from(resets).where(eq(resets.id, id)).limit(1);
    return NextResponse.json({ reset: created[0] }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to save reset' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/resets — Update specific fields of a reset
 * Body: { id, ...fields }
 */
export async function PATCH(request: Request) {
  const body = await request.json();
  const { id } = body;

  if (!id) {
    return ApiErrors.badRequest('id is required');
  }

  // Allowlist of updatable fields to prevent overwriting id, type, periodStart, createdAt
  const allowedFields = [
    'wentWell', 'needsAdjustment', 'notes', 'stats', 'aiSummary',
    'staleActions', 'carryForwardItems', 'monthlyWin', 'monthlyChange',
    'intentions', 'completedAt',
  ] as const;

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  const now = new Date().toISOString();

  try {
    await db.update(resets)
      .set({ ...updates, updatedAt: now })
      .where(eq(resets.id, id));

    const updated = await db.select().from(resets).where(eq(resets.id, id)).limit(1);
    if (!updated.length) {
      return ApiErrors.notFound('Reset');
    }

    return NextResponse.json({ reset: updated[0] });
  } catch {
    return ApiErrors.internal('Failed to update reset');
  }
}
