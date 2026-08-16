'use client';

import { cn } from '@/lib/utils';
import { TaskAttachmentSection } from './TaskAttachmentSection';
import type { TaskDetailMode } from './task-detail-types';

export interface TaskAttachmentCardProps {
  mode: TaskDetailMode;
  taskId: string;
  /** Whether attachments may be added or removed. */
  canEdit: boolean;
  /** Whether the connector stores attachments at all. */
  supportsAttachments: boolean;
  connectorType: string;
  sourceUrl: string | null;
  /** Bumped after a paste upload so the list refetches. */
  refreshKey: number;
}

/** Positioned card wrapper around the shared attachment list. */
export function TaskAttachmentCard({
  mode,
  taskId,
  canEdit,
  supportsAttachments,
  connectorType,
  sourceUrl,
  refreshKey,
}: TaskAttachmentCardProps) {
  return (
    <div className={cn(
      'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
      (mode === 'panel' || mode === 'mobile') && 'order-8',
      mode === 'dialog' && 'col-span-2 row-start-8',
      mode === 'workspace' && 'col-start-3 row-start-5',
    )}>
      <TaskAttachmentSection
        taskId={taskId}
        canEdit={canEdit}
        supportsAttachments={supportsAttachments}
        connectorType={connectorType}
        sourceUrl={sourceUrl}
        refreshKey={refreshKey}
      />
    </div>
  );
}
