import type { ScoreBreakdown } from '@/lib/smart-score';
import type { LocalDisposition, TaskEditPolicy, TaskItem, TaskSourceModel } from '@/types';

export type EnergyLevel = 'high' | 'medium' | 'low';
export type TodayView = 'list' | 'timeline';

export interface TaskTag {
  id: string;
  name: string;
  slug: string;
  type: string;
  color: string | null;
}

export interface MyDayItem {
  id: string;
  taskId: string;
  order: number;
  isAutoIncluded: boolean;
  addedAt: string;
  title: string;
  status: string;
  statusReason?: TaskItem['statusReason'] | null;
  priority: string;
  planningHorizon?: TaskItem['planningHorizon'] | null;
  dueDate: string | null;
  pushCount?: number;
  planningSignalCount?: number;
  connectorType: string;
  connectorInstanceId: string;
  sourceId?: string;
  sourceListId?: string | null;
  sourceListName: string | null;
  assignee?: string | null;
  createdAt: string | null;
  completedAt: string | null;
  tags: TaskTag[];
  metadata?: string | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  smartScore?: number | null;
  scoreBreakdown?: ScoreBreakdown | null;
  hubProjectIds?: string[];
  projectPhaseMemberships?: Array<{
    projectId: string;
    phaseId: string | null;
    phaseName: string | null;
  }>;
  effort?: number | null;
  microStatus?: string | null;
  estimatedDuration?: number | null;
  hasDescription: boolean;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  editPolicy: TaskEditPolicy;
}

export interface ScheduledTask {
  taskId: string;
  scheduledDate: string;
  scheduledTime: string | null;
  estimatedDuration: number | null;
  isTimeBlocked: boolean;
  title: string;
  status: string;
  priority: string;
  connectorType: string;
}

export interface SuggestionTask {
  id: string;
  title: string;
  status: string;
  microStatus?: string | null;
  priority: string;
  dueDate: string | null;
  pushCount?: number;
  planningSignalCount?: number;
  connectorType: string;
  connectorInstanceId: string;
  sourceId?: string | null;
  sourceListName: string | null;
  metadata?: string | null;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  editPolicy: TaskEditPolicy;
}

export interface SuggestionGroups {
  planningSignals: SuggestionTask[];
  planningNow: SuggestionTask[];
  yesterday: SuggestionTask[];
  overdue: SuggestionTask[];
  dueToday: SuggestionTask[];
  dueThisWeek: SuggestionTask[];
  highPriority: SuggestionTask[];
  aiRecommended: SuggestionTask[];
  recentlyAdded: SuggestionTask[];
  carriedForward: SuggestionTask[];
  repeatedlyRescheduled: SuggestionTask[];
}

export const REPLANNING_SUGGESTION = {
  title: 'May Need Replanning',
  description: 'Tasks with recent missed commitments, elapsed time blocks, overdue transitions, snooze extensions, or due dates moved later.',
  insightsHref: '/insights#planning-friction',
} as const;

export interface CalendarEvent {
  id: string;
  subject: string;
  startTime: string;
  endTime: string;
  duration: number;
  location?: string;
  isAllDay: boolean;
}

export interface DayPlanBlock {
  time: string;
  endTime: string;
  type: string;
  title: string;
  duration: number;
  taskId?: string;
}

export interface DayPlan {
  plan: DayPlanBlock[];
  summary: string;
  suggestions: string[];
}

export interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
}

export interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
}

export interface SaveTemplateTask {
  id: string;
  title: string;
  subtasks?: string[];
}

export const EMPTY_SUGGESTION_GROUPS: SuggestionGroups = {
  planningSignals: [],
  planningNow: [],
  yesterday: [],
  overdue: [],
  dueToday: [],
  dueThisWeek: [],
  highPriority: [],
  aiRecommended: [],
  recentlyAdded: [],
  carriedForward: [],
  repeatedlyRescheduled: [],
};
