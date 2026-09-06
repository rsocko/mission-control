import { NextResponse } from 'next/server';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import type { ResetPatch } from '@/db/persistence/ai-workflows';
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
    const persistence = await getAIWorkflowPersistence();

    if (type && periodStart) {
      // Get specific reset
      const reset = await persistence.resets.get(type, periodStart);
      return NextResponse.json({ reset });
    }

    // List recent resets
    const resets = await persistence.resets.list(type, 20);
    return NextResponse.json({ resets });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch resets' },
      { status: 500 },
    );
  }
}

/**
 * Fields a client may write through POST/PATCH. `id`, `type`, `periodStart`,
 * `periodEnd`, and `createdAt` are never taken from the body.
 */
const RESET_WRITABLE_FIELDS = [
  'wentWell', 'needsAdjustment', 'notes', 'stats', 'aiSummary',
  'staleActions', 'carryForwardItems', 'monthlyWin', 'monthlyChange',
  'intentions', 'completedAt',
] as const;

/** Collects only the keys the request actually supplied, so an omitted field keeps its stored value and an explicit `null` clears it. */
function readResetPatch(body: Record<string, unknown>): ResetPatch {
  const patch: Record<string, unknown> = {};
  for (const field of RESET_WRITABLE_FIELDS) {
    if (field in body) {
      patch[field] = body[field];
    }
  }
  return patch as ResetPatch;
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
    const persistence = await getAIWorkflowPersistence();
    const existing = await persistence.resets.get(type, periodStart);
    const reset = await persistence.resets.upsert({
      type,
      periodStart,
      periodEnd,
      now,
      fields: readResetPatch(body),
    });

    return NextResponse.json({ reset }, { status: existing ? 200 : 201 });
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
  const updates = readResetPatch(body);

  const now = new Date().toISOString();

  try {
    const persistence = await getAIWorkflowPersistence();
    const updated = await persistence.resets.patch(id, updates, now);
    if (!updated) {
      return ApiErrors.notFound('Reset');
    }

    return NextResponse.json({ reset: updated });
  } catch {
    return ApiErrors.internal('Failed to update reset');
  }
}
