import type {
  HubProject,
  ProjectPhase as CanonicalProjectPhase,
  ProjectPhaseItem as CanonicalProjectPhaseItem,
  ProjectHealth,
  ProjectStatus,
  SourceBinding,
  TaskPriority,
  TaskStatus,
} from '@/types';
import type { TaskListItemDto } from '@/types/api';

type ProjectDetailDomainFields = Pick<
  HubProject,
  'id' | 'name' | 'color' | 'sortOrder' | 'metadata' | 'createdAt' | 'updatedAt'
>;

export type ProjectDetailViewModel = ProjectDetailDomainFields & {
  description: string | null;
  icon: string | null;
  iconColor: string | null;
  sourceBindings: SourceBinding[];
  autoIncludeRules: unknown[];
  kanbanColumns: unknown[];
  defaultView: string;
  status: ProjectStatus;
  statusOverride: ProjectStatus | null;
  category: string | null;
  targetDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type ProjectPhaseViewModel = CanonicalProjectPhase;

export type ProjectPhaseItemViewModel = CanonicalProjectPhaseItem;

type ProjectTaskDtoFields = Omit<TaskListItemDto, 'status' | 'priority'>;

export type ProjectTaskViewModel = ProjectTaskDtoFields & {
  description?: string | null;
  status: TaskStatus;
  statusReason?: string | null;
  priority: TaskPriority;
  completedAt?: string | null;
  updatedAt: string;
};

export interface ProjectRuleMatch {
  taskId: string;
  title: string;
  status: string;
  alreadyAssigned: boolean;
  excluded: boolean;
  excludedAt: string | null;
  reasons: string[];
}

export interface ProgressSummary {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  todoTasks: number;
  cancelledTasks: number;
  percentComplete: number;
}

export interface HealthSummary {
  health: ProjectHealth;
  message: string;
}

export interface PhaseTaskEntry {
  item: ProjectPhaseItemViewModel;
  task: ProjectTaskViewModel;
}

export interface GanttTaskBar {
  item: ProjectPhaseItemViewModel;
  task: ProjectTaskViewModel;
  start: Date;
  end: Date;
}

export interface GanttPhaseRow {
  phase: ProjectPhaseViewModel;
  start: Date;
  end: Date;
  durationDays: number;
  tasks: GanttTaskBar[];
}

export interface TimelineSegment {
  label: string;
  sublabel: string;
  offset: number;
  width: number;
}

export type ProjectTab = 'overview' | 'phases' | 'tasks' | 'settings';
export type PhaseViewMode = 'list' | 'gantt' | 'graph' | 'assign';
export type GanttZoom = 'day' | 'week' | 'month';
export type TaskEffortFilter = number | 'all';
