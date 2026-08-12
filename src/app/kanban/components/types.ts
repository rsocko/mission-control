export interface TaskTag {
  id: string;
  name: string;
  color: string | null;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId?: string | null;
  sourceId?: string | null;
  sourceListId: string | null;
  sourceListName: string | null;
  kanbanColumn: string | null;
  kanbanOrder: number | null;
  tags: TaskTag[];
  metadata?: string | null;
  estimatedDuration?: number | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  smartScore?: number | null;
  snoozedUntil?: string | null;
  localDisposition: import('@/types').LocalDisposition;
  taskSourceModel: import('@/types').TaskSourceModel;
  editPolicy: TaskEditPolicy;
}

export interface SourceItem {
  id: string;
  name: string;
  icon: string;
  type: 'connector' | 'list';
  connectorType: string;
  /** For lists, the connector instance that owns it */
  connectorInstanceId?: string;
}

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  order?: number;
  statusMapping?: string[];
  globalColumnMapping?: string;
  wipLimit?: number;
}

export interface HubProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  kanbanColumns: KanbanColumn[];
}
import type { TaskEditPolicy } from '@/types';
