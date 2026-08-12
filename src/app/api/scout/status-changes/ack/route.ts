import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';

// ─── Constants ──────────────────────────────────────────────────────────────

const WRITE_BACK_CURSOR_KEY = 'scout_write_back_synced_at';

// ─── Auth ───────────────────────────────────────────────────────────────────

function hasValidApiKey(request: Request): boolean {
  const expected = process.env.MC_API_KEY;
  if (!expected) return true;

  const keyHeader = request.headers.get('x-mc-api-key');
  if (keyHeader && keyHeader === expected) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === expected;
  }

  return false;
}

// ─── POST Handler ───────────────────────────────────────────────────────────

/**
 * POST /api/scout/status-changes/ack
 *
 * Scout calls this after successfully processing status changes to advance
 * the write-back cursor. Next time GET /api/scout/status-changes is called
 * without an explicit `since`, it will use this cursor.
 *
 * Body: { acknowledgedAt: string (ISO timestamp from queriedAt) }
 */
export async function POST(request: Request) {
  try {
    if (!hasValidApiKey(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { acknowledgedAt } = body;

    if (!acknowledgedAt || typeof acknowledgedAt !== 'string') {
      return NextResponse.json(
        { error: 'acknowledgedAt is required and must be an ISO timestamp string' },
        { status: 400 },
      );
    }

    const ackDate = new Date(acknowledgedAt);
    if (isNaN(ackDate.getTime())) {
      return NextResponse.json(
        { error: 'acknowledgedAt must be a valid ISO timestamp' },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    // Upsert the write-back cursor (only advance forward, never regress)
    const [existing] = await db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, WRITE_BACK_CURSOR_KEY));

    if (existing) {
      const currentCursor = existing.value as string;
      if (acknowledgedAt <= currentCursor) {
        // Already past this point — no-op to prevent cursor regression
        return NextResponse.json({ success: true, cursor: currentCursor, updatedAt: now });
      }
      await db.update(appSettings)
        .set({ value: acknowledgedAt, updatedAt: now })
        .where(eq(appSettings.key, WRITE_BACK_CURSOR_KEY));
    } else {
      await db.insert(appSettings).values({
        key: WRITE_BACK_CURSOR_KEY,
        value: acknowledgedAt,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: appSettings.key,
        set: { value: acknowledgedAt, updatedAt: now },
      });
    }

    logger.info(`[scout-status-ack] Write-back cursor advanced to ${acknowledgedAt}`);

    return NextResponse.json({
      success: true,
      cursor: acknowledgedAt,
      updatedAt: now,
    });
  } catch (err) {
    logger.error('[scout-status-ack] Error: %s', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
