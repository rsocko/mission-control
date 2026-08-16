'use client';

import { FileText, Maximize2, Pencil } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { cn } from '@/lib/utils';
import { TaskDetailMarkdown } from './TaskDetailMarkdown';
import type { TaskDetailMode } from './task-detail-types';

export interface TaskNotesSectionProps {
  mode: TaskDetailMode;
  /** Saved notes markdown. */
  description: string | null;
  /** Draft notes while the editor is open. */
  descValue: string;
  editingDesc: boolean;
  canEditDescription: boolean;
  /** Explains why notes cannot be edited, when they cannot. */
  descriptionBlockedReason?: string;
  /** Enables the paste-an-image hint in the editor placeholder. */
  supportsAttachments: boolean;
  /** Task URL offered when an embedded image fails to load. */
  sourceUrl: string | null;
  descRef: React.RefObject<HTMLTextAreaElement | null>;
  expandButtonRef: React.RefObject<HTMLButtonElement | null>;
  onDescValueChange: (value: string) => void;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditorBlur: () => unknown;
  onExpand: () => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  /** Omitted when notes are read-only, which also disables checkbox toggling. */
  onCheckboxToggle?: (index: number, checked: boolean) => void;
}

/** Notes card with inline markdown preview and editor. */
export function TaskNotesSection({
  mode,
  description,
  descValue,
  editingDesc,
  canEditDescription,
  descriptionBlockedReason,
  supportsAttachments,
  sourceUrl,
  descRef,
  expandButtonRef,
  onDescValueChange,
  onEditStart,
  onEditCancel,
  onEditorBlur,
  onExpand,
  onPaste,
  onCheckboxToggle,
}: TaskNotesSectionProps) {
  return (
    <section className={cn(
      'flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
      (mode === 'panel' || mode === 'mobile') && 'order-1',
      mode === 'dialog' && 'col-span-2 row-start-7 min-h-72 self-stretch',
      mode === 'workspace' && 'col-start-3 row-start-2 row-span-3 min-h-[520px] self-stretch',
    )}>
      <div className="mb-2 flex items-center gap-2">
        <FileText size={13} className="text-[var(--text-muted)]" />
        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Notes</h3>
        <div className="ml-auto flex items-center gap-1">
          {!editingDesc && (
            <Tooltip content={canEditDescription ? 'Edit notes' : descriptionBlockedReason}>
              <button
                type="button"
                onClick={onEditStart}
                className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                aria-label="Edit notes"
                disabled={!canEditDescription}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="Expand notes">
            <button
              ref={expandButtonRef}
              type="button"
              onClick={onExpand}
              className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label="Expand notes"
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </div>
      {editingDesc && canEditDescription ? (
        <MarkdownEditor
          textareaRef={descRef}
          value={descValue}
          onValueChange={onDescValueChange}
          onEditorBlur={onEditorBlur}
          onEscape={onEditCancel}
          onPaste={onPaste}
          containerClassName={cn(
            (mode === 'dialog' || mode === 'workspace') && 'flex min-h-0 flex-1 flex-col',
          )}
          toolbarClassName="mb-1.5 pb-1.5"
          className={cn(
            'w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 font-mono text-xs text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]',
            (mode === 'dialog' || mode === 'workspace')
              ? 'min-h-0 flex-1 resize-none'
              : 'max-h-72 min-h-32 resize-y',
          )}
          placeholder={supportsAttachments ? 'Add notes (supports Markdown, paste images)...' : 'Add notes (supports Markdown)...'}
          aria-label="Edit notes"
          autoFocus
        />
      ) : (
        <div
          className={cn(
            `overflow-y-auto rounded-xl border border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)] ${canEditDescription ? 'cursor-text hover:bg-[var(--surface-0)]' : 'cursor-default'} transition-colors duration-100`,
            (mode === 'dialog' || mode === 'workspace')
              ? 'min-h-0 flex-1'
              : 'max-h-64 min-h-24',
          )}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a, button, input')) return;
            if (canEditDescription) onEditStart();
          }}
        >
          {description ? (
            <div className="prose prose-invert prose-xs max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_code]:text-xs [&_pre]:text-xs [&_a]:text-blue-400 [&_a:hover]:underline [&_img]:rounded-md [&_img]:max-w-full [&_img]:h-auto [&_img]:my-2">
              <TaskDetailMarkdown
                onCheckboxToggle={onCheckboxToggle}
                sourceUrl={sourceUrl}
              >
                {description}
              </TaskDetailMarkdown>
            </div>
          ) : (
            <span className="text-[var(--text-muted)] italic">
              {canEditDescription ? 'Click to add notes...' : descriptionBlockedReason}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
