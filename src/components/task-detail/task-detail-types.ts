import type {
  LocalDisposition,
  TaskEditPolicy,
  TaskStatus,
  TaskSourceModel,
} from '@/types';
import type { ReminderRelativeRule } from '@/lib/tasks/relative-reminder';

/** A tag that can be displayed on, added to, or removed from a task. */
export interface TaskTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

/** Tag-related capabilities reported by the task's connector. */
export interface TagConnectorCaps {
  tagWriteBack: boolean;
  tagCreationMode: 'freeform' | 'predefined';
  tagScope: 'global' | 'per-list';
}

/** Minimal subtask shape the panel tracks for counts and the subtask section. */
export interface Subtask {
  id: string;
  title: string;
  status: string;
}

/** Full task record backing the detail panel. */
export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  microStatus: string | null;
  statusReason: string | null;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  projectIds: string[];
  subtasks: Subtask[];
  metadata: string | null;
  estimatedDuration?: number | null;
  recurrence?: string | null;
  recurrenceMode?: 'schedule' | 'completion';
  effort?: number | null;
  reminderAt?: string | null;
  reminderRelative?: ReminderRelativeRule | null;
  reminderDueTime?: string | null;
  reminderTimezone?: string;
  snoozedUntil?: string | null;
  isInMyDay?: boolean;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  editPolicy: TaskEditPolicy;
  supportedStatusValues?: TaskStatus[];
}

/** A list within the task's own source, used for same-source moves. */
export interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
}

/** Partial field payload reported back to hosts after a successful save. */
export interface TaskFieldUpdate {
  [key: string]: string | number | null | undefined;
}

/** A Mission Control hub project a task can be assigned to. */
export interface HubProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  category?: string | null;
  hidden?: boolean;
}

/** A connector instance that accepts newly created tasks. */
export interface WritableConnector {
  id: string;
  type: string;
  name: string;
}

/** Surface the panel is rendered in. */
export type TaskDetailMode = 'panel' | 'dialog' | 'workspace' | 'mobile';

/** Host request to open the expanded notes dialog for a task. */
export interface TaskNotesOpenRequest {
  requestId: number;
  taskId: string;
  mode: 'read' | 'edit';
}

/** Host request to reveal the Subtasks section after a task loads. */
export interface TaskSubtasksOpenRequest {
  requestId: number;
  taskId: string;
}

/** State backing the shared confirmation dialog. */
export interface TaskConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
  alternateLabel?: string;
  onAlternate?: () => void;
}

/** An AI-suggested micro-status for the task. */
export interface MicroStatusSuggestion {
  status: string;
  reason: string;
}

/** Metadata fields the panel reads out of a task's JSON metadata blob. */
export interface TaskDetailMetadata {
  previewUrl?: string;
  previewType?: 'pdf' | 'iframe' | 'external' | 'image';
  previewLabel?: string;
  documentUrl?: string;
  documentTitle?: string;
  documentType?: string;
  documentId?: string | number;
  docHubUrl?: string;
  correspondent?: string;
  amount?: number;
  actionType?: string;
  urgency?: string;
  owlStatus?: string;
  owlDisposition?: string;
  owlSnoozedUntil?: string;
  owlUpdatedAt?: string;
  recurrence?: string;
  linkedResources?: Array<{
    id?: string;
    applicationName?: string;
    displayName?: string;
    webUrl?: string;
  }>;
}

export interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
  onUpdate?: (fields?: TaskFieldUpdate) => void;
  onSubtaskCountChange?: (done: number, total: number) => void;
  availableTags?: TaskTag[];
  mode?: TaskDetailMode;
  onModeChange?: (mode: Exclude<TaskDetailMode, 'mobile'>) => void;
  isInMyDay?: boolean;
  onToggleMyDay?: () => void | Promise<void>;
  sourceLists?: SourceList[];
  onMoveToList?: (targetListId: string) => void;
  /** Let a host preserve its completion workflow, such as Today undo and events. */
  onComplete?: () => void | Promise<void>;
  /** Let a host preserve its deletion confirmation and undo workflow. */
  onDelete?: () => void | Promise<void>;
  autoOpenMoveDialog?: boolean;
  /** Called when the move dialog auto-opened via autoOpenMoveDialog is dismissed */
  onMoveDialogDismissed?: () => void;
  /** Disable the panel's own entrance animation when a parent transition owns it. */
  animatePanel?: boolean;
  /** Render dialog mode outside an ancestor that creates a containing block. */
  portalDialog?: boolean;
  /** Override the minimum resizable width when a host surface requires more coverage. */
  minPanelWidth?: number;
  /** Fill a host-owned pane instead of using the user's global side-panel width. */
  fillContainer?: boolean;
  /** Additional responsive visibility classes for the embedded document preview. */
  documentPreviewClassName?: string;
  /** Move keyboard focus into the panel when it opens. */
  focusPanelOnMount?: boolean;
  /** Open the existing expanded Notes dialog after the requested task loads. */
  notesOpenRequest?: TaskNotesOpenRequest | null;
  /** Scroll the side panel to Subtasks after the requested task loads. */
  subtasksOpenRequest?: TaskSubtasksOpenRequest | null;
}

/** Parse a task's metadata blob, tolerating absent or malformed JSON. */
export function parseTaskMetadata(
  metadata: string | Record<string, unknown> | null | undefined,
): TaskDetailMetadata {
  if (!metadata) return {};
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as TaskDetailMetadata;
  }
  if (typeof metadata !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed as TaskDetailMetadata : {};
  } catch {
    return {};
  }
}
