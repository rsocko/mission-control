import { NextRequest, NextResponse } from 'next/server';
import {
  computeInsights,
  computeInsightsSection,
  type DeliveryInterval,
  type InsightsPeriod,
  type InsightsQueryOptions,
  type InsightsSection,
} from '@/lib/stats/insights';
import logger from '@/lib/logger';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string | null): value is string {
  if (!value || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalParam(searchParams: URLSearchParams, name: string): string | undefined {
  const value = searchParams.get(name)?.trim();
  return value || undefined;
}

function isInsightsSection(value: string | null): value is InsightsSection {
  return value !== null && ['summary', 'delivery', 'flow', 'activity'].includes(value);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const periodParam = searchParams.get('period');
    const customRange = periodParam === 'custom';
    const period: InsightsPeriod = customRange || periodParam === '30'
      ? 30
      : periodParam === '90'
        ? 90
        : 7;
    const startDate = searchParams.get('start');
    const endDate = searchParams.get('end');
    const filterLimits = {
      project: 200,
      projectId: 200,
      source: 200,
      priority: 200,
      status: 200,
      timezone: 100,
    } as const;
    const overlongFilter = Object.entries(filterLimits).find(([name, limit]) => (
      (searchParams.get(name)?.trim().length ?? 0) > limit
    ));
    if (overlongFilter) {
      return NextResponse.json(
        { error: `${overlongFilter[0]} exceeds its maximum length` },
        { status: 400 },
      );
    }
    const statusFilter = optionalParam(searchParams, 'status');
    if (
      statusFilter
      && !['todo', 'in_progress', 'done', 'cancelled', 'active'].includes(statusFilter)
    ) {
      return NextResponse.json(
        { error: 'Unsupported status filter' },
        { status: 400 },
      );
    }
    if (customRange && (
      !isValidDate(startDate)
      || !isValidDate(endDate)
      || startDate > endDate
    )) {
      return NextResponse.json(
        { error: 'Custom insights ranges require valid start and end dates' },
        { status: 400 },
      );
    }
    if (
      customRange
      && startDate
      && endDate
      && (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > 365
    ) {
      return NextResponse.json(
        { error: 'Custom insights ranges cannot exceed 366 days' },
        { status: 400 },
      );
    }
    const staleParam = Number(searchParams.get('staleDays') ?? 14);
    const staleThresholdDays = Number.isFinite(staleParam)
      ? Math.min(365, Math.max(1, Math.round(staleParam)))
      : 14;
    const intervalParam = searchParams.get('interval');
    const interval: DeliveryInterval | undefined = intervalParam === 'week' || intervalParam === 'month'
      ? intervalParam
      : undefined;
    const projectId = optionalParam(searchParams, 'project');
    const source = optionalParam(searchParams, 'source');
    const sectionParam = searchParams.get('section');
    if (sectionParam && !isInsightsSection(sectionParam)) {
      return NextResponse.json({ error: 'Unsupported insights section' }, { status: 400 });
    }

    const options: InsightsQueryOptions = {
      interval,
      projectId,
      source,
      timeZone: optionalParam(searchParams, 'timezone'),
      startDate: customRange ? startDate! : undefined,
      endDate: customRange ? endDate! : undefined,
      staleThresholdDays,
      flowFilters: {
        projectId: optionalParam(searchParams, 'projectId') ?? projectId,
        source,
        priority: optionalParam(searchParams, 'priority'),
        status: statusFilter,
      },
    };
    const snapshot = isInsightsSection(sectionParam)
      ? await computeInsightsSection(sectionParam, period, options)
      : await computeInsights(period, options);
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, 'Failed to compute insights');
    return NextResponse.json({ error: 'Failed to compute insights' }, { status: 500 });
  }
}
