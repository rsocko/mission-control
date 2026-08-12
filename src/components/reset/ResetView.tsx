'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CalendarCheck, Loader2, ChevronLeft, ChevronRight,
  Sparkles, RefreshCw, ThumbsUp, ThumbsDown, Copy,
  Archive, ArrowRight, Scissors, X, Check, AlertTriangle,
  TrendingUp, Lightbulb, Zap, Calendar,
} from 'lucide-react';
import DOMPurify from 'isomorphic-dompurify';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { staggerContainer, fadeSlideUp } from '@/lib/motion';
import type { TaskEditPolicy } from '@/types';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StaleTask {
  id: string;
  title: string;
  daysSinceUpdate: number;
  status: string;
  priority: string;
  editPolicy: TaskEditPolicy;
}

interface EnergyEntry {
  date: string;
  level: string;
}

interface WeeklyBreakdown {
  weekStart: string;
  weekEnd: string;
  completed: number;
  routinePercent: number;
}

interface ResetStats {
  type: string;
  periodStart: string;
  periodEnd: string;
  tasksCompleted: number;
  tasksCreated: number;
  tasksCarriedForward: number;
  routinePercentage: number;
  focusHitRate: string;
  focusHitDays: number;
  totalWorkDays: number;
  staleTasks: StaleTask[];
  energyData: EnergyEntry[];
  incompleteFocusTasks?: Array<{ id: string; title: string; timesInFocus: number }>;
  weeklyBreakdown?: WeeklyBreakdown[];
}

interface AiSummary {
  narrative: string;
  momentum: string | null;
  attention: string | null;
  suggestion: string | null;
  feedback?: 'helpful' | 'not_useful' | null;
}

interface CarryForwardItem {
  description: string;
  detail?: string;
  kept: boolean;
  taskId?: string;
}

interface StaleAction {
  taskId: string;
  action: 'keep' | 'archive' | 'break_down';
}

interface ResetData {
  id?: string;
  type: string;
  periodStart: string;
  periodEnd: string;
  wentWell?: string;
  needsAdjustment?: string;
  notes?: string;
  stats?: Record<string, unknown>;
  aiSummary?: string;
  staleActions: StaleAction[];
  carryForwardItems: CarryForwardItem[];
  completedAt?: string;
}

type ResetCadence = 'weekly' | 'monthly';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDateLocal(d);
}

function getWeekSunday(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return formatDateLocal(d);
}

function getMonthStart(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getMonthEnd(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setMonth(d.getMonth() + 1, 0);
  return formatDateLocal(d);
}

function formatWeekRange(mondayStr: string): string {
  const monday = new Date(mondayStr + 'T12:00:00');
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const mOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const sOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${monday.toLocaleDateString('en-US', mOpts)} – ${sunday.toLocaleDateString('en-US', sOpts)}`;
}

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ─── Stats Grid ─────────────────────────────────────────────────────────────

function StatsGrid({ stats }: { stats: ResetStats }) {
  const items = [
    { label: 'Tasks completed', value: String(stats.tasksCompleted) },
    { label: 'Routines kept', value: `${stats.routinePercentage}%` },
    { label: 'Focus 3 hit rate', value: stats.focusHitRate },
    { label: 'Carried forward', value: String(stats.tasksCarriedForward) },
  ];

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="grid gap-4 md:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="rounded-[var(--radius-md)] bg-[var(--surface-0)] p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI Summary Card ────────────────────────────────────────────────────────

function AiSummaryCard({
  summary,
  loading,
  onRegenerate,
  onDismiss,
  onFeedback,
}: {
  summary: AiSummary | null;
  loading: boolean;
  onRegenerate: () => void;
  onDismiss: () => void;
  onFeedback: (feedback: 'helpful' | 'not_useful') => void;
}) {
  if (loading) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--accent-500)]/40 bg-[var(--accent-900)]/10 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-900)]/30 text-[var(--accent-400)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">Generating your weekly summary…</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">Analyzing tasks, routines, and energy patterns</p>
          </div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="rounded-[var(--radius-lg)] border-l-4 border-[var(--accent-400)] bg-gradient-to-br from-[var(--accent-900)]/15 to-[var(--accent-900)]/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-900)]/30 text-[var(--accent-400)]">
            <Sparkles size={14} />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">AI Weekly Summary</p>
            <p className="text-xs text-[var(--text-muted)]">Generated from your activity</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRegenerate}
            className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1 text-xs font-medium text-[var(--accent-400)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <RefreshCw size={12} className="inline mr-1" />Regenerate
          </button>
          <button
            onClick={onDismiss}
            className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <div className="rounded-[var(--radius-md)] bg-[var(--surface-1)]/80 p-4">
          <p
            className="text-sm leading-relaxed text-[var(--text-secondary)]"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(summary.narrative, { ALLOWED_TAGS: ['strong', 'em', 'br', 'p', 'ul', 'ol', 'li'] }) }}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {summary.momentum && (
            <div className="rounded-[var(--radius-md)] border border-green-500/20 bg-green-500/10 p-3">
              <div className="flex items-center gap-2">
                <TrendingUp size={12} className="text-green-400" />
                <p className="text-xs font-semibold uppercase tracking-wide text-green-400">Momentum</p>
              </div>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{summary.momentum}</p>
            </div>
          )}
          {summary.attention && (
            <div className="rounded-[var(--radius-md)] border border-amber-500/20 bg-amber-500/10 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle size={12} className="text-amber-400" />
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Attention needed</p>
              </div>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{summary.attention}</p>
            </div>
          )}
          {summary.suggestion && (
            <div className="rounded-[var(--radius-md)] border border-blue-500/20 bg-blue-500/10 p-3">
              <div className="flex items-center gap-2">
                <Lightbulb size={12} className="text-blue-400" />
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-400">Suggestion</p>
              </div>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{summary.suggestion}</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3">
        <p className="text-xs text-[var(--text-muted)]">
          <Calendar size={10} className="inline mr-1" />AI-generated summary
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const text = summary.narrative.replace(/<[^>]*>/g, '');
              navigator.clipboard.writeText(text);
              toast.success('Copied to clipboard');
            }}
            className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <Copy size={10} className="inline mr-1" />Copy
          </button>
          <button
            onClick={() => {
              onFeedback('helpful');
              toast.success('Thanks for the feedback!');
            }}
            className={cn(
              'rounded-[var(--radius-md)] border px-2.5 py-1 text-xs transition-colors',
              summary.feedback === 'helpful'
                ? 'border-green-500/40 bg-green-500/20 text-green-400'
                : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]',
            )}
          >
            <ThumbsUp size={10} className="inline mr-1" />Helpful
          </button>
          <button
            onClick={() => {
              onFeedback('not_useful');
              toast.success('Thanks for the feedback!');
            }}
            className={cn(
              'rounded-[var(--radius-md)] border px-2.5 py-1 text-xs transition-colors',
              summary.feedback === 'not_useful'
                ? 'border-red-500/40 bg-red-500/20 text-red-400'
                : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]',
            )}
          >
            <ThumbsDown size={10} className="inline mr-1" />Not useful
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Carry Forward Panel ────────────────────────────────────────────────────

function CarryForwardPanel({
  items,
  onChange,
}: {
  items: CarryForwardItem[];
  onChange: (items: CarryForwardItem[]) => void;
}) {
  const [newItem, setNewItem] = useState('');

  const addItem = () => {
    const text = newItem.trim();
    if (!text) return;
    onChange([...items, { description: text, kept: true }]);
    setNewItem('');
  };

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Carry Forward</p>
        <span className="text-xs text-[var(--text-muted)]">{items.length} items</span>
      </div>
      <div className="mt-4 space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            No carry-forward items yet. Add items you want to bring into next week.
          </p>
        )}
        {items.map((item, i) => (
          <div key={i} className="rounded-[var(--radius-md)] border border-[var(--border)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{item.description}</p>
                {item.detail && <p className="text-xs text-[var(--text-muted)]">{item.detail}</p>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const updated = [...items];
                    updated[i] = { ...item, kept: true };
                    onChange(updated);
                  }}
                  className={cn(
                    'rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors',
                    item.kept
                      ? 'border-[var(--accent-400)] bg-[var(--accent-900)]/30 text-[var(--accent-400)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  <ArrowRight size={12} className="inline mr-1" />Keep →
                </button>
                <button
                  onClick={() => {
                    const updated = [...items];
                    updated[i] = { ...item, kept: false };
                    onChange(updated);
                  }}
                  className={cn(
                    'rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors',
                    !item.kept
                      ? 'border-[var(--text-muted)] bg-[var(--surface-2)] text-[var(--text-secondary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                  )}
                >
                  Let go
                </button>
              </div>
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            type="text"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
            placeholder="Add an item to carry forward…"
            className="flex-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-400)]"
          />
          <button
            onClick={addItem}
            disabled={!newItem.trim()}
            className="rounded-[var(--radius-md)] border border-[var(--accent-400)] bg-[var(--accent-900)]/20 px-3 py-2 text-xs font-medium text-[var(--accent-400)] hover:bg-[var(--accent-900)]/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Stale Tasks Panel ──────────────────────────────────────────────────────

function StaleTasksPanel({
  staleTasks,
  actions,
  onAction,
  onBreakDown,
}: {
  staleTasks: StaleTask[];
  actions: StaleAction[];
  onAction: (taskId: string, action: 'keep' | 'archive' | 'break_down') => void;
  onBreakDown: (taskId: string, subtasks: string[]) => void;
}) {
  const getAction = (taskId: string) => actions.find(a => a.taskId === taskId)?.action;
  const [breakingDown, setBreakingDown] = useState<string | null>(null);
  const [subtaskInputs, setSubtaskInputs] = useState<Record<string, string[]>>({});
  const [newSubtask, setNewSubtask] = useState('');

  if (staleTasks.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Stale Tasks</p>
        <p className="mt-3 text-sm text-[var(--text-muted)] text-center py-4">
          🎉 No stale tasks — everything has been touched recently.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Stale Tasks</p>
        <span className="text-xs text-[var(--text-muted)]">14+ days old</span>
      </div>
      <div className="mt-4 space-y-3">
        {staleTasks.map((task) => {
          const currentAction = getAction(task.id);
          const isBreaking = breakingDown === task.id;
          const subs = subtaskInputs[task.id] || [];
          const canArchive = canEditTaskField(task.editPolicy, 'status');
          const archiveBlockedReason = taskFieldBlockedReason(task.editPolicy, 'status');
          return (
            <div key={task.id} className="rounded-[var(--radius-md)] border border-[var(--border)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)]">{task.title}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Last touched {task.daysSinceUpdate} days ago</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(['keep', 'archive', 'break_down'] as const).map((action) => {
                  const icons = { keep: Check, archive: Archive, break_down: Scissors };
                  const labels = { keep: 'Keep', archive: 'Archive', break_down: 'Break down →' };
                  const Icon = icons[action];
                  const disabled = action !== 'keep' && !canArchive;
                  return (
                    <button
                      key={action}
                      disabled={disabled}
                      title={disabled ? archiveBlockedReason : undefined}
                      onClick={() => {
                        if (action === 'break_down') {
                          setBreakingDown(isBreaking ? null : task.id);
                        } else {
                          onAction(task.id, action);
                          setBreakingDown(null);
                        }
                      }}
                      className={cn(
                        'rounded-[var(--radius-md)] border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        currentAction === action
                          ? action === 'break_down'
                            ? 'border-[var(--accent-400)] bg-[var(--accent-900)]/30 text-[var(--accent-400)]'
                            : 'border-[var(--text-muted)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                          : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
                      )}
                    >
                      <Icon size={12} className="inline mr-1" />{labels[action]}
                    </button>
                  );
                })}
              </div>

              {isBreaking && (
                <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--accent-400)]/30 bg-[var(--accent-900)]/10 p-3 space-y-2">
                  <p className="text-xs font-medium text-[var(--accent-400)]">Break into smaller tasks:</p>
                  {subs.map((sub, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-muted)]">•</span>
                      <span className="text-sm text-[var(--text-secondary)] flex-1">{sub}</span>
                      <button
                        onClick={() => {
                          const updated = subs.filter((_, j) => j !== i);
                          setSubtaskInputs(prev => ({ ...prev, [task.id]: updated }));
                        }}
                        className="text-[var(--text-muted)] hover:text-red-400 transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newSubtask.trim()) {
                          setSubtaskInputs(prev => ({
                            ...prev,
                            [task.id]: [...(prev[task.id] || []), newSubtask.trim()],
                          }));
                          setNewSubtask('');
                        }
                      }}
                      placeholder="Add a sub-task…"
                      className="flex-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-400)]"
                    />
                    <button
                      onClick={() => {
                        if (newSubtask.trim()) {
                          setSubtaskInputs(prev => ({
                            ...prev,
                            [task.id]: [...(prev[task.id] || []), newSubtask.trim()],
                          }));
                          setNewSubtask('');
                        }
                      }}
                      disabled={!newSubtask.trim()}
                      className="rounded-[var(--radius-md)] border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Add
                    </button>
                  </div>
                  {subs.length > 0 && (
                    <button
                      onClick={() => {
                        onBreakDown(task.id, subs);
                        setBreakingDown(null);
                        setSubtaskInputs(prev => ({ ...prev, [task.id]: [] }));
                      }}
                      className="w-full mt-1 rounded-[var(--radius-md)] border border-[var(--accent-400)] bg-[var(--accent-900)]/20 px-3 py-1.5 text-xs font-medium text-[var(--accent-400)] hover:bg-[var(--accent-900)]/40 transition-colors"
                    >
                      Create {subs.length} sub-task{subs.length > 1 ? 's' : ''} & archive original
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Reflection Prompts ─────────────────────────────────────────────────────

function ReflectionPrompts({
  wentWell,
  needsAdjustment,
  onWentWellChange,
  onNeedsAdjustmentChange,
}: {
  wentWell: string;
  needsAdjustment: string;
  onWentWellChange: (v: string) => void;
  onNeedsAdjustmentChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <p className="text-sm font-semibold text-[var(--text-primary)]">What went well?</p>
        <div className="mt-4 rounded-[var(--radius-md)] border-l-4 border-green-500/40 bg-green-500/10 p-4">
          <textarea
            value={wentWell}
            onChange={(e) => onWentWellChange(e.target.value)}
            placeholder="Reflect on what worked this week…"
            className="h-36 w-full bg-transparent text-sm text-[var(--text-secondary)] outline-none resize-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
        <p className="text-sm font-semibold text-[var(--text-primary)]">What needs adjustment?</p>
        <div className="mt-4 rounded-[var(--radius-md)] border-l-4 border-amber-500/40 bg-amber-500/10 p-4">
          <textarea
            value={needsAdjustment}
            onChange={(e) => onNeedsAdjustmentChange(e.target.value)}
            placeholder="What didn't work or needs changing…"
            className="h-36 w-full bg-transparent text-sm text-[var(--text-secondary)] outline-none resize-none placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Monthly Stats (month-over-month) ───────────────────────────────────────

function MonthlyStatsGrid({ stats }: { stats: ResetStats }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] mb-4">Month at a Glance</p>
      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Tasks completed', value: String(stats.tasksCompleted) },
          { label: 'Tasks created', value: String(stats.tasksCreated) },
          { label: 'Avg routines', value: `${stats.routinePercentage}%` },
          { label: 'Focus 3 hit rate', value: stats.focusHitRate },
        ].map((item) => (
          <div key={item.label} className="rounded-[var(--radius-md)] bg-[var(--surface-0)] p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Weekly Trend (for monthly view) ────────────────────────────────────────

function WeeklyTrendPanel({ breakdown }: { breakdown: WeeklyBreakdown[] }) {
  if (!breakdown?.length) return null;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)] mb-4">Week-by-Week Trend</p>
      <div className="grid gap-4 md:grid-cols-4">
        {breakdown.map((week, i) => {
          const isLast = i === breakdown.length - 1;
          return (
            <div
              key={week.weekStart}
              className={cn(
                'rounded-[var(--radius-md)] border p-4',
                isLast ? 'border-[var(--accent-400)]/30 bg-[var(--accent-900)]/10' : 'border-[var(--border)]',
              )}
            >
              <p className={cn('text-xs font-medium', isLast ? 'text-[var(--accent-400)]' : 'text-[var(--text-muted)]')}>
                {new Date(week.weekStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {' – '}
                {new Date(week.weekEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {isLast && <span className="ml-1 text-[var(--accent-400)]/60">← latest</span>}
              </p>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Completed</span>
                  <span className="font-semibold tabular-nums text-[var(--text-primary)]">{week.completed}</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--surface-0)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent-400)]"
                    style={{ width: `${Math.min(week.completed * 5, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text-muted)]">Routines</span>
                  <span className="font-semibold tabular-nums text-[var(--text-primary)]">{week.routinePercent}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--surface-0)]">
                  <div
                    className="h-full rounded-full bg-green-400"
                    style={{ width: `${week.routinePercent}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Energy Bar ─────────────────────────────────────────────────────────────

function EnergyBar({ energyData }: { energyData: EnergyEntry[] }) {
  if (!energyData.length) return null;

  const levelColors: Record<string, string> = {
    high: 'bg-green-400',
    medium: 'bg-amber-400',
    low: 'bg-red-400',
  };

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap size={14} className="text-amber-400" />
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Energy × Productivity</p>
      </div>
      <div className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
        <div className="flex gap-0.5">
          {energyData.map((e) => (
            <span
              key={e.date}
              className={cn('inline-block w-6 h-5 rounded', levelColors[e.level] || 'bg-[var(--surface-2)]')}
              title={`${e.date}: ${e.level}`}
            />
          ))}
        </div>
        <span className="text-xs text-[var(--text-muted)]">Energy levels this period</span>
      </div>
    </div>
  );
}

// ─── Main Reset View ────────────────────────────────────────────────────────

export default function ResetView() {
  const today = getClientToday();

  const [cadence, setCadence] = useState<ResetCadence>('weekly');
  const [periodStart, setPeriodStart] = useState(() => getWeekMonday(today));
  const [stats, setStats] = useState<ResetStats | null>(null);
  const [resetData, setResetData] = useState<ResetData | null>(null);
  const [aiSummary, setAiSummary] = useState<AiSummary | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDismissed, setAiDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const periodEnd = cadence === 'weekly' ? getWeekSunday(periodStart) : getMonthEnd(periodStart);

  // Fetch stats + existing reset data
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, resetRes] = await Promise.all([
        fetch(`/api/resets/stats?type=${cadence}&periodStart=${periodStart}`),
        fetch(`/api/resets?type=${cadence}&periodStart=${periodStart}`),
      ]);

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);

        // Auto-populate carry-forward from incomplete Focus 3 items (only for new resets)
        if (resetRes.ok) {
          const resetBody = await resetRes.json();
          if (resetBody.reset) {
            setResetData(resetBody.reset);
            if (resetBody.reset.aiSummary) {
              try {
                setAiSummary(JSON.parse(resetBody.reset.aiSummary));
              } catch {
                setAiSummary({ narrative: resetBody.reset.aiSummary, momentum: null, attention: null, suggestion: null });
              }
            }
          } else {
            // New reset — seed carry-forward from incomplete Focus 3 items
            const incompleteFocus = statsData.incompleteFocusTasks || [];
            if (incompleteFocus.length > 0) {
              const seeded: CarryForwardItem[] = incompleteFocus.map((t: { id: string; title: string; timesInFocus: number }) => ({
                description: t.title,
                detail: `Was in Focus 3 ${t.timesInFocus} time${t.timesInFocus > 1 ? 's' : ''} this period`,
                kept: true,
                taskId: t.id,
              }));
              setResetData({
                type: cadence,
                periodStart,
                periodEnd: cadence === 'weekly' ? getWeekSunday(periodStart) : getMonthEnd(periodStart),
                carryForwardItems: seeded,
                staleActions: [],
              });
            } else {
              setResetData(null);
            }
            setAiSummary(null);
          }
        }
      } else if (resetRes.ok) {
        // Stats failed but reset data exists
        const resetBody = await resetRes.json();
        if (resetBody.reset) {
          setResetData(resetBody.reset);
          if (resetBody.reset.aiSummary) {
            try {
              setAiSummary(JSON.parse(resetBody.reset.aiSummary));
            } catch {
              setAiSummary({ narrative: resetBody.reset.aiSummary, momentum: null, attention: null, suggestion: null });
            }
          }
        } else {
          setResetData(null);
          setAiSummary(null);
        }
      }
    } catch {
      toast.error('Failed to load reset data');
    } finally {
      setLoading(false);
    }
  }, [cadence, periodStart]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Auto-save with debounce
  const autoSave = useCallback(async (data: Partial<ResetData>) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        const payload = {
          type: cadence,
          periodStart,
          periodEnd,
          ...data,
          ...(resetData?.id ? { id: resetData.id } : {}),
        };

        const method = resetData?.id ? 'PATCH' : 'POST';
        const res = await fetch('/api/resets', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const body = await res.json();
          setResetData(body.reset);
        }
      } catch {
        // silent — will retry
      } finally {
        setSaving(false);
      }
    }, 800);
  }, [cadence, periodStart, periodEnd, resetData?.id]);

  // Generate AI summary
  const generateSummary = useCallback(async () => {
    if (!stats) return;
    setAiLoading(true);
    setAiDismissed(false);
    try {
      const res = await fetch('/api/resets/ai-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats }),
      });

      if (res.ok) {
        const body = await res.json();
        setAiSummary(body.summary);
        autoSave({ aiSummary: JSON.stringify(body.summary) });
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to generate summary');
      }
    } catch {
      toast.error('Failed to generate AI summary');
    } finally {
      setAiLoading(false);
    }
  }, [stats, autoSave]);

  // Navigate periods
  const navigatePeriod = (direction: -1 | 1) => {
    const d = new Date(periodStart + 'T12:00:00');
    if (cadence === 'weekly') {
      d.setDate(d.getDate() + direction * 7);
      setPeriodStart(formatDateLocal(d));
    } else {
      d.setMonth(d.getMonth() + direction);
      setPeriodStart(getMonthStart(formatDateLocal(d)));
    }
  };

  const switchCadence = (newCadence: ResetCadence) => {
    setCadence(newCadence);
    if (newCadence === 'weekly') {
      setPeriodStart(getWeekMonday(today));
    } else {
      setPeriodStart(getMonthStart(today));
    }
  };

  // Handle stale task actions
  const handleStaleAction = async (taskId: string, action: 'keep' | 'archive' | 'break_down') => {
    const task = stats?.staleTasks.find((candidate) => candidate.id === taskId);
    if (action !== 'keep' && !canEditTaskField(task?.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'status'));
      return;
    }
    // Actually archive the task via the tasks API
    if (action === 'archive') {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!response.ok) {
        toast.error('Failed to archive task');
        return;
      }
      toast.success('Task archived');
    }

    const current = resetData?.staleActions || [];
    const existing = current.findIndex(a => a.taskId === taskId);
    const updated = existing >= 0
      ? current.map((entry, index) => index === existing ? { taskId, action } : entry)
      : [...current, { taskId, action }];
    autoSave({ staleActions: updated });
    setResetData(prev => prev ? { ...prev, staleActions: updated } : null);
  };

  // Handle break-down: create sub-tasks and archive the original
  const handleBreakDown = async (taskId: string, subtasks: string[]) => {
    const task = stats?.staleTasks.find((candidate) => candidate.id === taskId);
    if (!canEditTaskField(task?.editPolicy, 'status')) {
      toast.error(taskFieldBlockedReason(task?.editPolicy, 'status'));
      return;
    }
    try {
      // Create each sub-task
      const createPromises = subtasks.map(title =>
        fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description: `Broken down from stale task` }),
        })
      );
      const createResponses = await Promise.all(createPromises);
      if (createResponses.some((response) => !response.ok)) {
        throw new Error('Failed to create one or more subtasks');
      }

      // Archive the original task
      const archiveResponse = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (!archiveResponse.ok) {
        throw new Error('Failed to archive the original task');
      }

      await handleStaleAction(taskId, 'break_down');
      toast.success(`Created ${subtasks.length} sub-task${subtasks.length > 1 ? 's' : ''} and archived original`);
    } catch {
      toast.error('Failed to break down task');
    }
  };

  // Handle AI feedback
  const handleAiFeedback = (feedback: 'helpful' | 'not_useful') => {
    if (!aiSummary) return;
    const updated = { ...aiSummary, feedback };
    setAiSummary(updated);
    autoSave({ aiSummary: JSON.stringify(updated) });
  };

  // Complete reset
  const completeReset = async () => {
    const now = new Date().toISOString();
    try {
      const payload = {
        type: cadence,
        periodStart,
        periodEnd,
        ...(resetData || {}),
        stats: stats || undefined,
        completedAt: now,
      };

      const method = resetData?.id ? 'PATCH' : 'POST';
      const body = resetData?.id ? { id: resetData.id, completedAt: now, stats } : payload;

      const res = await fetch('/api/resets', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const resBody = await res.json();
        setResetData(resBody.reset);
        toast.success(`${cadence === 'weekly' ? 'Weekly' : 'Monthly'} reset completed! 🎉`);
      }
    } catch {
      toast.error('Failed to complete reset');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-tertiary)]" />
      </div>
    );
  }

  const isCompleted = !!resetData?.completedAt;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={fadeSlideUp} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-[var(--text-primary)]">
            <CalendarCheck size={20} className="text-[var(--accent-400)]" />
            {cadence === 'weekly' ? 'Weekly' : 'Monthly'} Reset
          </h2>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">
            {cadence === 'weekly'
              ? 'Look back with clarity. Decide what to carry forward.'
              : 'Zoom out. See the bigger picture.'}
          </p>
        </div>

        {/* Weekly / Monthly toggle */}
        <div className="inline-flex rounded-[var(--radius-lg)] bg-[var(--surface-1)] border border-[var(--border)] p-1">
          <button
            onClick={() => switchCadence('weekly')}
            className={cn(
              'rounded-[var(--radius-md)] px-4 py-1.5 text-sm font-medium transition-colors',
              cadence === 'weekly'
                ? 'bg-[var(--accent-400)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            Weekly
          </button>
          <button
            onClick={() => switchCadence('monthly')}
            className={cn(
              'rounded-[var(--radius-md)] px-4 py-1.5 text-sm font-medium transition-colors',
              cadence === 'monthly'
                ? 'bg-[var(--accent-400)] text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            Monthly
          </button>
        </div>
      </motion.div>

      {/* Period Navigator */}
      <motion.div variants={fadeSlideUp} className="flex items-center justify-center gap-3">
        <button
          onClick={() => navigatePeriod(-1)}
          className="p-2 rounded-[var(--radius-md)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-medium text-[var(--text-primary)] tabular-nums min-w-[14rem] text-center">
          {cadence === 'weekly' ? formatWeekRange(periodStart) : formatMonth(periodStart)}
        </span>
        <button
          onClick={() => navigatePeriod(1)}
          className="p-2 rounded-[var(--radius-md)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
        >
          <ChevronRight size={16} />
        </button>
        {saving && (
          <span className="text-xs text-[var(--text-muted)] ml-2">
            <Loader2 size={10} className="inline animate-spin mr-1" />Saving…
          </span>
        )}
        {isCompleted && (
          <span className="rounded-full bg-green-500/20 px-2.5 py-0.5 text-xs font-medium text-green-400 ml-2">
            <Check size={10} className="inline mr-1" />Completed
          </span>
        )}
      </motion.div>

      {stats && (
        <>
          {/* Stats */}
          <motion.div variants={fadeSlideUp}>
            {cadence === 'weekly' ? <StatsGrid stats={stats} /> : <MonthlyStatsGrid stats={stats} />}
          </motion.div>

          {/* Weekly trend (monthly only) */}
          {cadence === 'monthly' && stats.weeklyBreakdown && (
            <motion.div variants={fadeSlideUp}>
              <WeeklyTrendPanel breakdown={stats.weeklyBreakdown} />
            </motion.div>
          )}

          {/* AI Summary */}
          {!aiDismissed && (
            <motion.div variants={fadeSlideUp}>
              {aiSummary || aiLoading ? (
                <AiSummaryCard
                  summary={aiSummary}
                  loading={aiLoading}
                  onRegenerate={generateSummary}
                  onDismiss={() => setAiDismissed(true)}
                  onFeedback={handleAiFeedback}
                />
              ) : (
                <button
                  onClick={generateSummary}
                  className="w-full rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] bg-[var(--surface-1)] p-5 text-center hover:bg-[var(--surface-2)] transition-colors group"
                >
                  <Sparkles size={20} className="mx-auto text-[var(--text-muted)] group-hover:text-[var(--accent-400)] transition-colors" />
                  <p className="mt-2 text-sm font-medium text-[var(--text-secondary)]">Generate AI Summary</p>
                  <p className="text-xs text-[var(--text-muted)]">Analyze your week and get personalized insights</p>
                </button>
              )}
            </motion.div>
          )}

          {/* Reflection Prompts */}
          <motion.div variants={fadeSlideUp}>
            <ReflectionPrompts
              wentWell={resetData?.wentWell || ''}
              needsAdjustment={resetData?.needsAdjustment || ''}
              onWentWellChange={(v) => {
                setResetData(prev => prev ? { ...prev, wentWell: v } : { type: cadence, periodStart, periodEnd, wentWell: v, staleActions: [], carryForwardItems: [] });
                autoSave({ wentWell: v });
              }}
              onNeedsAdjustmentChange={(v) => {
                setResetData(prev => prev ? { ...prev, needsAdjustment: v } : { type: cadence, periodStart, periodEnd, needsAdjustment: v, staleActions: [], carryForwardItems: [] });
                autoSave({ needsAdjustment: v });
              }}
            />
          </motion.div>

          {/* Carry Forward + Stale Tasks (side by side) */}
          <motion.div variants={fadeSlideUp} className="grid gap-6 lg:grid-cols-2">
            <CarryForwardPanel
              items={resetData?.carryForwardItems || []}
              onChange={(items) => {
                setResetData(prev => prev ? { ...prev, carryForwardItems: items } : null);
                autoSave({ carryForwardItems: items });
              }}
            />
            <StaleTasksPanel
              staleTasks={stats.staleTasks}
              actions={resetData?.staleActions || []}
              onAction={handleStaleAction}
              onBreakDown={handleBreakDown}
            />
          </motion.div>

          {/* Energy */}
          {stats.energyData.length > 0 && (
            <motion.div variants={fadeSlideUp}>
              <EnergyBar energyData={stats.energyData} />
            </motion.div>
          )}

          {/* Complete button */}
          {!isCompleted && (
            <motion.div variants={fadeSlideUp} className="flex justify-end">
              <Button onClick={completeReset} className="bg-[var(--accent-400)] hover:bg-[var(--accent-500)] text-white">
                Complete {cadence === 'weekly' ? 'Weekly' : 'Monthly'} Reset
              </Button>
            </motion.div>
          )}
        </>
      )}
    </motion.div>
  );
}
