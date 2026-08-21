'use client';

import { useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle2, ExternalLink, Search, SkipForward, X, Sparkles, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  canEditTaskField,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { LocalDisposition, TaskField } from '@/types';
import { triggerHaptic, triggerHapticFeedback } from '@/lib/utils/haptics';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import { DatePicker } from '@/components/ui/date-picker';
import type { QuickSortQueueMode, QuickSortQueueTask, QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import { TASK_PRIORITY_VISUALS } from '@/lib/constants/task-formatting';

// ─── Priority ───────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS = [
  ...(['critical', 'high', 'medium', 'low'] as const).map((value) => ({
    value,
    label: TASK_PRIORITY_VISUALS[value].shortLabel,
    sublabel: TASK_PRIORITY_VISUALS[value].label,
    classes: TASK_PRIORITY_VISUALS[value].badgeClass,
  })),
] as const;

// ─── Effort ─────────────────────────────────────────────────────────────────

const EFFORT_OPTIONS = [
  { value: 1, label: 'XS', classes: 'border-green-700/60 bg-green-950/50 text-green-400 active:bg-green-900/70' },
  { value: 2, label: 'S', classes: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-400 active:bg-emerald-900/70' },
  { value: 3, label: 'M', classes: 'border-yellow-700/60 bg-yellow-950/50 text-yellow-400 active:bg-yellow-900/70' },
  { value: 4, label: 'L', classes: 'border-orange-700/60 bg-orange-950/50 text-orange-400 active:bg-orange-900/70' },
  { value: 5, label: 'XL', classes: 'border-red-700/60 bg-red-950/50 text-red-400 active:bg-red-900/70' },
] as const;

// ─── Tag search ──────────────────────────────────────────────────────────────

export interface TagOption {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  usageCount?: number;
}

function TagPicker({
  onApply,
  allTags,
  tagsLoading,
  suggestedTagIds,
  recentTagIds,
  disabled = false,
  disabledReason,
}: {
  onApply: (tagId: string, tagName: string) => void;
  allTags: TagOption[];
  tagsLoading: boolean;
  suggestedTagIds: Set<string>;
  recentTagIds: Set<string>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = query.trim()
    ? allTags.filter((t) => !isSyntheticTag(t.name) && t.name.toLowerCase().includes(query.toLowerCase()))
    : allTags.filter((t) => !isSyntheticTag(t.name)).slice(0, 10);

  // Sort: suggested first, then recently-used, then the rest
  const sorted = [...filtered].sort((a, b) => {
    const aS = suggestedTagIds.has(a.id) ? 0 : recentTagIds.has(a.id) ? 1 : 2;
    const bS = suggestedTagIds.has(b.id) ? 0 : recentTagIds.has(b.id) ? 1 : 2;
    return aS - bS;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="input-glow flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3">
        <Search size={14} className="text-[var(--text-tertiary)] flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags…"
          className="min-h-11 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="flex min-h-11 min-w-11 items-center justify-center text-[var(--text-tertiary)]"
            aria-label="Clear tag search"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tagsLoading && <span className="text-xs text-[var(--text-muted)]">Loading…</span>}
        {!tagsLoading && sorted.length === 0 && (
          <span className="text-xs text-[var(--text-muted)]">No tags found</span>
        )}
        {sorted.map((tag) => {
          const isSuggested = suggestedTagIds.has(tag.id);
          const isRecent = !isSuggested && recentTagIds.has(tag.id);
          return (
            <button
              key={tag.id}
              onClick={() => { triggerHaptic('light'); onApply(tag.id, tag.name); }}
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              className={cn(
                'flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition-colors',
                isSuggested
                  ? 'border-[var(--accent)]/40 bg-indigo-950/40 text-indigo-300 ring-1 ring-[var(--accent)]/30'
                  : isRecent
                    ? 'border-blue-600/40 bg-blue-950/30 text-blue-300'
                    : 'border-[var(--border)] bg-[var(--surface-3)] text-[var(--text-secondary)] active:bg-[var(--surface-2)]'
              )}
            >
              {isSuggested && <Sparkles size={10} className="text-[var(--accent-300)]" />}
              {isRecent && <Clock size={10} className="text-blue-400" />}
              {tag.color && (
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
              )}
              {tag.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Actions Component ──────────────────────────────────────────────────

interface QuickSortActionsProps {
  task: QuickSortQueueTask;
  mode: QuickSortQueueMode;
  suggestion?: QuickSortSuggestion;
  onViewTask: () => void;
  onSkip: () => void;
  onMarkDone: () => void;
  onSetLocalDisposition: (disposition: LocalDisposition) => void;
  onApplyPriority: (priority: string) => void;
  onApplyEffort: (effort: number) => void;
  onApplyTag: (tagId: string, tagName: string) => void;
  onApplyDueDate: (dueDate: string) => void;
  allTags: TagOption[];
  tagsLoading: boolean;
  recentTagIds: string[];
  busy: boolean;
}

export default function QuickSortActions({
  task,
  mode,
  suggestion,
  onViewTask,
  onSkip,
  onMarkDone,
  onSetLocalDisposition,
  onApplyPriority,
  onApplyEffort,
  onApplyTag,
  onApplyDueDate,
  allTags,
  tagsLoading,
  recentTagIds,
  busy,
}: QuickSortActionsProps) {
  const suggestedPriority = suggestion?.priority?.value;
  const suggestedEffort = suggestion?.effort?.value;
  const suggestedTagIds = new Set(suggestion?.tags?.map((t) => t.id) ?? []);
  const recentTagSet = new Set(recentTagIds);
  const fieldByMode: Record<QuickSortQueueMode, TaskField> = {
    no_priority: 'priority',
    no_effort: 'effort',
    no_tags: 'tags',
    no_due_date: 'dueDate',
  };
  const modeField = fieldByMode[mode];
  const canApplyMode = canEditTaskField(task.editPolicy, modeField);
  const modeBlockedReason = taskFieldBlockedReason(task.editPolicy, modeField);
  const canMarkDone = canEditTaskField(task.editPolicy, 'status');
  const canSkip = canEditTaskField(task.editPolicy, 'snoozedUntil');
  const dispositionOptions = TASK_DISPOSITION_OPTIONS.filter((option) => (
    option.value !== 'active'
    && option.value !== task.localDisposition
    && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
  ));

  return (
    <div className="quick-sort-actions-inner flex max-h-full min-h-0 flex-col gap-2 px-4">
      <div
        className="quick-sort-primary-actions flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain"
        data-testid="quick-sort-primary-actions"
      >
        {/* Mode-specific action buttons */}
        {mode === 'no_priority' && (
          <div className="grid grid-cols-4 gap-2">
          {PRIORITY_OPTIONS.map((opt) => {
            const isSuggested = opt.value === suggestedPriority;
            return (
              <button
                key={opt.value}
                onClick={() => { triggerHapticFeedback('priority'); onApplyPriority(opt.value); }}
                disabled={busy || !canApplyMode}
                title={!canApplyMode ? modeBlockedReason : undefined}
                className={cn(
                  'quick-sort-primary-button flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl border py-2 font-semibold transition-all active:scale-95 disabled:opacity-50',
                  opt.classes,
                  isSuggested && 'ring-2 ring-[var(--accent)]/50 shadow-[0_0_8px_rgba(99,102,241,0.2)]'
                )}
              >
                {isSuggested && <Sparkles size={10} className="text-[var(--accent-300)] mb-0.5" />}
                <span className="text-base">{opt.label}</span>
                <span className="text-[10px] opacity-70">{opt.sublabel}</span>
              </button>
            );
          })}
          </div>
        )}

        {mode === 'no_effort' && (
          <div className="grid grid-cols-5 gap-2">
          {EFFORT_OPTIONS.map((opt) => {
            const isSuggested = opt.value === suggestedEffort;
            return (
              <button
                key={opt.value}
                onClick={() => { triggerHaptic('light'); onApplyEffort(opt.value); }}
                disabled={busy || !canApplyMode}
                title={!canApplyMode ? modeBlockedReason : undefined}
                className={cn(
                  'quick-sort-primary-button flex min-h-11 flex-col items-center justify-center rounded-xl border py-2 font-semibold text-base transition-all active:scale-95 disabled:opacity-50',
                  opt.classes,
                  isSuggested && 'ring-2 ring-[var(--accent)]/50 shadow-[0_0_8px_rgba(99,102,241,0.2)]'
                )}
              >
                {isSuggested && <Sparkles size={10} className="text-[var(--accent-300)] mb-0.5" />}
                {opt.label}
              </button>
            );
          })}
          </div>
        )}

        {mode === 'no_tags' && (
          <TagPicker
            onApply={onApplyTag}
            allTags={allTags}
            tagsLoading={tagsLoading}
            suggestedTagIds={suggestedTagIds}
            recentTagIds={recentTagSet}
            disabled={busy || !canApplyMode}
            disabledReason={!canApplyMode ? modeBlockedReason : undefined}
          />
        )}

        {mode === 'no_due_date' && (
          <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => { triggerHaptic('light'); onApplyDueDate(getLocalToday()); }}
            disabled={busy || !canApplyMode}
            title={!canApplyMode ? modeBlockedReason : undefined}
            className="flex min-h-[48px] items-center justify-center rounded-xl border border-emerald-700/50 bg-emerald-950/40 px-2 py-3 text-sm font-medium text-emerald-300 transition-all active:scale-95 disabled:opacity-50"
          >
            Today
          </button>
          <button
            onClick={() => { triggerHaptic('light'); onApplyDueDate(getLocalTomorrow()); }}
            disabled={busy || !canApplyMode}
            title={!canApplyMode ? modeBlockedReason : undefined}
            className="flex min-h-[48px] items-center justify-center rounded-xl border border-sky-700/50 bg-sky-950/40 px-2 py-3 text-sm font-medium text-sky-300 transition-all active:scale-95 disabled:opacity-50"
          >
            Tomorrow
          </button>
          <DatePicker
            value={null}
            onChange={(date) => {
              if (date) {
                triggerHaptic('light');
                onApplyDueDate(date);
              }
            }}
            placeholder="Pick date"
            aria-label="Pick a due date"
            disabled={busy || !canApplyMode}
            title={!canApplyMode ? modeBlockedReason : undefined}
            className="min-h-[48px] justify-center rounded-xl border-violet-700/50 bg-violet-950/40 px-2 py-3 text-sm font-medium text-violet-300"
          />
          </div>
        )}

        {dispositionOptions.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
          {dispositionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSetLocalDisposition(option.value)}
              disabled={busy}
              title={option.detail}
              aria-label={`${option.label}. ${option.detail}`}
              className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border border-emerald-700/40 bg-emerald-950/30 px-2 py-3 text-sm font-medium text-emerald-300 transition-colors active:bg-emerald-900/50 disabled:opacity-50"
            >
              <Archive size={14} />
              {option.label}
            </button>
          ))}
          <p className="col-span-2 text-center text-[10px] text-[var(--text-muted)]">
            Mission Control only. The upstream task is unchanged.
          </p>
          </div>
        )}
      </div>

      {/* Lower-frequency task detail action stays far left for right-handed use. */}
      <div className="grid flex-shrink-0 grid-cols-3 gap-2">
        <button
          onClick={onViewTask}
          disabled={busy}
          aria-label="View task"
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-transparent px-2 py-2 text-xs text-[var(--text-tertiary)] transition-colors active:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <ExternalLink size={13} />
          View
        </button>
        <button
          onClick={() => { triggerHapticFeedback('taskComplete'); onMarkDone(); }}
          disabled={busy || !canMarkDone}
          title={!canMarkDone ? taskFieldBlockedReason(task.editPolicy, 'status') : undefined}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-green-700/40 bg-green-950/30 px-2 py-2 text-sm font-medium text-green-400 transition-colors active:bg-green-900/50 disabled:opacity-50"
        >
          <CheckCircle2 size={14} />
          Done
        </button>
        <button
          onClick={() => { triggerHaptic('light'); onSkip(); }}
          disabled={busy || !canSkip}
          title={!canSkip ? taskFieldBlockedReason(task.editPolicy, 'snoozedUntil') : undefined}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2 py-2 text-sm text-[var(--text-secondary)] transition-colors active:bg-[var(--surface-3)] disabled:opacity-50"
        >
          <SkipForward size={14} />
          Skip
        </button>
      </div>
    </div>
  );
}
