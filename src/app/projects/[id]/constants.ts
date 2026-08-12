import type { ProjectHealth, ProjectStatus, TaskPriority, TaskStatus } from '@/types';
import type { GanttZoom, ProjectPhase, ProjectTab } from './types';

export const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'phases', label: 'Plan' },
  { id: 'tasks', label: 'Project Tasks' },
  { id: 'settings', label: 'Settings' },
];

export const PHASE_STATUS_ORDER: Array<ProjectPhase['status']> = ['pending', 'in_progress', 'completed'];

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  not_started: 'Not started',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const PHASE_STATUS_LABELS: Record<ProjectPhase['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  none: '—',
};

export const HEALTH_LABELS: Record<ProjectHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  behind: 'Behind',
};

export const ZOOM_CELL_WIDTH: Record<GanttZoom, number> = {
  day: 28,
  week: 12,
  month: 5,
};

export const LEFT_GANTT_COLUMN_WIDTH = 220;
export const BUTTON_TRANSITION = 'transition-[background-color,border-color,color,transform,box-shadow] duration-150';
export const GANTT_ROW_HEIGHT = 96;
export const GANTT_HEADER_HEIGHT = 64;
