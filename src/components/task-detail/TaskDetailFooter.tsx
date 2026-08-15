'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CheckCircle2, Loader2, MoreHorizontal, Sun, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskDetailMode } from './task-detail-types';

export interface TaskDetailFooterProps {
  mode: TaskDetailMode;
  createdAt: string;
  updatedAt: string;
}

/** Created and updated timestamps. */
export function TaskDetailFooter({ mode, createdAt, updatedAt }: TaskDetailFooterProps) {
  return (
    <div className={cn(
      'space-y-1 border-t border-[var(--border-subtle)] pt-3',
      (mode === 'panel' || mode === 'mobile') && 'order-9',
      mode === 'dialog' && 'col-span-2 row-start-9',
      mode === 'workspace' && 'col-span-3 row-start-7',
    )}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
        <p>
          Created {new Date(createdAt).toLocaleDateString()}
        </p>
        {updatedAt && (
          <p>
            Updated {new Date(updatedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}

export interface TaskMobileActionBarProps {
  /** Hides the complete action for closed tasks. */
  isClosed: boolean;
  canEditStatus: boolean;
  statusBlockedReason?: string;
  statusSaveLabel?: string;
  onComplete: () => void;
  isInMyDay: boolean;
  updatingMyDay: boolean;
  onToggleMyDay: () => void;
  canDeleteTask: boolean;
  deleteLabel: string;
  onDelete: () => void;
}

/** Sticky mobile action bar: complete, My Day, and the overflow menu. */
export function TaskMobileActionBar({
  isClosed,
  canEditStatus,
  statusBlockedReason,
  statusSaveLabel,
  onComplete,
  isInMyDay,
  updatingMyDay,
  onToggleMyDay,
  canDeleteTask,
  deleteLabel,
  onDelete,
}: TaskMobileActionBarProps) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-5 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-1)]/95 px-4 py-3 backdrop-blur">
      {!isClosed && (
        <button
          type="button"
          onClick={onComplete}
          disabled={!canEditStatus}
          title={!canEditStatus ? statusBlockedReason : statusSaveLabel}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--success)]/15 px-4 text-sm font-semibold text-[var(--success)]"
        >
          <CheckCircle2 size={17} />
          Complete
        </button>
      )}
      <button
        type="button"
        onClick={onToggleMyDay}
        disabled={updatingMyDay}
        className={cn(
          'flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium',
          isInMyDay
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
            : 'border-[var(--border)] text-[var(--text-secondary)]',
        )}
      >
        {updatingMyDay
          ? <Loader2 size={17} className="animate-spin" />
          : <Sun size={17} fill={isInMyDay ? 'currentColor' : 'none'} />}
        My Day
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={!canDeleteTask}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="More task actions"
            title={canDeleteTask ? undefined : 'No additional actions available'}
          >
            <MoreHorizontal size={18} />
          </button>
        </DropdownMenu.Trigger>
        {canDeleteTask && (
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              side="top"
              sideOffset={6}
              className="z-[130] min-w-48 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-2xl"
            >
              <DropdownMenu.Item
                onSelect={onDelete}
                className="flex min-h-11 cursor-default items-center gap-2 rounded-lg px-3 text-sm text-red-400 outline-none focus:bg-red-500/10"
              >
                <Trash2 size={16} />
                {deleteLabel}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </DropdownMenu.Root>
    </div>
  );
}
