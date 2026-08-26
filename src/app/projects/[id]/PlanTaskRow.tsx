'use client';

import { GripVertical } from 'lucide-react';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import { TaskContextMenu, type HubProject, type TaskContextMenuActions } from '@/components/task-list/TaskContextMenu';
import { TaskRowIdentity } from '@/components/task-list/TaskRowIdentity';
import { TaskStatusIndicator } from '@/components/task-list/TaskStatusIndicator';
import { EffortBadge } from '@/components/EffortBadge';
import { createTaskRowInteractionHandlers } from '@/lib/tasks/task-row-interactions';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { cn } from '@/lib/utils';
import { PriorityDot, TaskStatusBadge } from './components';
import { PRIORITY_LABELS } from './constants';
import type { ProjectTaskViewModel as ProjectTask } from './types';
import { formatDateLabel } from './utils';

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
  const isDone = task.status === 'done' || isCompleting;
  const isInactive = isInactiveTaskStatus(task.status) || isCompleting;

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
      <div
        data-task-row-surface="plan"
        data-task-row-variant={variant}
        data-task-id={task.id}
        className={cn(
          '@container flex cursor-pointer items-center transition-colors hover:bg-[var(--surface-1)]',
          compact
            ? 'gap-2 rounded-[var(--radius-sm)] px-2 py-1.5'
            : 'flex-wrap gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 sm:flex-nowrap',
          isSelected && !bulkMode && (
            compact
              ? 'bg-[var(--surface-1)] ring-1 ring-[var(--accent-400)]'
              : 'border-[var(--accent-400)] ring-1 ring-[var(--accent-400)]'
          ),
          bulkSelected && 'border-blue-500/30 bg-blue-900/20',
          isInactive && 'opacity-50',
        )}
        {...createTaskRowInteractionHandlers({
          taskId: task.id,
          bulkMode,
          onSelect,
          onDoubleClick,
          onModifierClick,
          onBulkClick: onBulkToggle,
        })}
      >
        {bulkMode ? (
          <label className="flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={bulkSelected}
              onChange={onBulkToggle}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Select ${task.title}`}
              className="h-4 w-4 cursor-pointer rounded border-[var(--border-strong)] accent-[var(--accent-500)]"
            />
          </label>
        ) : (
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

        <CompletionBurst celebrating={isCompleting}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onComplete(task.id);
            }}
            disabled={isCompleting}
            className={cn(
              'group/status flex shrink-0 items-center justify-center',
              compact ? 'h-[14px] w-[14px]' : 'h-[18px] w-[18px]',
            )}
            aria-label={isDone ? 'Completed' : 'Mark complete'}
          >
            <TaskStatusIndicator
              status={task.status}
              microStatus={task.microStatus}
              isCompleting={isCompleting}
              size={compact ? 'sm' : 'md'}
              className={compact ? undefined : 'scale-90'}
            />
          </button>
        </CompletionBurst>

        <TaskRowIdentity
          task={task}
          isDone={isDone}
          compact={compact}
          beforeTitle={<PriorityDot priority={task.priority} />}
          afterTitle={compact ? null : <EffortBadge effort={task.effort ?? null} size="sm" />}
          showMicroStatusLabel={!compact}
          showSubtasks={!compact}
          secondary={compact ? null : (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--text-tertiary)]">
              <span>{PRIORITY_LABELS[task.priority]}</span>
              <span aria-hidden="true">•</span>
              <span>{task.sourceListName || task.connectorType}</span>
              {task.dueDate ? (
                <>
                  <span aria-hidden="true">•</span>
                  <span>Due {formatDateLabel(task.dueDate)}</span>
                </>
              ) : null}
            </div>
          )}
        />

        {!compact ? (
          <TaskStatusBadge status={task.status} statusReason={task.statusReason} />
        ) : null}
      </div>
    </TaskContextMenu>
  );
}
