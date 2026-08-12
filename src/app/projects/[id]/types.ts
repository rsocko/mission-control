import type {
  LocalDisposition,
  ProjectHealth,
  ProjectStatus,
  SourceBinding,
  TaskEditPolicy,
  TaskPriority,
  TaskSourceModel,
  TaskStatus,
} from '@/types';
import type { TaskTag } from '@/types/dashboard';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  color: string;
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
  sortOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPhase {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed';
  color: string | null;
  estimatedDays: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  startAfterPhaseId: string | null;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhaseItem {
  id: string;
  phaseId: string;
  taskId: string;
  sortOrder: number;
  estimatedEffortHours: number | null;
  isProposed: boolean;
  proposalType: string | null;
  createdAt: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  statusReason?: string | null;
  priority: TaskPriority;
  dueDate?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId?: string | null;
  sourceListName?: string | null;
  assignee?: string | null;
  tags?: TaskTag[];
  estimatedDuration?: number | null;
  sourceId?: string | null;
  metadata?: string | null;
  effort?: number | null;
  subtaskTotal?: number | null;
  subtaskDone?: number | null;
  hubProjectIds?: string[];
  projectPhaseMemberships?: Array<{
    projectId: string;
    projectName: string;
    phaseId: string | null;
    phaseName: string | null;
  }>;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  editPolicy: TaskEditPolicy;
}

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
  item: PhaseItem;
  task: ProjectTask;
}

export interface GanttTaskBar {
  item: PhaseItem;
  task: ProjectTask;
  start: Date;
  end: Date;
}

export interface GanttPhaseRow {
  phase: ProjectPhase;
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
