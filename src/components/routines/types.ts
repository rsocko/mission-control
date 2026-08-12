export type CadenceType =
  | 'daily'
  | 'specific_days'
  | 'x_per_week'
  | 'every_n_days'
  | 'weekly'
  | 'monthly'
  | 'quarterly';

export interface CadenceConfig {
  days?: number[];
  target?: number;
  minDays?: number;
  maxDays?: number;
  preferredDay?: string;
}

export interface WeekCompletion {
  date: string;
  id: string;
}

export interface IntervalStatus {
  status: 'on_track' | 'due_soon' | 'overdue_soft';
  daysSinceLast: number;
  progressPercent: number;
}

export interface WeeklyProgress {
  done: number;
  target: number;
  isOver: boolean;
  bonus: number;
}

export interface Routine {
  id: string;
  name: string;
  description: string | null;
  cadenceType: CadenceType;
  cadenceConfig: CadenceConfig;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  isArchived: boolean;
  streak: number;
  weekCompletions: WeekCompletion[];
  intervalStatus: IntervalStatus | null;
  weeklyProgress: WeeklyProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface HeatmapCompletion {
  routineId: string;
  date: string;
}

export const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const DAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0];

export const CADENCE_OPTIONS: { value: CadenceType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'specific_days', label: 'Specific days' },
  { value: 'x_per_week', label: 'X per week' },
  { value: 'every_n_days', label: 'Every N days' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
];

export const CADENCE_LABELS: Record<CadenceType, string> = {
  daily: 'Daily',
  specific_days: 'Specific days',
  x_per_week: 'X/week',
  every_n_days: 'Every N days',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
};
