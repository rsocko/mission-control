'use client';

import Image from 'next/image';
import { Columns3, Maximize2, Minimize2, X } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import type { TaskDetailMode } from './task-detail-types';

export interface TaskDetailHeaderProps {
  mode: TaskDetailMode;
  /** Connector icon path, or null when the connector has no icon. */
  iconSrc: string | null;
  connectorType: string;
  sourceListName: string | null;
  title: string;
  /** Draft title while the inline editor is open. */
  titleValue: string;
  editingTitle: boolean;
  canEditTitle: boolean;
  /** Explains why the title cannot be edited, when it cannot. */
  titleBlockedReason?: string;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onTitleValueChange: (value: string) => void;
  onTitleCommit: () => void;
  onTitleCancel: () => void;
  onTitleEditStart: () => void;
  /** Project name, source list name, or a "No list" fallback. */
  contextLabel: string;
  /** Connector-specific display identifier, when the connector provides one. */
  displayId: string | null;
  updatedAtLabel: string;
  onClose: () => void;
  onModeChange?: (mode: Exclude<TaskDetailMode, 'mobile'>) => void;
}

/** Task identity, mode affordances, and inline title editing. */
export function TaskDetailHeader({
  mode,
  iconSrc,
  connectorType,
  sourceListName,
  title,
  titleValue,
  editingTitle,
  canEditTitle,
  titleBlockedReason,
  titleRef,
  onTitleValueChange,
  onTitleCommit,
  onTitleCancel,
  onTitleEditStart,
  contextLabel,
  displayId,
  updatedAtLabel,
  onClose,
  onModeChange,
}: TaskDetailHeaderProps) {
  return (
    <header className={cn(
      'border-b border-[var(--border-subtle)] bg-gradient-to-b from-[var(--surface-2)]/45 to-transparent',
      mode === 'panel' && '-mx-5 -mt-5 px-5 pb-4 pt-4',
      mode === 'mobile' && 'sticky top-0 z-20 -mx-4 bg-[var(--surface-1)]/95 px-4 pb-4 pt-6 backdrop-blur-xl',
      mode === 'dialog' && 'col-span-full row-start-1 -mx-6 -mt-6 px-6 pb-4 pt-5',
      mode === 'workspace' && 'col-span-full row-start-1 -mx-7 -mt-7 px-7 pb-4 pt-5',
    )}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {iconSrc && <Image src={iconSrc} alt={connectorType} width={16} height={16} className="flex-shrink-0" />}
          <span className="text-xs text-[var(--text-muted)] uppercase tracking-wide truncate">
            {sourceListName || connectorType.replace(/-/g, ' ')}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onModeChange && mode !== 'mobile' && mode !== 'panel' && (
            <Tooltip content="Pin to side panel">
              <button
                onClick={() => onModeChange?.('panel')}
                className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                aria-label="Pin to side panel"
              >
                <Columns3 size={15} />
              </button>
            </Tooltip>
          )}
          {onModeChange && mode !== 'mobile' && (
            <Tooltip content={mode === 'workspace' ? 'Exit full workspace' : mode === 'dialog' ? 'Use full workspace' : 'Open popout'}>
              <button
                onClick={() => onModeChange?.(mode === 'panel' ? 'dialog' : mode === 'dialog' ? 'workspace' : 'dialog')}
                className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                aria-label={mode === 'workspace' ? 'Exit full workspace' : mode === 'dialog' ? 'Use full workspace' : 'Open popout'}
              >
                {mode === 'workspace' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </Tooltip>
          )}
          <button
            onClick={onClose}
            aria-label="Close task detail"
            className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {editingTitle && canEditTitle ? (
        <input
          ref={titleRef}
          value={titleValue}
          onChange={(e) => onTitleValueChange(e.target.value)}
          onBlur={onTitleCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') onTitleCommit(); if (e.key === 'Escape') onTitleCancel(); }}
          className={cn('mt-4 w-full border-b border-[var(--accent)] bg-transparent pb-1 text-lg font-semibold text-[var(--text-primary)] outline-none', (mode === 'dialog' || mode === 'workspace') && 'text-xl')}
          autoFocus
        />
      ) : (
        <h2
          className={cn(
            'mt-4 text-balance text-lg font-semibold leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]',
            (mode === 'dialog' || mode === 'workspace') && 'text-xl',
          )}
        >
          {canEditTitle ? (
            <button
              type="button"
              onClick={onTitleEditStart}
              className="w-full cursor-text text-left transition-colors duration-100 hover:text-[var(--accent)]"
            >
              {title}
            </button>
          ) : (
            <span title={titleBlockedReason}>{title}</span>
          )}
        </h2>
      )}

      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">{contextLabel}</span>
          {displayId ? (
            <>
              <span aria-hidden="true">•</span>
              <span className="shrink-0 font-mono tabular-nums">{displayId}</span>
            </>
          ) : null}
        </div>
        <span className="shrink-0">{updatedAtLabel}</span>
      </div>
    </header>
  );
}
