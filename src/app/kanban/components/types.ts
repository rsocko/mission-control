import type {
  HubProjectSummaryDto,
  KanbanColumnDto,
  TaskListItemDto,
  TaskTagDto,
} from '@/types/api';

export type KanbanTaskTagViewModel = Pick<TaskTagDto, 'id' | 'name' | 'color'>;

export type KanbanTaskViewModel = Pick<
  TaskListItemDto,
  | 'id'
  | 'title'
  | 'status'
  | 'priority'
  | 'dueDate'
  | 'connectorType'
  | 'sourceListName'
  | 'localDisposition'
  | 'taskSourceModel'
  | 'editPolicy'
> & {
  description?: string | null;
  connectorInstanceId?: string | null;
  sourceId?: string | null;
  sourceListId?: string | null;
  kanbanColumn?: string | null;
  kanbanOrder?: number | null;
  tags: KanbanTaskTagViewModel[];
  metadata?: string | null;
  estimatedDuration?: number | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  smartScore?: number | null;
  snoozedUntil?: string | null;
};

export interface SourceItem {
  id: string;
  name: string;
  icon: string;
  type: 'connector' | 'list';
  connectorType: string;
  /** For lists, the connector instance that owns it */
  connectorInstanceId?: string;
  selectedForSync?: boolean;
}

export type KanbanColumnViewModel = KanbanColumnDto;

export type KanbanProjectViewModel = Pick<
  HubProjectSummaryDto,
  'id' | 'name' | 'color' | 'icon'
> & {
  kanbanColumns: KanbanColumnViewModel[];
};

export function toKanbanProjectViewModel(
  project: HubProjectSummaryDto,
): KanbanProjectViewModel {
  return {
    ...project,
    kanbanColumns: project.kanbanColumns ?? [],
  };
}
