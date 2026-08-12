'use client';

import { memo, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { CalendarDays, CheckCircle2, ListPlus, Loader2, TrendingUp } from 'lucide-react';
import { scaleIn } from '@/lib/motion';

// ─── Types ──────────────────────────────────────────────────────────────────

type ActionCardType = 'create-task' | 'schedule' | 'show-insights';

type ActionCardState = 'idle' | 'pending' | 'completed' | 'error';

type InlineActionCardProps = {
  type: ActionCardType;
  /** Pre-filled data from the AI context */
  data?: ActionCardData;
  /** Callback when user executes the action */
  onExecute?: (type: ActionCardType, payload: Record<string, unknown>) => Promise<void> | void;
};

type ActionCardData = {
  title?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  date?: string;
  stats?: { label: string; value: string | number }[];
  description?: string;
};

type ActionPriority = NonNullable<ActionCardData['priority']>;

// ─── Priority config ────────────────────────────────────────────────────────

const priorityColors: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/30',
  high: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  medium: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  low: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
};

const priorityOptions = ['critical', 'high', 'medium', 'low'] as const;

// ─── Component ──────────────────────────────────────────────────────────────

export const InlineActionCard = memo(function InlineActionCard({
  type,
  data,
  onExecute,
}: InlineActionCardProps) {
  const [state, setState] = useState<ActionCardState>('idle');
  const [selectedPriority, setSelectedPriority] = useState<ActionPriority>(data?.priority ?? 'medium');
  const [title, setTitle] = useState(data?.title || '');

  const handleExecute = useCallback(async () => {
    if (state !== 'idle') return;
    setState('pending');
    try {
      await onExecute?.(type, { title, priority: selectedPriority, date: data?.date });
      setState('completed');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 2000);
    }
  }, [state, type, title, selectedPriority, data?.date, onExecute]);

  if (state === 'completed') {
    return (
      <motion.div
        initial="hidden"
        animate="show"
        variants={scaleIn}
        className="mx-2 my-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-md p-3"
      >
        <div className="flex items-center gap-2 text-emerald-300 text-sm font-medium">
          <CheckCircle2 size={16} />
          {type === 'create-task' && 'Task created'}
          {type === 'schedule' && 'Scheduled'}
          {type === 'show-insights' && 'Insights loaded'}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={scaleIn}
      className="mx-2 my-1 rounded-xl border border-white/[0.08] bg-[var(--surface-2)]/80 backdrop-blur-md overflow-hidden"
    >
      {type === 'create-task' && (
        <CreateTaskContent
          title={title}
          onTitleChange={setTitle}
          selectedPriority={selectedPriority}
          onPriorityChange={setSelectedPriority}
          onExecute={handleExecute}
          state={state}
        />
      )}
      {type === 'schedule' && (
        <ScheduleContent
          date={data?.date}
          description={data?.description}
          onExecute={handleExecute}
          state={state}
        />
      )}
      {type === 'show-insights' && (
        <InsightsContent
          stats={data?.stats}
          onExecute={handleExecute}
          state={state}
        />
      )}
    </motion.div>
  );
});

// ─── Sub-components ─────────────────────────────────────────────────────────

function CreateTaskContent({
  title,
  onTitleChange,
  selectedPriority,
  onPriorityChange,
  onExecute,
  state,
}: {
  title: string;
  onTitleChange: (v: string) => void;
  selectedPriority: ActionPriority;
  onPriorityChange: (v: ActionPriority) => void;
  onExecute: () => void;
  state: ActionCardState;
}) {
  return (
    <div className="p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        <ListPlus size={14} className="text-blue-400" />
        Create Task
      </div>
      <input
        type="text"
        value={title}
        onChange={e => onTitleChange(e.target.value)}
        placeholder="Task title…"
        className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--surface-0)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
      />
      <div className="flex gap-1.5">
        {priorityOptions.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => onPriorityChange(p)}
            className={`px-2.5 py-1 text-xs rounded-lg border capitalize min-h-[32px] transition-all
              ${selectedPriority === p ? priorityColors[p] : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--border)]'}`}
          >
            {p}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onExecute}
        disabled={!title.trim() || state === 'pending'}
        className="w-full py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] flex items-center justify-center gap-2"
      >
        {state === 'pending' ? <Loader2 size={14} className="animate-spin" /> : null}
        {state === 'pending' ? 'Creating…' : 'Create Task'}
      </button>
    </div>
  );
}

function ScheduleContent({
  date,
  description,
  onExecute,
  state,
}: {
  date?: string;
  description?: string;
  onExecute: () => void;
  state: ActionCardState;
}) {
  return (
    <div className="p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        <CalendarDays size={14} className="text-purple-400" />
        Schedule
      </div>
      {description ? (
        <p className="text-sm text-[var(--text-secondary)]">{description}</p>
      ) : null}
      {date ? (
        <div className="px-3 py-2 rounded-lg bg-[var(--surface-0)] border border-[var(--border-subtle)] text-sm text-[var(--text-primary)]">
          {new Date(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onExecute}
        disabled={state === 'pending'}
        className="w-full py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] flex items-center justify-center gap-2"
      >
        {state === 'pending' ? <Loader2 size={14} className="animate-spin" /> : null}
        {state === 'pending' ? 'Scheduling…' : 'Confirm Schedule'}
      </button>
    </div>
  );
}

function InsightsContent({
  stats,
  onExecute,
  state,
}: {
  stats?: { label: string; value: string | number }[];
  onExecute: () => void;
  state: ActionCardState;
}) {
  return (
    <div className="p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
        <TrendingUp size={14} className="text-emerald-400" />
        Insights
      </div>
      {stats && stats.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {stats.map(stat => (
            <div
              key={stat.label}
              className="rounded-lg bg-[var(--surface-0)] border border-[var(--border-subtle)] p-2 text-center"
            >
              <div className="text-lg font-semibold text-[var(--text-primary)]">{stat.value}</div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{stat.label}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-16 rounded-lg bg-[var(--surface-0)] border border-[var(--border-subtle)] flex items-center justify-center">
          <span className="text-xs text-[var(--text-muted)]">Tap to load insights</span>
        </div>
      )}
      <button
        type="button"
        onClick={onExecute}
        disabled={state === 'pending'}
        className="w-full py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] flex items-center justify-center gap-2"
      >
        {state === 'pending' ? <Loader2 size={14} className="animate-spin" /> : null}
        {state === 'pending' ? 'Loading…' : 'View Full Insights'}
      </button>
    </div>
  );
}
