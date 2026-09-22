/**
 * Cross-source field mapping engine.
 *
 * Computes how fields will be mapped or preserved when moving/copying a task
 * from one connector type to another. Returns a list of field mapping entries
 * and an overall warning level so the UI can surface unavoidable loss before
 * executing a move.
 */

export type FieldMappingStatus = 'mapped' | 'converted' | 'lossy' | 'dropped';

export interface FieldMapping {
  field: string;
  status: FieldMappingStatus;
  sourceValue: string | null;
  targetValue: string | null;
  warning?: string;
}

export type SubtaskStrategy =
  | 'move-as-subtasks'
  | 'flatten-to-checklist'
  | 'preserve-details-and-steps';

export interface SubtaskMappingInfo {
  count: number;
  strategy: SubtaskStrategy;
  warning?: string;
}

export interface FieldMappingResult {
  fieldMappings: FieldMapping[];
  subtasks: SubtaskMappingInfo | null;
  hasLossyFields: boolean;
  /** Whether the source connector supports true deletion (affects move semantics). */
  sourceSupportsDelete: boolean;
}

// Connectors that support native task deletion (not just close/cancel)
const CONNECTORS_WITH_DELETE = new Set(['local', 'microsoft-todo', 'custom-rest']);

// Connectors that support a native due date field
const CONNECTORS_WITH_DUE_DATE = new Set(['microsoft-todo', 'custom-rest']);

// Connectors that have a structured priority field
const CONNECTORS_WITH_PRIORITY = new Set(['microsoft-todo', 'custom-rest']);

// Connectors that support effort through a native field or canonical labels
const CONNECTORS_WITH_EFFORT = new Set(['github-issues']);

// Connectors that support recurrence on the remote task
const CONNECTORS_WITH_RECURRENCE = new Set(['microsoft-todo']);

// Connectors that support subtasks (as nested items in the same source)
const CONNECTORS_WITH_SUBTASKS = new Set(['microsoft-todo', 'github-issues', 'custom-rest']);

// Connectors that have rich subtask metadata (i.e. subtasks are first-class objects with all fields)
const CONNECTORS_WITH_RICH_SUBTASKS = new Set(['local', 'github-issues', 'custom-rest']);

/**
 * Compute field mappings for moving a task between two connector types.
 *
 * @param sourceType - The connector type of the source (e.g. 'microsoft-todo')
 * @param targetType - The connector type of the target (e.g. 'github-issues')
 * @param task - Snapshot of the task's current field values
 * @param subtaskCount - Number of direct subtasks the source task has
 */
export function computeFieldMappings(
  sourceType: string,
  targetType: string,
  task: {
    title: string;
    description?: string | null;
    priority?: string | null;
    dueDate?: string | null;
    tags?: { name: string }[];
    assignee?: string | null;
    status?: string;
    statusReason?: string | null;
    planningHorizon?: string | null;
    effort?: number | null;
    microStatus?: string | null;
    kanbanColumn?: string | null;
    reminderAt?: string | null;
    snoozedUntil?: string | null;
    recurrence?: string | null;
    estimatedDuration?: number | null;
    scheduledDate?: string | null;
    scheduledTime?: string | null;
    isTimeBlocked?: boolean | null;
    projectCount?: number;
  },
  subtaskCount = 0,
  attachmentCount = 0,
  targetSupportsAttachments = false,
): FieldMappingResult {
  const mappings: FieldMapping[] = [];

  // ── Title (always maps 1:1) ──────────────────────────────────────────────
  mappings.push({
    field: 'title',
    status: 'mapped',
    sourceValue: task.title,
    targetValue: task.title,
  });

  // ── Description / body ───────────────────────────────────────────────────
  if (task.description) {
    const formattingMayDiffer =
      (sourceType === 'microsoft-todo' && targetType === 'github-issues') ||
      (sourceType === 'github-issues' && targetType === 'microsoft-todo');

    if (formattingMayDiffer) {
      mappings.push({
        field: 'description',
        status: 'mapped',
        sourceValue: task.description,
        targetValue: task.description,
        warning: 'Description content will be preserved verbatim; formatting may render differently in the target.',
      });
    } else {
      mappings.push({
        field: 'description',
        status: 'mapped',
        sourceValue: task.description,
        targetValue: task.description,
      });
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────
  if (task.status && task.status !== 'todo') {
    const terminal = task.status === 'done' || task.status === 'cancelled';
    mappings.push({
      field: 'status',
      status: 'converted',
      sourceValue: task.status,
      targetValue: terminal ? 'completed / closed' : 'open',
      warning: terminal
        ? `Status "${task.status}" will be applied after the destination task is created.`
        : `Status "${task.status}" will be preserved in Mission Control; the destination task will be open.`,
    });
  }

  // ── Priority ─────────────────────────────────────────────────────────────
  if (task.priority && task.priority !== 'none') {
    const targetHasPriority = CONNECTORS_WITH_PRIORITY.has(targetType);
    if (targetHasPriority) {
      mappings.push({
        field: 'priority',
        status: 'mapped',
        sourceValue: task.priority,
        targetValue: task.priority,
      });
    } else if (targetType === 'github-issues') {
      const labelName = priorityToGitHubLabel(task.priority);
      mappings.push({
        field: 'priority',
        status: 'converted',
        sourceValue: task.priority,
        targetValue: labelName ? `label: ${labelName}` : '(kept in Mission Control)',
        warning: labelName
          ? `Priority "${task.priority}" will be converted to a GitHub label "${labelName}".`
          : `Priority "${task.priority}" has no GitHub label equivalent and will be kept in Mission Control.`,
      });
    } else {
      mappings.push({
        field: 'priority',
        status: 'converted',
        sourceValue: task.priority,
        targetValue: `(kept in Mission Control)`,
        warning: `Priority is not supported by ${targetType} — it will be kept in Mission Control but not synced to the source.`,
      });
    }
  }

  // ── Due date ─────────────────────────────────────────────────────────────
  if (task.dueDate) {
    if (CONNECTORS_WITH_DUE_DATE.has(targetType)) {
      mappings.push({
        field: 'dueDate',
        status: 'mapped',
        sourceValue: task.dueDate,
        targetValue: task.dueDate,
      });
    } else {
      mappings.push({
        field: 'dueDate',
        status: 'converted',
        sourceValue: task.dueDate,
        targetValue: `(kept in Mission Control)`,
        warning: `Due date is not natively supported by ${targetType} — it will be kept in Mission Control but not synced to the source.`,
      });
    }
  }

  // ── Tags / labels ────────────────────────────────────────────────────────
  const sourceTags = task.tags ?? [];
  if (sourceTags.length > 0) {
    const tagNames = sourceTags.map((t) => t.name).join(', ');
    mappings.push({
      field: 'tags',
      status: 'converted',
      sourceValue: tagNames,
      targetValue: tagNames,
      warning: 'Tags will be written to the target when supported and preserved in Mission Control.',
    });
  }

  // ── Assignee ─────────────────────────────────────────────────────────────
  if (task.assignee) {
    mappings.push({
      field: 'assignee',
      status: 'converted',
      sourceValue: task.assignee,
      targetValue: `${task.assignee} (kept in Mission Control)`,
      warning:
        'The assignee will be preserved in Mission Control and applied remotely when the same identity exists.',
    });
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  if (attachmentCount > 0) {
    mappings.push({
      field: 'attachments',
      status: targetSupportsAttachments ? 'mapped' : 'converted',
      sourceValue: `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`,
      targetValue: targetSupportsAttachments
        ? `uploaded to ${targetType}`
        : '(kept in Mission Control)',
      warning: targetSupportsAttachments
        ? 'Attachments will be copied before the source task is removed.'
        : `${targetType} cannot store attachments; their content will remain available in Mission Control.`,
    });
  }

  // ── Effort ───────────────────────────────────────────────────────────────
  if (task.effort) {
    if (CONNECTORS_WITH_EFFORT.has(targetType)) {
      mappings.push({
        field: 'effort',
        status: 'converted',
        sourceValue: String(task.effort),
        targetValue: `label: effort:${task.effort}`,
        warning: `Effort ${task.effort} will be synced as the GitHub label "effort:${task.effort}".`,
      });
    } else {
      mappings.push({
        field: 'effort',
        status: 'converted',
        sourceValue: String(task.effort),
        targetValue: '(kept in Mission Control)',
        warning: `Effort is not natively supported by ${targetType} — it will be kept in Mission Control.`,
      });
    }
  }

  // ── Mission Control planning fields ──────────────────────────────────────
  addMissionControlOnlyMapping(mappings, 'microStatus', task.microStatus);
  addMissionControlOnlyMapping(mappings, 'statusReason', task.statusReason);
  addMissionControlOnlyMapping(mappings, 'planningHorizon', task.planningHorizon);
  addMissionControlOnlyMapping(mappings, 'kanbanColumn', task.kanbanColumn);
  addMissionControlOnlyMapping(mappings, 'reminderAt', task.reminderAt);
  addMissionControlOnlyMapping(mappings, 'snoozedUntil', task.snoozedUntil);
  addMissionControlOnlyMapping(mappings, 'estimatedDuration', task.estimatedDuration);
  addMissionControlOnlyMapping(mappings, 'scheduledDate', task.scheduledDate);
  addMissionControlOnlyMapping(mappings, 'scheduledTime', task.scheduledTime);
  if (task.isTimeBlocked) {
    addMissionControlOnlyMapping(mappings, 'timeBlock', 'yes');
  }
  if (task.projectCount) {
    mappings.push({
      field: 'projects',
      status: 'mapped',
      sourceValue: `${task.projectCount} project${task.projectCount === 1 ? '' : 's'}`,
      targetValue: '(preserved in Mission Control)',
    });
  }

  if (task.recurrence && task.recurrence !== 'none') {
    if (CONNECTORS_WITH_RECURRENCE.has(targetType)) {
      mappings.push({
        field: 'recurrence',
        status: 'mapped',
        sourceValue: task.recurrence,
        targetValue: task.recurrence,
      });
    } else {
      addMissionControlOnlyMapping(mappings, 'recurrence', task.recurrence);
    }
  }

  // ── Subtasks ─────────────────────────────────────────────────────────────
  let subtaskInfo: SubtaskMappingInfo | null = null;
  if (subtaskCount > 0) {
    const targetSupportsSubtasks = CONNECTORS_WITH_SUBTASKS.has(targetType);
    const targetHasRichSubtasks = CONNECTORS_WITH_RICH_SUBTASKS.has(targetType);
    const sourceHasRichSubtasks = CONNECTORS_WITH_RICH_SUBTASKS.has(sourceType);

    if (targetSupportsSubtasks) {
      // Determine the best strategy based on capabilities
      let strategy: SubtaskStrategy;
      let warning: string | undefined;

      if (targetHasRichSubtasks) {
        // GitHub sub-issues can hold full task data
        strategy = 'move-as-subtasks';
        if (!sourceHasRichSubtasks) {
          warning = `${subtaskCount} checklist item(s) will be created as GitHub sub-issues with all available source data.`;
        }
      } else {
        // Preserve rich subtask data in the parent body when the target only
        // supports title/completion checklist items.
        strategy = sourceHasRichSubtasks ? 'preserve-details-and-steps' : 'move-as-subtasks';
        if (sourceHasRichSubtasks) {
          warning = `${subtaskCount} subtask(s) will become Microsoft To Do steps, with additional details also preserved in the task notes.`;
        }
      }

      subtaskInfo = { count: subtaskCount, strategy, warning };
    } else {
      subtaskInfo = {
        count: subtaskCount,
        strategy: 'flatten-to-checklist',
        warning: `${subtaskCount} subtask(s) will be embedded in the destination description with their metadata preserved (${targetType} does not support subtasks).`,
      };
    }
  }

  const hasLossyFields = mappings.some((m) => m.status === 'lossy' || m.status === 'dropped');

  return {
    fieldMappings: mappings,
    subtasks: subtaskInfo,
    hasLossyFields,
    sourceSupportsDelete: CONNECTORS_WITH_DELETE.has(sourceType),
  };
}

function addMissionControlOnlyMapping(
  mappings: FieldMapping[],
  field: string,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined || value === '') return;
  const label = field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  mappings.push({
    field,
    status: 'converted',
    sourceValue: String(value),
    targetValue: '(kept in Mission Control)',
    warning: `${label} is a Mission Control field and will be preserved locally on the destination task.`,
  });
}

/**
 * Map a Mission Control priority to a conventional GitHub label name.
 * Returns null if no standard label applies.
 */
export function priorityToGitHubLabel(priority: string): string | null {
  switch (priority) {
    case 'critical': return 'priority:critical';
    case 'high':     return 'priority:high';
    case 'medium':   return 'priority:medium';
    case 'low':      return 'priority:low';
    default:         return null;
  }
}

/**
 * Determine whether a GitHub→GitHub move qualifies for the native Transfer API.
 * Returns true when both source and target repos share the same GitHub owner.
 */
export function isGitHubNativeTransfer(
  sourceConnectorType: string,
  targetConnectorType: string,
  sourceListId: string,
  targetListId: string,
): boolean {
  if (sourceConnectorType !== 'github-issues' || targetConnectorType !== 'github-issues') {
    return false;
  }
  const sourceOwner = sourceListId.split('/')[0];
  const targetOwner = targetListId.split('/')[0];
  return !!sourceOwner && sourceOwner === targetOwner;
}

/**
 * Build the cross-reference note that gets appended to the source task on copy.
 */
export function buildCrossReferenceNote(
  direction: 'source' | 'target',
  peerConnectorType: string,
  peerListName: string,
  peerTaskTitle: string,
): string {
  const emoji = '🔗';
  if (direction === 'source') {
    return `${emoji} A linked copy of this task was created in ${displayName(peerConnectorType)} › ${peerListName}.`;
  } else {
    return `${emoji} This task was copied from ${displayName(peerConnectorType)} › ${peerListName}. Original: "${peerTaskTitle}"`;
  }
}

function displayName(connectorType: string): string {
  switch (connectorType) {
    case 'microsoft-todo': return 'Microsoft To Do';
    case 'github-issues':  return 'GitHub Issues';
    case 'custom-rest':    return 'Custom REST';
    default:               return connectorType;
  }
}
