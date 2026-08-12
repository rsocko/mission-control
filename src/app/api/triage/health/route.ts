import { NextResponse } from 'next/server';
import { getTriageQueueHealth } from '@/lib/triage/staleness';
import logger from '@/lib/logger';

/**
 * GET /api/triage/health
 *
 * Returns queue health metrics for the triage dashboard widget.
 */
export async function GET() {
  try {
    const metrics = await getTriageQueueHealth();
    return NextResponse.json(metrics);
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute triage queue health');
    return NextResponse.json(
      { error: 'Failed to compute triage queue health' },
      { status: 500 },
    );
  }
}
