'use client';

import { FileText, X } from 'lucide-react';
import { motion } from 'motion/react';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { cn } from '@/lib/utils';
import { modalContent, modalOverlay } from '@/lib/motion';
import { TaskDetailMarkdown } from './TaskDetailMarkdown';

export interface TaskNotesDialogProps {
  /** Task title shown as dialog context. */
  taskTitle: string;
  /** Saved notes markdown. */
  description: string | null;
  /** Draft notes shown in the editor and live preview. */
  descValue: string;
  editing: boolean;
  canEditDescription: boolean;
  sourceUrl: string | null;
  dialogRef: React.RefObject<HTMLElement | null>;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  onDescValueChange: (value: string) => void;
  onEditingChange: (editing: boolean) => void;
  onCancelEdit: () => void;
  /** Saves the draft; resolves true when the save succeeded. */
  onSave: () => Promise<boolean>;
  onClose: () => void;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  /** Omitted when notes are read-only, which also disables checkbox toggling. */
  onCheckboxToggle?: (index: number, checked: boolean) => void;
}

/** Full-screen notes dialog with read and side-by-side edit modes. */
export function TaskNotesDialog({
  taskTitle,
  description,
  descValue,
  editing,
  canEditDescription,
  sourceUrl,
  dialogRef,
  editorRef,
  onDescValueChange,
  onEditingChange,
  onCancelEdit,
  onSave,
  onClose,
  onPaste,
  onCheckboxToggle,
}: TaskNotesDialogProps) {
  return (
    <motion.div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="presentation"
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      onClick={(event) => {
        const hasUnsavedDraft = editing && descValue !== (description || '');
        if (event.target === event.currentTarget && !hasUnsavedDraft) onClose();
      }}
    >
      <motion.section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="expanded-notes-title"
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
        tabIndex={-1}
        className="flex h-[min(820px,92vh)] w-[min(1120px,96vw)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <FileText size={17} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <h2 id="expanded-notes-title" className="truncate text-sm font-semibold text-[var(--text-primary)]">Notes</h2>
            <p className="truncate text-xs text-[var(--text-muted)]">{taskTitle}</p>
          </div>
          <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-1" role="group" aria-label="Notes view">
            <button
              type="button"
              onClick={() => onEditingChange(false)}
              aria-pressed={!editing}
              className={cn('min-h-9 rounded-md px-3 text-xs font-medium', !editing ? 'bg-[var(--surface-2)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}
            >
              Read
            </button>
            {canEditDescription && (
              <button
                type="button"
                onClick={() => onEditingChange(true)}
                aria-pressed={editing}
                className={cn('min-h-9 rounded-md px-3 text-xs font-medium', editing ? 'bg-[var(--surface-2)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}
              >
                Edit
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            aria-label="Close expanded notes"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden p-5">
          {editing ? (
            <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-5 md:grid-cols-2 md:grid-rows-1">
              <MarkdownEditor
                textareaRef={editorRef}
                value={descValue}
                onValueChange={onDescValueChange}
                onPaste={onPaste}
                containerClassName="flex h-full min-h-0 flex-col"
                toolbarClassName="mb-2 shrink-0 pb-2"
                className="min-h-0 flex-1 resize-none overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-4 font-mono text-sm leading-relaxed text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
                aria-label="Edit notes"
                data-notes-autofocus
                autoFocus
              />
              <div className="h-full overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5" aria-label="Notes preview">
                <div className="prose prose-invert max-w-none">
                  <TaskDetailMarkdown sourceUrl={sourceUrl}>
                    {descValue || '*Nothing to preview yet.*'}
                  </TaskDetailMarkdown>
                </div>
              </div>
            </div>
          ) : (
            <div className="prose prose-invert mx-auto h-full max-w-3xl overflow-y-auto pr-2">
              <TaskDetailMarkdown
                onCheckboxToggle={onCheckboxToggle}
                sourceUrl={sourceUrl}
              >
                {description || '*No notes yet.*'}
              </TaskDetailMarkdown>
            </div>
          )}
        </div>
        {editing && (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
            <button type="button" onClick={onCancelEdit} className="min-h-10 rounded-lg px-4 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]">Cancel</button>
            <button type="button" onClick={async () => { if (await onSave()) onEditingChange(false); }} className="min-h-10 rounded-lg bg-[var(--accent)] px-4 text-xs font-semibold text-white hover:brightness-110">Save notes</button>
          </footer>
        )}
      </motion.section>
    </motion.div>
  );
}
