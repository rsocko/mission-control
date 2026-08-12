'use client';

import { cloneElement, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityCalendar, type Activity } from 'react-activity-calendar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ActivityHeatmapEntry } from '@/lib/stats/insights';

export type ActivityHeatmapMetric = 'tasks' | 'routines' | 'combined';

interface ActivityHeatmapProps {
  data: ActivityHeatmapEntry[];
  compact?: boolean;
}

const METRICS: Record<ActivityHeatmapMetric, {
  label: string;
  singular: string;
  plural: string;
  colors: [string, string];
}> = {
  tasks: {
    label: 'Tasks completed',
    singular: 'task completed',
    plural: 'tasks completed',
    colors: ['#172033', '#34d399'],
  },
  routines: {
    label: 'Routine completions',
    singular: 'routine completed',
    plural: 'routines completed',
    colors: ['#172033', '#a78bfa'],
  },
  combined: {
    label: 'All activity',
    singular: 'activity',
    plural: 'activities',
    colors: ['#172033', '#38bdf8'],
  },
};

const METRIC_OPTIONS: ActivityHeatmapMetric[] = ['tasks', 'routines', 'combined'];

function isActivityHeatmapMetric(value: string): value is ActivityHeatmapMetric {
  return value === 'tasks' || value === 'routines' || value === 'combined';
}

function getMetricCount(entry: ActivityHeatmapEntry, metric: ActivityHeatmapMetric): number {
  if (metric === 'tasks') return entry.taskCompletions;
  if (metric === 'routines') return entry.routineCompletions;
  return entry.taskCompletions + entry.routineCompletions;
}

export function toCalendarActivities(
  data: ActivityHeatmapEntry[],
  metric: ActivityHeatmapMetric,
): Activity[] {
  const maxCount = Math.max(0, ...data.map(entry => getMetricCount(entry, metric)));

  return data.map(entry => {
    const count = getMetricCount(entry, metric);
    return {
      date: entry.date,
      count,
      level: count === 0 || maxCount === 0 ? 0 : Math.max(1, Math.ceil((count / maxCount) * 4)),
    };
  });
}

function formatTooltip(
  activity: Activity,
  entry: ActivityHeatmapEntry | undefined,
  metric: ActivityHeatmapMetric,
): string {
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${activity.date}T12:00:00`));
  const config = METRICS[metric];
  const unit = activity.count === 1 ? config.singular : config.plural;

  if (metric !== 'combined' || !entry) {
    return `${activity.count} ${unit} on ${date}`;
  }

  return `${activity.count} ${unit} on ${date} (${entry.taskCompletions} tasks, ${entry.routineCompletions} routines)`;
}

export function ActivityHeatmap({ data, compact = false }: ActivityHeatmapProps) {
  const [metric, setMetric] = useState<ActivityHeatmapMetric>('tasks');
  const calendarRef = useRef<HTMLElement>(null);
  const activities = useMemo(() => toCalendarActivities(data, metric), [data, metric]);
  const entriesByDate = useMemo(() => new Map(data.map(entry => [entry.date, entry])), [data]);
  const metricConfig = METRICS[metric];

  useEffect(() => {
    if (!compact) return;

    const frame = requestAnimationFrame(() => {
      const scrollContainer = calendarRef.current?.querySelector<HTMLElement>(
        '.react-activity-calendar__scroll-container',
      );
      if (scrollContainer) scrollContainer.scrollLeft = scrollContainer.scrollWidth;
    });

    return () => cancelAnimationFrame(frame);
  }, [activities, compact]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Completion Activity</h3>
          <p className="mt-1 text-xs text-slate-500">Rolling 12 months, independent of the period filter</p>
        </div>
        <Select
          value={metric}
          onValueChange={value => {
            if (isActivityHeatmapMetric(value)) setMetric(value);
          }}
        >
          <SelectTrigger
            className="h-8 w-[180px] border-slate-700 bg-slate-950/60 text-xs"
            aria-label="Heatmap color metric"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METRIC_OPTIONS.map(value => (
              <SelectItem key={value} value={value}>{METRICS[value].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {data.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">No completion activity yet</div>
      ) : (
        <ActivityCalendar
          ref={calendarRef}
          data={activities}
          blockMargin={2}
          blockRadius={2}
          blockSize={compact ? 9 : 11}
          colorScheme="dark"
          fontSize={compact ? 10 : 11}
          labels={{
            totalCount: `{{count}} ${metricConfig.plural} in the last 12 months`,
          }}
          showWeekdayLabels={compact ? false : ['mon', 'wed', 'fri']}
          theme={{ dark: metricConfig.colors }}
          weekStart={0}
          renderBlock={(block, activity) => {
            const label = formatTooltip(activity, entriesByDate.get(activity.date), metric);
            return cloneElement(block, { 'aria-label': label, title: label });
          }}
        />
      )}
    </div>
  );
}
