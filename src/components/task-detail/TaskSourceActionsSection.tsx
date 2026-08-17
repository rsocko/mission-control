'use client';

import Image from 'next/image';
import { Archive, ArrowLeftRight, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import type { DeepLinkInfo } from '@/lib/utils/deep-links';
import type { LocalDisposition } from '@/types';
import { cn } from '@/lib/utils';
import { MoveToListDropdown } from './MoveToListDropdown';
import type { SourceList, TaskDetailMode } from './task-detail-types';

/** One Mission Control disposition the task can be switched to. */
export interface TaskDispositionOption {
  value: LocalDisposition;
  label: string;
  detail: string;
}

export interface TaskSourceActionsSectionProps {
  mode: TaskDetailMode;
  /** Dispositions the current policy allows switching to. */
  dispositionOptions: readonly TaskDispositionOption[];
  updatingDisposition: boolean;
  onDispositionChange: (disposition: LocalDisposition) => void;
  /** Lists inside the task's own source that it can be moved to. */
  sameSourceLists: SourceList[];
  currentSourceListId: string | null;
  /** Omitted when the host does not support same-source moves. */
  onMoveToList?: (targetListId: string) => void;
  supportsMoveToList: boolean;
  /** Whether any connector can accept a cross-source move. */
  hasWritableConnectors: boolean;
  onOpenMoveDialog: () => void;
  /** Deep link to the upstream task, when the connector exposes one. */
  deepLink: DeepLinkInfo | null;
  canDeleteTask: boolean;
  deleteLabel: string;
  onDelete: () => void;
}

/** Source-level actions: disposition, moves, deep link, and deletion. */
export function TaskSourceActionsSection({
  mode,
  dispositionOptions,
  updatingDisposition,
  onDispositionChange,
  sameSourceLists,
  currentSourceListId,
  onMoveToList,
  supportsMoveToList,
  hasWritableConnectors,
  onOpenMoveDialog,
  deepLink,
  canDeleteTask,
  deleteLabel,
  onDelete,
}: TaskSourceActionsSectionProps) {
  const showDelete = canDeleteTask && mode !== 'mobile';
  const showMoveToList = supportsMoveToList && Boolean(onMoveToList);
  const hasAnyAction = dispositionOptions.length > 0
    || showMoveToList
    || hasWritableConnectors
    || Boolean(deepLink)
    || showDelete;
  if (!hasAnyAction) return null;

  return (
    <section className={cn(
      'overflow-visible rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
      (mode === 'panel' || mode === 'mobile') && 'order-7',
      mode === 'dialog' && 'col-start-2 row-start-4',
      mode === 'workspace' && 'col-start-2 row-start-4',
    )}>
      <h3 className="border-b border-[var(--border-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--text-secondary)]">Source &amp; actions</h3>
      <div className="flex flex-wrap items-center gap-2 p-3">
        {dispositionOptions.length > 0 && (
          <div className="w-full rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-2.5">
            <div className="mb-2 flex items-start gap-2">
              <Archive size={14} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-emerald-300">Mission Control state</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Hide or restore this task locally. The upstream task is unchanged.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {dispositionOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={updatingDisposition}
                  onClick={() => onDispositionChange(option.value)}
                  title={option.detail}
                  aria-label={`${option.label}. ${option.detail}`}
                  className="min-h-9 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
                >
                  {updatingDisposition ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Move to list */}
        {showMoveToList && onMoveToList && (
          <MoveToListDropdown
            sourceLists={sameSourceLists}
            currentSourceListId={currentSourceListId}
            onMoveToList={onMoveToList}
          />
        )}

        {/* Move to source (cross-source) — always available, even for read-only connectors */}
        {hasWritableConnectors && (
          <div className="flex items-center">
            <button
              onClick={onOpenMoveDialog}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
            >
              <ArrowLeftRight size={13} />
              Move source
            </button>
          </div>
        )}

        {/* Source link */}
        {deepLink && (
          <div className="flex items-center">
            <Tooltip content={`Open in ${deepLink.label}`}>
              <a
                href={deepLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-blue-500/10 px-2.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300"
              >
                <Image src={deepLink.icon} alt={deepLink.label} width={14} height={14} className="flex-shrink-0" />
                Open in {deepLink.label}
                <ExternalLink size={11} className="opacity-60" />
              </a>
            </Tooltip>
          </div>
        )}

        {showDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
          >
            <Trash2 size={13} />
            {deleteLabel}
          </button>
        )}
      </div>
    </section>
  );
}
