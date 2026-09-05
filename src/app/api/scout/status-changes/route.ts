import { NextResponse } from 'next/server';
import logger from '@/lib/logger';
import {
  hasValidScoutApiKey,
  InvalidScoutStatusTimestampError,
  listScoutStatusChanges,
} from '@/lib/connectors/scout/status-change-service';

// ─── GET Handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  try {
    if (!hasValidScoutApiKey(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(
      await listScoutStatusChanges(new URL(request.url).searchParams),
    );
  } catch (err) {
    if (err instanceof InvalidScoutStatusTimestampError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error('[scout-status-changes] Error: %s', err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
