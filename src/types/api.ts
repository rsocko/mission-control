import type { ScoreBreakdown } from '@/lib/smart-score';
import type { ReminderRelativeRule } from '@/lib/tasks/relative-reminder';
import type {
  HubProject,
  KanbanColumn,
  LocalDisposition,
  PlanningHorizon,
  Tag,
  TaskEditPolicy,
  TaskItem,
  TaskSourceModel,
} from '@/types';

export type TaskTagDto = Pick<Tag, 'id' | 'name' | 'slug'> & {
  type: string;
  source?: string | null;
  sources?: string[];
  color: string | null;
  count?: number;
};

type TaskListDomainFields = Pick<
  TaskItem,
  | 'id'
  | 'title'
  | 'pushCount'
  | 'connectorType'
  | 'connectorInstanceId'
  | 'localDisposition'
>;

/**
 * Serialized task returned by GET /api/tasks.
 *
 * Nullable and string-valued fields reflect the persisted HTTP contract. They
 * intentionally differ from connector-facing TaskItem fields where storage can
 * contain legacy source values.
 */
export type TaskListItemDto = TaskListDomainFields & {
  localDisposition: LocalDisposition;
  status: string;
  taskSourceModel: TaskSourceModel;
  microStatus: string | null;
  priority: string;
  planningHorizon: PlanningHorizon | null;
  dueDate: string | null;
  sourceListId?: string | null;
  sourceListName: string | null;
  assignee: string | null;
  tags: TaskTagDto[];
  metadata: string | null;
  sourceId: string | null;
  effort?: number | null;
  estimatedDuration?: number | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  smartScore?: number | null;
  scoreBreakdown?: ScoreBreakdown | null;
  snoozedUntil?: string | null;
  reminderAt?: string | null;
  reminderRelative?: ReminderRelativeRule | null;
  reminderDueTime?: string | null;
  hubProjectIds?: string[];
  projectPhaseMemberships?: Array<{
    projectId: string;
    projectName: string;
    phaseId: string | null;
    phaseName: string | null;
  }>;
  linkedSourceCount?: number;
  hasDescription: boolean;
  editPolicy: TaskEditPolicy;
};

export interface TaskListStatsDto {
  totalOpen: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
  noDate: number;
  highPriority: number;
  assignedToMe: number;
  myDay: number;
  recentlyCreated: number;
  recentlyClosed: number;
  waiting: number;
  inbox: number;
}

export interface TaskListResponseDto {
  tasks: TaskListItemDto[];
  total: number;
  stats: TaskListStatsDto;
  hasMore: boolean;
  sourceCounts: Record<string, number>;
  availableTags: TaskTagDto[];
}

type HubProjectSummaryFields = Pick<
  HubProject,
  'id' | 'name' | 'color'
>;

export type KanbanColumnDto = Pick<KanbanColumn, 'id' | 'name' | 'color'> &
  Partial<Pick<KanbanColumn, 'order' | 'wipLimit'>> & {
    statusMapping?: string[];
    globalColumnMapping?: string;
  };

/** Serialized project summary returned by GET /api/hub-projects. */
export type HubProjectSummaryDto = HubProjectSummaryFields & {
  icon: string | null;
  kanbanColumns?: KanbanColumnDto[];
  hidden?: boolean;
  category?: string | null;
  metadata?: Record<string, unknown>;
  phases?: Array<{ id: string; name: string }>;
};

export interface HubProjectListResponseDto {
  projects: HubProjectSummaryDto[];
}

export type TaskMutationFieldsDto = Partial<
  Pick<
    TaskListItemDto,
    'title' | 'status' | 'priority' | 'dueDate' | 'localDisposition'
  >
>;

export interface ProjectDetailResponseDto<TProject> {
  project: TProject;
}
