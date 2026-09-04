/**
 * KPI Card Registry — defines all available dashboard KPI cards,
 * their visual types, accent colors, icons, and data source slugs.
 */

import { NEXT_7_DAYS_LABEL } from '@/lib/tasks/due-window';

export type KpiVisualType = 'counter' | 'fraction' | 'percentage' | 'counter_dots' | 'fraction_dots' | 'counter_sparkline';

export interface KpiCardDefinition {
  slug: string;
  label: string;
  visualType: KpiVisualType;
  icon: string;
  accent: string;
  subtitle?: string;
  clickAction?: { type: 'navigate'; path: string } | { type: 'filter'; key: string };
  category: 'task_counts' | 'progress' | 'integrations';
}

export interface KpiCardData {
  slug: string;
  value: number;
  max?: number;
  subtitle?: string;
  dots?: boolean[];
  sparkline?: number[];
  accent?: string;
}

export interface KpiCardRenderData extends KpiCardDefinition {
  data: KpiCardData;
}

export const KPI_REGISTRY: Record<string, KpiCardDefinition> = {
  'total-open': {
    slug: 'total-open',
    label: 'Total Open',
    visualType: 'counter',
    icon: 'ClipboardList',
    accent: 'blue',
    category: 'task_counts',
  },
  'overdue': {
    slug: 'overdue',
    label: 'Overdue',
    visualType: 'counter',
    icon: 'AlertTriangle',
    accent: 'red',
    clickAction: { type: 'filter', key: 'overdue' },
    category: 'task_counts',
  },
  'due-this-week': {
    slug: 'due-this-week',
    label: NEXT_7_DAYS_LABEL,
    visualType: 'counter',
    icon: 'CalendarDays',
    accent: 'amber',
    clickAction: { type: 'filter', key: 'week' },
    category: 'task_counts',
  },
  'unread-notifications': {
    slug: 'unread-notifications',
    label: 'Unread Notifications',
    visualType: 'counter',
    icon: 'Bell',
    accent: 'orange',
    category: 'task_counts',
  },
  'my-day': {
    slug: 'my-day',
    label: 'My Day',
    visualType: 'counter',
    icon: 'Sun',
    accent: 'cyan',
    clickAction: { type: 'navigate', path: '/today' },
    category: 'task_counts',
  },
  'high-priority': {
    slug: 'high-priority',
    label: 'High Priority',
    visualType: 'counter',
    icon: 'Flame',
    accent: 'red',
    clickAction: { type: 'filter', key: 'high' },
    category: 'task_counts',
  },
  'completed-today': {
    slug: 'completed-today',
    label: 'Done Today',
    visualType: 'counter',
    icon: 'CheckCircle2',
    accent: 'green',
    category: 'task_counts',
  },
  'this-week-progress': {
    slug: 'this-week-progress',
    label: 'This Week',
    visualType: 'fraction',
    icon: 'CheckCircle2',
    accent: 'blue',
    subtitle: 'tasks done',
    category: 'progress',
  },
  'routines-kept': {
    slug: 'routines-kept',
    label: 'Routines',
    visualType: 'percentage',
    icon: 'RefreshCw',
    accent: 'green',
    subtitle: 'kept this week',
    clickAction: { type: 'navigate', path: '/routines' },
    category: 'progress',
  },
  'streak': {
    slug: 'streak',
    label: 'Streak',
    visualType: 'counter_dots',
    icon: 'Flame',
    accent: 'orange',
    subtitle: 'showing up',
    category: 'progress',
  },
  'focus-3': {
    slug: 'focus-3',
    label: 'Focus 3',
    visualType: 'fraction_dots',
    icon: 'Zap',
    accent: 'purple',
    subtitle: 'today',
    clickAction: { type: 'navigate', path: '/today' },
    category: 'progress',
  },
  'daily-avg': {
    slug: 'daily-avg',
    label: 'Daily Avg',
    visualType: 'counter_sparkline',
    icon: 'TrendingUp',
    accent: 'purple',
    subtitle: 'tasks/day',
    category: 'progress',
  },
  'triage-pending': {
    slug: 'triage-pending',
    label: 'Triage Pending',
    visualType: 'counter',
    icon: 'Inbox',
    accent: 'amber',
    clickAction: { type: 'navigate', path: '/triage' },
    category: 'integrations',
  },
  'triage-stale': {
    slug: 'triage-stale',
    label: 'Triage Stale',
    visualType: 'counter',
    icon: 'AlertTriangle',
    accent: 'red',
    subtitle: '> 7 days old',
    clickAction: { type: 'navigate', path: '/triage' },
    category: 'integrations',
  },
  'doc-actions-pending': {
    slug: 'doc-actions-pending',
    label: 'Doc Actions',
    visualType: 'counter',
    icon: 'FileText',
    accent: 'indigo',
    clickAction: { type: 'navigate', path: '/doc-intelligence' },
    category: 'integrations',
  },
  'doc-statements-missing': {
    slug: 'doc-statements-missing',
    label: 'Missing Stmts',
    visualType: 'counter',
    icon: 'AlertTriangle',
    accent: 'purple',
    clickAction: { type: 'navigate', path: '/doc-intelligence' },
    category: 'integrations',
  },
  'doc-eob-unmatched': {
    slug: 'doc-eob-unmatched',
    label: 'Unmatched EOBs',
    visualType: 'counter',
    icon: 'FileText',
    accent: 'pink',
    clickAction: { type: 'navigate', path: '/doc-intelligence' },
    category: 'integrations',
  },
};

export const KPI_PRESETS: Record<string, { label: string; slugs: string[] }> = {
  default: {
    label: 'Default',
    slugs: ['total-open', 'overdue', 'due-this-week', 'unread-notifications'],
  },
  progress: {
    label: 'Progress-focused',
    slugs: ['this-week-progress', 'routines-kept', 'streak', 'focus-3', 'daily-avg'],
  },
  operations: {
    label: 'Operations',
    slugs: ['total-open', 'overdue', 'my-day', 'high-priority', 'triage-pending', 'doc-actions-pending', 'unread-notifications'],
  },
};

export const DEFAULT_KPI_SLUGS = KPI_PRESETS.default.slugs;
export const MAX_KPI_CARDS = 6;
