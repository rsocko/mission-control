'use client';

import { useCallback, useRef, useState } from 'react';
import { Plus, CheckCircle2, Circle, Trash2, ArrowUpFromLine, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import dynamic from 'next/dynamic';

const LazyAiBreakdownPanel = dynamic(
  () => import('./AiBreakdownPanel').then((module) => module.AiBreakdownPanel),
  { ssr: false },
);

export interface Subtask {
  id: string;
  title: string;
  status: string;
  sourceId?: string;
  connectorType?: string;
  effort?: number | null;
}

export interface SubtaskSectionProps {
  /** Parent task ID (for API calls). */
  taskId: string;
  /** Current subtasks. */
  subtasks: Subtask[];
  /** Called after any mutation to update parent state. */
  onSubtasksChange: (subtasks: Subtask[]) => void;
  /** Notify parent that data changed (e.g. for refresh). */
  onUpdate?: () => void;
  /** Whether editing is allowed. */
  canEdit?: boolean;
  /** Whether this connector supports creating subtasks. */
  canCreateSubtasks?: boolean;
  /** Called after a subtask is promoted to a standalone task. */
  onSubtaskPromoted?: (subtaskId: string) => void;
}

/**
 * Subtask list with create, toggle, and delete.
 * Extracted from TaskDetailPanel for reuse and modularity.
 */
export function SubtaskSection({
  taskId,
  subtasks,
  onSubtasksChange,
  onUpdate,
  canEdit = true,
  canCreateSubtasks = canEdit,
  onSubtaskPromoted,
}: SubtaskSectionProps) {
  const [newTitle, setNewTitle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [showAiBreakdown, setShowAiBreakdown] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel: string;
    variant: 'danger' | 'warning';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });

  const toggleSubtask = useCallback(async (subtaskId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'done' ? 'todo' : 'done';
    // Optimistic update
    onSubtasksChange(
      subtasks.map((st) => (st.id === subtaskId ? { ...st, status: newStatus } : st)),
    );
    try {
      const res = await fetch(`/api/tasks/${subtaskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to toggle subtask');
    } catch {
      // Revert
      onSubtasksChange(subtasks);
      toast.error('Failed to toggle subtask');
    }
  }, [subtasks, onSubtasksChange]);

  const startEditing = useCallback((subtaskId: string, currentTitle: string) => {
    setEditingId(subtaskId);
    setEditingTitle(currentTitle);
    setTimeout(() => editInputRef.current?.select(), 0);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingId) return;
    const trimmed = editingTitle.trim();
    const original = subtasks.find((st) => st.id === editingId);
    setEditingId(null);

    if (!trimmed || trimmed === original?.title) return;

    // Optimistic update
    onSubtasksChange(
      subtasks.map((st) => (st.id === editingId ? { ...st, title: trimmed } : st)),
    );
    try {
      const res = await fetch(`/api/tasks/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error('Failed');
      onUpdate?.();
    } catch {
      // Revert
      onSubtasksChange(subtasks);
      toast.error('Failed to rename subtask');
    }
  }, [editingId, editingTitle, subtasks, onSubtasksChange, onUpdate]);

  const addSubtask = useCallback(async () => {
    if (!newTitle.trim()) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        onSubtasksChange([...subtasks, data.subtask]);
        setNewTitle('');
        onUpdate?.();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to add subtask');
      }
    } catch {
      toast.error('Failed to add subtask');
    }
  }, [taskId, newTitle, subtasks, onSubtasksChange, onUpdate]);

  const deleteSubtask = useCallback((subtaskId: string, subtaskTitle?: string) => {
    setConfirmDialog({
      open: true,
      title: 'Delete subtask?',
      message: `This will permanently delete "${subtaskTitle || 'this subtask'}". This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog((d) => ({ ...d, open: false }));
        try {
          await fetch(`/api/tasks/${subtaskId}`, { method: 'DELETE' });
          onSubtasksChange(subtasks.filter((st) => st.id !== subtaskId));
          onUpdate?.();
        } catch {
          toast.error('Failed to delete subtask');
        }
      },
    });
  }, [subtasks, onSubtasksChange, onUpdate]);

  const promoteSubtask = useCallback(async (subtaskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${subtaskId}/promote`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to promote subtask');
      onSubtasksChange(subtasks.filter((st) => st.id !== subtaskId));
      onSubtaskPromoted?.(subtaskId);
      onUpdate?.();
      toast.success('Subtask promoted to task');
    } catch {
      toast.error('Failed to promote subtask');
    }
  }, [subtasks, onSubtasksChange, onSubtaskPromoted, onUpdate]);

  const handleAcceptedSubtasks = useCallback((accepted: Subtask[]) => {
    const merged = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
    for (const subtask of accepted) {
      merged.set(subtask.id, subtask);
    }
    onSubtasksChange([...merged.values()]);
    onUpdate?.();
  }, [onSubtasksChange, onUpdate, subtasks]);

  return (
    <>
      <div className="space-y-1">
        {subtasks.map((st) => (
          <div
            key={st.id}
            className="flex items-center gap-2 group py-0.5"
          >
            <button
              type="button"
              onClick={() => canEdit && toggleSubtask(st.id, st.status)}
              disabled={!canEdit}
              aria-label={st.status === 'done' ? `Mark "${st.title}" incomplete` : `Mark "${st.title}" complete`}
              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              {st.status === 'done' ? (
                <CheckCircle2 size={14} className="text-green-500" />
              ) : (
                <Circle size={14} />
              )}
            </button>
            {editingId === st.id ? (
              <input
                ref={editInputRef}
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { setEditingId(null); }
                }}
                className="flex-1 text-xs bg-transparent text-[var(--text-primary)] outline-none border-b border-[var(--border-subtle)]"
                autoFocus
              />
            ) : (
            <span
              className={`flex-1 text-xs ${
                st.status === 'done'
                  ? 'line-through text-[var(--text-muted)]'
                  : 'text-[var(--text-primary)]'
              } ${canEdit ? 'cursor-text' : ''}`}
              onDoubleClick={() => canEdit && startEditing(st.id, st.title)}
            >
              {st.title}
              {st.connectorType === 'github-issues' && st.sourceId && (() => {
                const lastColon = st.sourceId!.lastIndexOf(':');
                const num = lastColon !== -1 ? st.sourceId!.substring(lastColon + 1) : null;
                return num && /^\d+$/.test(num) ? (
                  <span className="text-[var(--text-muted)] font-mono tabular-nums ml-1.5 text-xs">#{num}</span>
                ) : null;
              })()}
            </span>
            )}
            {canEdit && (
              <>
                <button
                  onClick={() => promoteSubtask(st.id)}
                  title="Promote to task"
                  className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-60 [@media(pointer:coarse)]:opacity-60 text-[var(--text-muted)] hover:text-blue-400 transition-[opacity,color] duration-100"
                >
                  <ArrowUpFromLine size={12} />
                </button>
                <button
                  onClick={() => deleteSubtask(st.id, st.title)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-60 [@media(pointer:coarse)]:opacity-60 text-[var(--text-muted)] hover:text-red-400 transition-[opacity,color] duration-100"
                >
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        ))}

        {/* Add subtask input */}
        {canCreateSubtasks && (
          <div className="flex items-center gap-2 pt-1">
            <Plus size={14} className="shrink-0 text-[var(--text-muted)]" />
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSubtask();
                }
              }}
              placeholder="Add subtask…"
              className="flex-1 text-xs bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
        )}

        {canCreateSubtasks && (
          <button
            type="button"
            onClick={() => setShowAiBreakdown(true)}
            disabled={showAiBreakdown}
            title="Suggest subtasks with AI"
            className="mt-1 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-violet-300 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:text-[var(--text-muted)] disabled:opacity-60"
          >
            <Sparkles size={12} aria-hidden="true" />
            AI breakdown
          </button>
        )}

        {showAiBreakdown && (
          <LazyAiBreakdownPanel
            taskId={taskId}
            onAccepted={handleAcceptedSubtasks}
            onClose={() => setShowAiBreakdown(false)}
          />
        )}
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </>
  );
}
