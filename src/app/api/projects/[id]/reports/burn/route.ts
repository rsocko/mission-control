import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getBurnReport } from '@/lib/reports/burn';
import type { BurnReportMode } from '@/lib/reports/burn-types';
import { getLocalToday } from '@/lib/utils/date';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 1_830;

function isDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const searchParams = new URL(request.url).searchParams;
  const modeParam = searchParams.get('mode') ?? 'count';
  if (modeParam !== 'count' && modeParam !== 'effort') {
    return ApiErrors.badRequest('mode must be count or effort');
  }
  const mode = modeParam as BurnReportMode;

  const today = getLocalToday();
  const startDate = searchParams.get('start') ?? addUtcDays(today, -89);
  const endDate = searchParams.get('end') ?? today;
  if (!isDate(startDate) || !isDate(endDate)) {
    return ApiErrors.badRequest('start and end must be valid YYYY-MM-DD dates');
  }
  if (startDate > endDate) {
    return ApiErrors.badRequest('start must be on or before end');
  }

  const dayCount = Math.round(
    (new Date(`${endDate}T00:00:00.000Z`).getTime()
      - new Date(`${startDate}T00:00:00.000Z`).getTime()) / 86_400_000,
  ) + 1;
  if (dayCount > MAX_REPORT_DAYS) {
    return ApiErrors.badRequest(`report range cannot exceed ${MAX_REPORT_DAYS} days`);
  }

  try {
    const report = await getBurnReport({
      projectId: id,
      phaseId: searchParams.get('phase_id') ?? undefined,
      mode,
      startDate,
      endDate,
      today,
    });
    if (!report) {
      return ApiErrors.notFound(searchParams.has('phase_id') ? 'Project phase' : 'Project');
    }
    return NextResponse.json({ report });
  } catch (error) {
    return ApiErrors.internal('Failed to build burn report', error);
  }
}
