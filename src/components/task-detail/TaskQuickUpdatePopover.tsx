'use client';

import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { inferQuickUpdate } from './task-quick-update';

export interface QuickUpdateSubmitInput {
  text: string;
  dueDate?: string;
  subtaskTitle?: string;
}

export interface TaskQuickUpdatePopoverProps {
  canUpdateDueDate: boolean;
  canCreateSubtask: boolean;
  onSubmit: (input: QuickUpdateSubmitInput) => Promise<boolean>;
}

export function TaskQuickUpdatePopover({
  canUpdateDueDate,
  canCreateSubtask,
  onSubmit,
}: TaskQuickUpdatePopoverProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [applyDueDate, setApplyDueDate] = useState(false);
  const [applySubtask, setApplySubtask] = useState(false);
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const suggestion = useMemo(() => inferQuickUpdate(text), [text]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [open]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const saved = await onSubmit({
        text: trimmed,
        ...(applyDueDate && suggestion.dueDate ? { dueDate: suggestion.dueDate } : {}),
        ...(applySubtask && suggestion.subtaskTitle
          ? { subtaskTitle: suggestion.subtaskTitle }
          : {}),
      });
      if (!saved) return;
      setText('');
      setApplySubtask(false);
      close(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="static ml-auto">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="task-quick-update-popover"
        className="flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <Plus size={13} aria-hidden="true" />
        <span className="text-xs font-medium">Quick update</span>
      </button>
      {open && (
        <div
          id="task-quick-update-popover"
          ref={popoverRef}
          role="dialog"
          aria-label="Quick task update"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close(true);
            }
          }}
          className="absolute inset-x-3 top-14 z-30 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-0)] p-3 shadow-xl @[34rem]:left-auto @[34rem]:right-3 @[34rem]:w-[30rem]"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-[var(--text-heading)]">Append a dated update</h4>
            <button
              type="button"
              onClick={() => close(true)}
              aria-label="Close quick update"
              className="flex min-h-8 min-w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="input-glow flex min-h-11 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2">
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(event) => {
                const nextText = event.target.value;
                setText(nextText);
                setApplyDueDate(Boolean(inferQuickUpdate(nextText).dueDate && canUpdateDueDate));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Called vendor; check back Friday"
              aria-label="Quick update"
              className="min-w-0 flex-1 bg-transparent px-1 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            <button
              type="button"
              onClick={() => { void submit(); }}
              disabled={!text.trim() || saving}
              className="min-h-9 shrink-0 rounded-lg bg-[var(--accent-action)] px-3 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Appending…' : 'Append'}
            </button>
          </div>
          {(suggestion.dueDate || suggestion.subtaskTitle) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestion.dueDate && canUpdateDueDate && (
                <label className="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[11px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={applyDueDate}
                    onChange={(event) => setApplyDueDate(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  Move due date to {suggestion.dueDateLabel}
                </label>
              )}
              {suggestion.subtaskTitle && canCreateSubtask && (
                <label className="flex min-h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[11px] text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={applySubtask}
                    onChange={(event) => setApplySubtask(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="min-w-0 truncate">Add subtask “{suggestion.subtaskTitle}”</span>
                </label>
              )}
            </div>
          )}
          <p className={cn(
            'mt-2 text-[10px] text-[var(--text-muted)]',
            !suggestion.dueDate && !suggestion.subtaskTitle && 'sr-only',
          )}>
            Nothing else changes unless selected.
          </p>
        </div>
      )}
    </div>
  );
}
