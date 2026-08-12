export type DeliveryInterval = 'week' | 'month';

export interface DeliveryTaskRecord {
  id: string;
  title: string;
  createdAt: string;
  completedAt: string;
  source: string;
  statusReason: string | null;
}

export interface DeliverySeriesPoint {
  start: string;
  end: string;
  label: string;
  count: number;
  normalizedCount: number;
  rollingAverage: number;
  changePercent: number | null;
  isPartial: boolean;
}

export interface VelocitySeriesPoint {
  start: string;
  end: string;
  label: string;
  value: number;
  rollingAverage: number;
  changePercent: number | null;
  isPartial: boolean;
}

export interface LeadTimeDistributionBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
}

export interface LeadTimeTrendPoint {
  start: string;
  end: string;
  label: string;
  medianDays: number | null;
  p85Days: number | null;
  count: number;
}

export interface LeadTimeOutlier {
  taskId: string;
  title: string;
  leadTimeDays: number;
  completedAt: string;
}

export interface DeliveryMetrics {
  throughput: {
    interval: DeliveryInterval;
    total: number;
    averagePerInterval: number;
    points: DeliverySeriesPoint[];
  };
  velocity: {
    interval: DeliveryInterval;
    measure: 'tasks';
    rollingWindow: 3;
    points: VelocitySeriesPoint[];
  };
  leadTime: {
    summary: {
      count: number;
      averageDays: number | null;
      medianDays: number | null;
      p85Days: number | null;
      p95Days: number | null;
    };
    distribution: LeadTimeDistributionBucket[];
    trend: LeadTimeTrendPoint[];
    outliers: LeadTimeOutlier[];
  };
  excluded: {
    nonCompletionClosures: number;
    invalidTimestamps: number;
  };
}

const NON_COMPLETION_REASONS = new Set(['not_planned', 'duplicate', 'cancelled']);
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function formatDateOnly(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function addCalendarDays(value: string, days: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

export function getInclusivePeriodBoundaries(today: string, period: number): {
  periodStart: string;
  previousPeriodStart: string;
  previousPeriodEnd: string;
} {
  return {
    periodStart: addCalendarDays(today, -(period - 1)),
    previousPeriodStart: addCalendarDays(today, -(period * 2 - 1)),
    previousPeriodEnd: addCalendarDays(today, -period),
  };
}

function startOfWeek(value: string): string {
  const date = parseDateOnly(value);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return formatDateOnly(date);
}

function endOfMonth(value: string): string {
  const date = parseDateOnly(value);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return formatDateOnly(date);
}

function startOfInterval(value: string, interval: DeliveryInterval): string {
  return interval === 'week' ? startOfWeek(value) : `${value.slice(0, 7)}-01`;
}

function endOfInterval(value: string, interval: DeliveryInterval): string {
  return interval === 'week' ? addCalendarDays(startOfWeek(value), 6) : endOfMonth(value);
}

function nextInterval(value: string, interval: DeliveryInterval): string {
  if (interval === 'week') return addCalendarDays(value, 7);
  const date = parseDateOnly(value);
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return formatDateOnly(date);
}

function formatIntervalLabel(value: string, interval: DeliveryInterval): string {
  const date = parseDateOnly(value);
  if (interval === 'month') {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function timestampInTimeZone(timestamp: string, timeZone: string): Date | null {
  const includesOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp);
  if (includesOffset) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '0'] = match;
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const wallTime = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    milliseconds,
  );

  let instant = wallTime;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const representedWallTime = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
      milliseconds,
    );
    instant += wallTime - representedWallTime;
  }
  return new Date(instant);
}

export function dateInTimeZone(timestamp: string, timeZone: string): string | null {
  const date = timestampInTimeZone(timestamp, timeZone);
  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function percentile(values: number[], requestedPercentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * requestedPercentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const interpolated = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  return Math.round(interpolated * 10) / 10;
}

function roundedAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function createIntervals(startDate: string, endDate: string, interval: DeliveryInterval) {
  const intervals: Array<{
    start: string;
    end: string;
    label: string;
    isPartial: boolean;
    coveredDays: number;
    fullDays: number;
  }> = [];

  let cursor = startOfInterval(startDate, interval);
  while (cursor <= endDate) {
    const end = endOfInterval(cursor, interval);
    const coveredStart = cursor < startDate ? startDate : cursor;
    const coveredEnd = end > endDate ? endDate : end;
    intervals.push({
      start: cursor,
      end,
      label: formatIntervalLabel(cursor, interval),
      isPartial: cursor < startDate || end > endDate,
      coveredDays: daysBetweenInclusive(coveredStart, coveredEnd),
      fullDays: daysBetweenInclusive(cursor, end),
    });
    cursor = nextInterval(cursor, interval);
  }
  return intervals;
}

function createLeadTimeTrendIntervals(
  startDate: string,
  endDate: string,
  deliveryIntervals: ReturnType<typeof createIntervals>,
): ReturnType<typeof createIntervals> {
  if (daysBetweenInclusive(startDate, endDate) > 7) return deliveryIntervals;

  const intervals: ReturnType<typeof createIntervals> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    intervals.push({
      start: cursor,
      end: cursor,
      label: formatIntervalLabel(cursor, 'week'),
      isPartial: false,
      coveredDays: 1,
      fullDays: 1,
    });
    cursor = addCalendarDays(cursor, 1);
  }
  return intervals;
}

function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((parseDateOnly(end).getTime() - parseDateOnly(start).getTime()) / DAY_MS) + 1;
}

function leadTimeDays(record: DeliveryTaskRecord, timeZone: string): number | null {
  const created = timestampInTimeZone(record.createdAt, timeZone)?.getTime();
  const completed = timestampInTimeZone(record.completedAt, timeZone)?.getTime();
  if (created === undefined || completed === undefined || completed < created) return null;
  return Math.round(((completed - created) / DAY_MS) * 10) / 10;
}

export function buildDeliveryMetrics(
  records: DeliveryTaskRecord[],
  options: {
    startDate: string;
    endDate: string;
    interval: DeliveryInterval;
    timeZone: string;
  },
): DeliveryMetrics {
  const intervals = createIntervals(options.startDate, options.endDate, options.interval);
  let nonCompletionClosures = 0;
  let invalidTimestamps = 0;

  const completions = records.flatMap(record => {
    const completedDate = dateInTimeZone(record.completedAt, options.timeZone);
    if (!completedDate) {
      invalidTimestamps++;
      return [];
    }
    if (completedDate < options.startDate || completedDate > options.endDate) return [];
    if (record.statusReason && NON_COMPLETION_REASONS.has(record.statusReason)) {
      nonCompletionClosures++;
      return [];
    }
    return [{ record, completedDate }];
  });

  const completedWithLeadTime = completions.flatMap(item => {
    const duration = leadTimeDays(item.record, options.timeZone);
    if (duration === null) {
      invalidTimestamps++;
      return [];
    }
    return [{ ...item, duration }];
  });

  const counts = intervals.map(({ start, end }) =>
    completions.filter(item => item.completedDate >= start && item.completedDate <= end).length
  );
  const normalizedCounts = intervals.map((interval, index) =>
    Math.round((counts[index] * interval.fullDays / interval.coveredDays) * 10) / 10
  );

  const points: DeliverySeriesPoint[] = intervals.map((interval, index) => {
    const rollingValues = normalizedCounts.slice(Math.max(0, index - 2), index + 1);
    const previous = index > 0 ? normalizedCounts[index - 1] : null;
    return {
      start: interval.start,
      end: interval.end,
      label: interval.label,
      isPartial: interval.isPartial,
      count: counts[index],
      normalizedCount: normalizedCounts[index],
      rollingAverage: roundedAverage(rollingValues) ?? 0,
      changePercent: previous && previous > 0
        ? Math.round(((normalizedCounts[index] - previous) / previous) * 100)
        : null,
    };
  });

  const distribution: LeadTimeDistributionBucket[] = [
    { label: '< 1 day', minDays: 0, maxDays: 1, count: 0 },
    { label: '1-3 days', minDays: 1, maxDays: 4, count: 0 },
    { label: '4-7 days', minDays: 4, maxDays: 8, count: 0 },
    { label: '8-14 days', minDays: 8, maxDays: 15, count: 0 },
    { label: '15-30 days', minDays: 15, maxDays: 31, count: 0 },
    { label: '> 30 days', minDays: 31, maxDays: null, count: 0 },
  ];

  for (const item of completedWithLeadTime) {
    const bucket = distribution.find(candidate =>
      item.duration >= candidate.minDays
      && (candidate.maxDays === null || item.duration < candidate.maxDays)
    );
    if (bucket) bucket.count++;
  }

  const durations = completedWithLeadTime.map(item => item.duration);
  const leadTimeTrendIntervals = createLeadTimeTrendIntervals(
    options.startDate,
    options.endDate,
    intervals,
  );
  const leadTimeTrend = leadTimeTrendIntervals.map(interval => {
    const intervalDurations = completedWithLeadTime
      .filter(item => item.completedDate >= interval.start && item.completedDate <= interval.end)
      .map(item => item.duration);
    return {
      start: interval.start,
      end: interval.end,
      label: interval.label,
      medianDays: percentile(intervalDurations, 0.5),
      p85Days: percentile(intervalDurations, 0.85),
      count: intervalDurations.length,
    };
  });

  return {
    throughput: {
      interval: options.interval,
      total: completions.length,
      averagePerInterval: roundedAverage(normalizedCounts) ?? 0,
      points,
    },
    velocity: {
      interval: options.interval,
      measure: 'tasks',
      rollingWindow: 3,
      points: points.map(point => ({
        start: point.start,
        end: point.end,
        label: point.label,
        value: point.normalizedCount,
        rollingAverage: point.rollingAverage,
        changePercent: point.changePercent,
        isPartial: point.isPartial,
      })),
    },
    leadTime: {
      summary: {
        count: durations.length,
        averageDays: roundedAverage(durations),
        medianDays: percentile(durations, 0.5),
        p85Days: percentile(durations, 0.85),
        p95Days: percentile(durations, 0.95),
      },
      distribution,
      trend: leadTimeTrend,
      outliers: [...completedWithLeadTime]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map(item => ({
          taskId: item.record.id,
          title: item.record.title,
          leadTimeDays: item.duration,
          completedAt: item.record.completedAt,
        })),
    },
    excluded: {
      nonCompletionClosures,
      invalidTimestamps,
    },
  };
}
