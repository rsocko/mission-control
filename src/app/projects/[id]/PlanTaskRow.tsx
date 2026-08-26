'use client';

import { GripVertical } from 'lucide-react';
import { TaskContextMenu, type HubProject, type TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import { TaskRow } from '@/components/task-list/TaskRow';
import { cn } from '@/lib/utils';
import type { ProjectTaskViewModel as ProjectTask } from './types';

interface PlanTaskRowProps {
  task: ProjectTask;
  variant?: 'card' | 'compact';
  dragHandleProps: Record<string, unknown>;
  dragLabel: string;
  dragEnabled?: boolean;
  isSelected: boolean;
  isCompleting: boolean;
  bulkMode?: boolean;
  bulkSelected?: boolean;
  onBulkToggle?: () => void;
  onSelect: (taskId: string) => void;
  onDoubleClick: (taskId: string) => void;
  onModifierClick?: (
    taskId: string,
    event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void;
  onComplete: (taskId: string) => void;
  isInMyDay: boolean;
  contextMenuActions: TaskContextMenuActions;
  phaseMenuItems: { id: string; name: string }[];
  projects: HubProject[];
}

export function PlanTaskRow({
  task,
  variant = 'card',
  dragHandleProps,
  dragLabel,
  dragEnabled = true,
  isSelected,
  isCompleting,
  bulkMode = false,
  bulkSelected = false,
  onBulkToggle,
  onSelect,
  onDoubleClick,
  onModifierClick,
  onComplete,
  isInMyDay,
  contextMenuActions,
  phaseMenuItems,
  projects,
}: PlanTaskRowProps) {
  const compact = variant === 'compact';

  return (
    <TaskContextMenu
      task={{
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        connectorType: task.connectorType,
        sourceId: task.sourceId,
        dueDate: task.dueDate ?? null,
        localDisposition: task.localDisposition,
        taskSourceModel: task.taskSourceModel,
        editPolicy: task.editPolicy,
      }}
      isInMyDay={isInMyDay}
      projectPhases={phaseMenuItems}
      projects={projects}
      taskProjectIds={task.hubProjectIds}
      taskProjectPhaseMemberships={task.projectPhaseMemberships}
      actions={contextMenuActions}
    >
      <TaskRow
        task={task}
        surface="plan"
        variant={variant}
        compact={compact}
        leading={(
          <button
            type="button"
            {...dragHandleProps}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
              compact ? 'min-h-6 min-w-6' : 'min-h-8 min-w-8',
              dragEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-default opacity-0',
            )}
            aria-label={dragLabel}
            onClick={(event) => event.stopPropagation()}
            tabIndex={dragEnabled ? 0 : -1}
          >
            <GripVertical size={compact ? 12 : 14} />
          </button>
        )}
        className={cn(
          compact
            ? 'gap-2 rounded-[var(--radius-sm)] px-2 hover:bg-[var(--surface-1)]'
            : 'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] hover:bg-[var(--surface-1)]',
          isSelected && !bulkMode && !compact && 'border-[var(--accent-400)]',
          bulkSelected && !compact && 'border-blue-500/30',
        )}
        onComplete={() => onComplete(task.id)}
        onSetDueDate={(date) => {
          if (date) contextMenuActions.onPickDate(date);
          else contextMenuActions.onClearDueDate?.();
        }}
        onSetPriority={contextMenuActions.onSetPriority}
        onSetStatus={(status) => contextMenuActions.onSetStatus?.(status)}
        onSetLocalDisposition={(disposition) => (
          contextMenuActions.onSetLocalDisposition?.(disposition)
        )}
        onOpenNotes={() => onDoubleClick(task.id)}
        onAddToMyDay={() => contextMenuActions.onAddToMyDay?.()}
        onRemoveFromMyDay={() => contextMenuActions.onRemoveFromMyDay?.()}
        isInMyDay={isInMyDay}
        bulkMode={bulkMode}
        bulkSelected={bulkSelected}
        onBulkToggle={onBulkToggle}
        isCompleting={isCompleting}
        isSelected={isSelected && !bulkMode}
        onSelect={onSelect}
        onDoubleClickTask={onDoubleClick}
        onModifierClick={onModifierClick}
        filterController={false}
      />
    </TaskContextMenu>
  );
}
