import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  acknowledgeScoutStatusChanges,
  hasValidScoutApiKey,
  InvalidScoutStatusTimestampError,
} from '@/lib/connectors/scout/status-change-service';

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
    if (!hasValidScoutApiKey(request)) {
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

    return NextResponse.json(await acknowledgeScoutStatusChanges(acknowledgedAt));
  } catch (err) {
    if (err instanceof InvalidScoutStatusTimestampError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error('[scout-status-ack] Error: %s', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
