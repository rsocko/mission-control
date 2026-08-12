import { NextResponse } from 'next/server';
import { computeKpis, type KpiSlug, ALL_KPI_SLUGS } from '@/lib/stats';
import { getLocalToday } from '@/lib/utils/date';
import logger from '@/lib/logger';

/**
 * GET /api/stats
 *
 * Direct access to the shared stats computation engine.
 * Returns a full StatsSnapshot with all requested (or all) KPIs.
 *
 * Query params:
 *   ?slugs=streak,daily-avg,routines-kept (optional, defaults to all)
 *   &today=YYYY-MM-DD (optional, defaults to server today)
 *
 * Returns: StatsSnapshot { computedAt, today, kpis: Record<string, KpiResult> }
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const today = searchParams.get('today') || getLocalToday();
    const slugsParam = searchParams.get('slugs');

    const slugs: KpiSlug[] | undefined = slugsParam
      ? slugsParam.split(',').map(s => s.trim()).filter((s): s is KpiSlug => ALL_KPI_SLUGS.includes(s as KpiSlug))
      : undefined;

    const snapshot = await computeKpis(slugs, { today });

    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute stats snapshot');
    return NextResponse.json(
      { error: 'Failed to compute stats' },
      { status: 500 },
    );
  }
}
