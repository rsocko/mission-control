'use client';

import { useCallback } from 'react';
import {
  TaskDetailPanel as SharedTaskDetailPanel,
  type TaskFieldUpdate,
} from '@/components/task-detail/TaskDetailPanel';
import type { Task } from './types';

interface TaskDetailPanelProps {
  task: Task | null;
  onClose: () => void;
  onTaskUpdate?: (taskId: string, fields: Partial<Task>) => void;
  onRefresh?: () => void | Promise<void>;
}

export function TaskDetailPanel({
  task,
  onClose,
  onTaskUpdate,
  onRefresh,
}: TaskDetailPanelProps) {
  const handleUpdate = useCallback((fields?: TaskFieldUpdate) => {
    if (!task) return;
    if (!fields) {
      void onRefresh?.();
      return;
    }

    const updates: Partial<Task> = {};
    if (typeof fields.title === 'string') updates.title = fields.title;
    if (typeof fields.description === 'string' || fields.description === null) {
      updates.description = fields.description;
    }
    if (typeof fields.status === 'string') updates.status = fields.status;
    if (typeof fields.priority === 'string') updates.priority = fields.priority;
    if (typeof fields.dueDate === 'string' || fields.dueDate === null) {
      updates.dueDate = fields.dueDate;
    }
    if (typeof fields.estimatedDuration === 'number' || fields.estimatedDuration === null) {
      updates.estimatedDuration = fields.estimatedDuration;
    }
    if (typeof fields.metadata === 'string' || fields.metadata === null) {
      updates.metadata = fields.metadata;
    }
    if (Object.keys(updates).length > 0) {
      onTaskUpdate?.(task.id, updates);
    }
  }, [onRefresh, onTaskUpdate, task]);

  if (!task) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed right-0 top-0 z-[51] flex h-full">
        <SharedTaskDetailPanel
          taskId={task.id}
          mode="panel"
          onClose={onClose}
          onUpdate={handleUpdate}
          availableTags={task.tags.map((tag) => ({ ...tag, slug: tag.name }))}
          onSubtaskCountChange={(done, total) => {
            onTaskUpdate?.(task.id, { subtaskDone: done, subtaskTotal: total });
          }}
          minPanelWidth={420}
          focusPanelOnMount
          portalDialog
        />
      </div>
    </>
  );
}
