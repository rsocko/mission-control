import { NextResponse } from 'next/server';
import { computeKpis, type KpiSlug, type KpiResult, ALL_KPI_SLUGS } from '@/lib/stats';
import type { KpiCardData } from '@/lib/kpi/registry';
import logger from '@/lib/logger';
import { getLocalToday } from '@/lib/utils/date';

/** Map a KpiResult from the shared engine to the KpiCardData shape the UI expects */
function toCardData(result: KpiResult): KpiCardData {
  const card: KpiCardData = { slug: result.slug, value: result.value };
  if (result.max !== undefined) card.max = result.max;
  if (result.dots) card.dots = result.dots;
  if (result.sparkline) card.sparkline = result.sparkline;
  if (result.accent) card.accent = result.accent;
  return card;
}

/**
 * GET /api/dashboard/kpis
 *
 * Query params:
 *   ?slugs=this-week-progress,routines-kept,streak,focus-3,daily-avg
 *   &date=YYYY-MM-DD (optional, defaults to today)
 *   &autoSurface=true (optional, auto-surface contextual KPIs)
 *
 * Returns: { cards: KpiCardData[], autoSurfaced: (KpiCardData & { reason: string })[] }
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const today = searchParams.get('date') || getLocalToday();
    const slugsParam = searchParams.get('slugs');
    const requestedSlugs = slugsParam
      ? slugsParam.split(',').map(s => s.trim()).filter((s): s is KpiSlug => ALL_KPI_SLUGS.includes(s as KpiSlug))
      : ['total-open', 'overdue', 'due-this-week', 'unread-notifications'] as KpiSlug[];

    // Compute requested KPIs via the shared stats engine
    const snapshot = await computeKpis(requestedSlugs, { today });
    const cards: KpiCardData[] = requestedSlugs
      .filter(slug => snapshot.kpis[slug])
      .map(slug => toCardData(snapshot.kpis[slug]));

    // Auto-surface: compute contextual candidates not already in the requested set
    const autoSurface = searchParams.get('autoSurface') === 'true';
    const autoSurfaced: (KpiCardData & { reason: string })[] = [];

    if (autoSurface) {
      const candidateSlugs = (['my-day', 'routines-kept', 'focus-3', 'streak'] as KpiSlug[])
        .filter(s => !requestedSlugs.includes(s));

      if (candidateSlugs.length > 0) {
        const candidateSnapshot = await computeKpis(candidateSlugs, { today });

        for (const slug of candidateSlugs) {
          const result = candidateSnapshot.kpis[slug];
          if (!result) continue;

          switch (slug) {
            case 'my-day':
              if (result.value >= 1) {
                autoSurfaced.push({ ...toCardData(result), reason: `${result.value} item${result.value > 1 ? 's' : ''} on My Day` });
              }
              break;
            case 'routines-kept':
              if (result.value > 0) {
                autoSurfaced.push({ ...toCardData(result), reason: `${result.value}% routines kept this week` });
              }
              break;
            case 'focus-3':
              if (result.value > 0) {
                autoSurfaced.push({ ...toCardData(result), reason: `${result.value}/${result.max || 3} focus items done` });
              }
              break;
            case 'streak':
              if (result.value >= 3) {
                autoSurfaced.push({ ...toCardData(result), reason: `${result.value}-day streak active` });
              }
              break;
          }
        }
      }
    }

    return NextResponse.json({ cards, autoSurfaced });
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute KPI data');
    return NextResponse.json({ cards: [], error: 'Failed to compute KPIs' }, { status: 500 });
  }
}
