'use client';

import { useCallback, useRef } from 'react';
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { Check, FileText, FolderOpen, RotateCcw, SkipForward, Sparkles, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { triggerHaptic } from '@/lib/utils/haptics';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { canEditTaskField, taskFieldBlockedReason } from '@/lib/tasks/client-edit-policy';
import type { QuickSortQueueMode, QuickSortQueueTask, QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';
import { getMissingFields } from '@/lib/hooks/useQuickSortData';

const SWIPE_THRESHOLD_X = 100;
const SWIPE_THRESHOLD_Y = 100;
const SWIPE_MIN_TRAVEL = 56;
const SWIPE_VELOCITY_THRESHOLD = 500;
const SWIPE_AXIS_DOMINANCE = 1.25;
const SWIPE_AXIS_LOCK_DISTANCE = 12;

type QuickSortSwipeAction = 'acceptSuggestions' | 'acceptFocused' | 'skip' | 'blockedSkip' | 'undo' | 'snapBack';

export function getQuickSortGestureAxis(offsetX: number, offsetY: number): 'x' | 'y' | null {
  const absoluteX = Math.abs(offsetX);
  const absoluteY = Math.abs(offsetY);
  if (Math.max(absoluteX, absoluteY) < SWIPE_AXIS_LOCK_DISTANCE) return null;
  if (absoluteX >= absoluteY * SWIPE_AXIS_DOMINANCE) return 'x';
  if (absoluteY >= absoluteX * SWIPE_AXIS_DOMINANCE) return 'y';
  return null;
}

function isCommittedSwipe({
  primaryOffset,
  secondaryOffset,
  primaryVelocity,
  direction,
  threshold,
}: {
  primaryOffset: number;
  secondaryOffset: number;
  primaryVelocity: number;
  direction: 'negative' | 'positive';
  threshold: number;
}) {
  const directionMatches = direction === 'negative' ? primaryOffset < 0 : primaryOffset > 0;
  const velocityMatches = direction === 'negative'
    ? primaryVelocity <= -SWIPE_VELOCITY_THRESHOLD
    : primaryVelocity >= SWIPE_VELOCITY_THRESHOLD;
  const travel = Math.abs(primaryOffset);
  return (
    directionMatches
    && travel >= SWIPE_MIN_TRAVEL
    && travel >= Math.abs(secondaryOffset) * SWIPE_AXIS_DOMINANCE
    && (travel >= threshold || velocityMatches)
  );
}

export function getQuickSortSwipeAction({
  axis,
  offsetX,
  offsetY,
  velocityX,
  velocityY,
  hasSuggestions,
  hasFocusedSuggestion,
  hasUndo = false,
  canSkip = true,
  busy = false,
}: {
  axis: 'x' | 'y' | null;
  offsetX: number;
  offsetY: number;
  velocityX: number;
  velocityY: number;
  hasSuggestions: boolean;
  hasFocusedSuggestion: boolean;
  hasUndo?: boolean;
  canSkip?: boolean;
  busy?: boolean;
}): QuickSortSwipeAction {
  if (busy) return 'snapBack';

  if (
    axis === 'x' &&
    hasSuggestions &&
    isCommittedSwipe({
      primaryOffset: offsetX,
      secondaryOffset: offsetY,
      primaryVelocity: velocityX,
      direction: 'negative',
      threshold: SWIPE_THRESHOLD_X,
    })
  ) {
    return 'acceptSuggestions';
  }

  if (
    axis === 'x' &&
    hasFocusedSuggestion &&
    isCommittedSwipe({
      primaryOffset: offsetX,
      secondaryOffset: offsetY,
      primaryVelocity: velocityX,
      direction: 'positive',
      threshold: SWIPE_THRESHOLD_X,
    })
  ) {
    return 'acceptFocused';
  }

  if (
    axis === 'y' &&
    isCommittedSwipe({
      primaryOffset: offsetY,
      secondaryOffset: offsetX,
      primaryVelocity: velocityY,
      direction: 'negative',
      threshold: SWIPE_THRESHOLD_Y,
    })
  ) {
    return canSkip ? 'skip' : 'blockedSkip';
  }

  if (
    axis === 'y'
    && hasUndo
    && isCommittedSwipe({
      primaryOffset: offsetY,
      secondaryOffset: offsetX,
      primaryVelocity: velocityY,
      direction: 'positive',
      threshold: SWIPE_THRESHOLD_Y,
    })
  ) {
    return 'undo';
  }

  return 'snapBack';
}

const EFFORT_LABELS: Record<number, string> = { 1: 'XS', 2: 'S', 3: 'M', 4: 'L', 5: 'XL' };

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 0) return 'Upcoming';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function sourceLabel(connectorType: string) {
  const map: Record<string, string> = {
    'microsoft-todo': 'To Do',
    'ms-todo': 'To Do',
    'github-issues': 'GitHub',
    local: 'Local',
    'google-tasks': 'Google Tasks',
    jira: 'Jira',
    linear: 'Linear',
    asana: 'Asana',
    notion: 'Notion',
  };
  return map[connectorType] ?? connectorType;
}

interface QuickSortCardProps {
  task: QuickSortQueueTask;
  mode: QuickSortQueueMode;
  suggestion?: QuickSortSuggestion;
  /** 0 = top card, 1 = second card behind, 2 = third card */
  stackIndex: number;
  /** Swipe left: accept ALL AI suggestions */
  onAcceptSuggestions: (taskId: string) => void;
  /** Swipe right: accept only the current mode's suggestion */
  onAcceptFocused: (taskId: string) => void;
  /** Swipe up: skip this task */
  onSkip: (taskId: string) => void | Promise<void>;
  /** Swipe down: undo the previous Quick Sort operation */
  onUndo?: () => void | Promise<void>;
  undoLabel?: string;
  busy?: boolean;
}

export default function QuickSortCard({
  task,
  mode,
  suggestion,
  stackIndex,
  onAcceptSuggestions,
  onAcceptFocused,
  onSkip,
  onUndo,
  undoLabel,
  busy = false,
}: QuickSortCardProps) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const dragAxis = useRef<'x' | 'y' | null>(null);

  const hasSuggestions = !!(suggestion && (suggestion.priority || suggestion.effort || suggestion.tags.length > 0));
  const hasFocusedSuggestion = !!(
    suggestion &&
    ((mode === 'no_priority' && suggestion.priority) ||
      (mode === 'no_effort' && suggestion.effort) ||
      (mode === 'no_tags' && suggestion.tags.length > 0))
  );
  const canSkip = canEditTaskField(task.editPolicy, 'snoozedUntil');
  const skipBlockedReason = canSkip
    ? undefined
    : taskFieldBlockedReason(task.editPolicy, 'snoozedUntil');

  // Swipe-left reveal: card slides left, showing action boxes on right
  const revealWidth = useTransform(x, [-200, 0], [200, 0]);
  const revealOpacity = useTransform(x, [-SWIPE_THRESHOLD_X, -40, 0], [1, 0.6, 0]);

  // Swipe-right focused apply
  const focusedRevealWidth = useTransform(x, [0, 200], [0, 160]);
  const focusedRevealOpacity = useTransform(x, [0, 40, SWIPE_THRESHOLD_X], [0, 0.6, 1]);
  const skipRevealOpacity = useTransform(y, [-SWIPE_THRESHOLD_Y, -40, 0], [1, 0.6, 0]);
  const undoRevealOpacity = useTransform(y, [0, 40, SWIPE_THRESHOLD_Y], [0, 0.6, 1]);

  const handleDragStart = useCallback(() => {
    dragAxis.current = null;
  }, []);

  const handleDrag = useCallback(
    (_: unknown, info: PanInfo) => {
      if (busy) return;
      if (!dragAxis.current) {
        dragAxis.current = getQuickSortGestureAxis(info.offset.x, info.offset.y);
      }

      if (dragAxis.current === 'x') {
        // Allow left swipe (all suggestions) and right swipe (focused suggestion)
        if (info.offset.x < 0) {
          x.set(hasSuggestions ? info.offset.x : Math.max(-30, info.offset.x));
        } else {
          x.set(hasFocusedSuggestion ? info.offset.x : Math.min(30, info.offset.x));
        }
      } else if (dragAxis.current === 'y') {
        y.set(info.offset.y < 0
          ? info.offset.y
          : onUndo ? info.offset.y : Math.min(30, info.offset.y));
      }
    },
    [busy, x, y, hasSuggestions, hasFocusedSuggestion, onUndo]
  );

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      const axis = dragAxis.current;
      dragAxis.current = null;

      const action = getQuickSortSwipeAction({
        axis,
        offsetX: info.offset.x,
        offsetY: info.offset.y,
        velocityX: info.velocity.x,
        velocityY: info.velocity.y,
        hasSuggestions,
        hasFocusedSuggestion,
        hasUndo: !!onUndo,
        canSkip,
        busy,
      });

      if (action === 'acceptSuggestions') {
        // Swipe left = accept ALL AI suggestions
        triggerHaptic('medium');
        onAcceptSuggestions(task.id);
      } else if (action === 'acceptFocused') {
        // Swipe right = accept only current mode's suggestion
        triggerHaptic('medium');
        onAcceptFocused(task.id);
      } else if (action === 'skip') {
        triggerHaptic('medium');
        const skipTarget = -Math.max(window.innerHeight, 600);
        void animate(y, skipTarget, { duration: 0.18, ease: 'easeIn' }).then(() => {
          try {
            void Promise.resolve(onSkip(task.id)).finally(() => {
              animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 });
            });
          } catch {
            animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 });
          }
        });
      } else if (action === 'blockedSkip') {
        triggerHaptic('light');
        void onSkip(task.id);
        animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 });
      } else if (action === 'undo' && onUndo) {
        triggerHaptic('medium');
        void Promise.resolve(onUndo()).finally(() => {
          animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 });
        });
      } else {
        // Snap back with spring animation
        animate(x, 0, { type: 'spring', stiffness: 400, damping: 30 });
        animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 });
      }
    },
    [
      busy,
      canSkip,
      hasFocusedSuggestion,
      hasSuggestions,
      onAcceptFocused,
      onAcceptSuggestions,
      onSkip,
      onUndo,
      task.id,
      x,
      y,
    ]
  );

  // Build the list of suggestions to show in the reveal area (swipe left)
  const suggestionActions: Array<{ label: string; detail: string; confidence: number }> = [];

  if (suggestion?.priority) {
    const labels: Record<string, string> = { critical: 'P0 Critical', high: 'P1 High', medium: 'P2 Medium', low: 'P3 Low' };
    suggestionActions.push({ label: 'Priority', detail: labels[suggestion.priority.value] ?? suggestion.priority.value, confidence: suggestion.priority.confidence });
  }
  if (suggestion?.effort) {
    suggestionActions.push({ label: 'Effort', detail: EFFORT_LABELS[suggestion.effort.value] ?? `${suggestion.effort.value}`, confidence: suggestion.effort.confidence });
  }
  if (suggestion?.tags && suggestion.tags.length > 0) {
    const avgConfidence = suggestion.tags.reduce((sum, t) => sum + t.confidence, 0) / suggestion.tags.length;
    suggestionActions.push({ label: 'Tags', detail: suggestion.tags.map((t) => t.name).join(', '), confidence: avgConfidence });
  }

  // Compute the primary confidence % to display on the card (F-50)
  const primaryConfidence = suggestion
    ? mode === 'no_priority' && suggestion.priority
      ? suggestion.priority.confidence
      : mode === 'no_effort' && suggestion.effort
        ? suggestion.effort.confidence
        : mode === 'no_tags' && suggestion.tags.length > 0
          ? suggestion.tags.reduce((sum, t) => sum + t.confidence, 0) / suggestion.tags.length
          : null
    : null;

  // AI reasoning text for the focused mode (F-51)
  const aiReasoning = suggestion
    ? mode === 'no_priority' && suggestion.priority
      ? suggestion.priority.reason
      : mode === 'no_effort' && suggestion.effort
        ? suggestion.effort.reason
        : null
    : null;

  // Focused suggestion detail (swipe right — only current mode)
  let focusedLabel = '';
  let focusedDetail = '';
  if (mode === 'no_priority' && suggestion?.priority) {
    const labels: Record<string, string> = { critical: 'P0 Critical', high: 'P1 High', medium: 'P2 Medium', low: 'P3 Low' };
    focusedLabel = 'Priority';
    focusedDetail = labels[suggestion.priority.value] ?? suggestion.priority.value;
  } else if (mode === 'no_effort' && suggestion?.effort) {
    focusedLabel = 'Effort';
    focusedDetail = EFFORT_LABELS[suggestion.effort.value] ?? `${suggestion.effort.value}`;
  } else if (mode === 'no_tags' && suggestion?.tags && suggestion.tags.length > 0) {
    focusedLabel = 'Tags';
    focusedDetail = suggestion.tags.map((t) => t.name).join(', ');
  }

  const missingFields = getMissingFields(task);

  const modePrompt =
    mode === 'no_priority'
      ? "What's the priority?"
      : mode === 'no_effort'
        ? 'How much effort?'
        : mode === 'no_tags'
          ? 'What tags apply?'
          : 'When is it due?';

  // Cards behind the top card render as passive stack layers.
  const isTop = stackIndex === 0;

  if (!isTop) {
    return (
      <div
        className="absolute inset-x-0 rounded-[31px] bg-white/[0.03] ring-1 ring-inset ring-white/[0.05] pointer-events-none"
        style={{
          top: stackIndex * 6,
          left: stackIndex * 6,
          right: stackIndex * 6,
          bottom: 0,
          zIndex: 10 - stackIndex,
        }}
      />
    );
  }

  return (
    <div className="relative h-full min-h-0" style={{ zIndex: 20 }}>
      {/* Reveal area behind the card (shown when swiping left) */}
      {hasSuggestions && (
        <motion.div
          className="absolute right-0 top-0 bottom-0 flex flex-col justify-center gap-2 pr-3"
          style={{ opacity: revealOpacity, width: revealWidth }}
        >
          <div className="flex items-center gap-1 mb-1">
            <Sparkles size={12} className="text-green-400" />
            <span className="text-[10px] font-semibold text-green-400 uppercase tracking-wide">AI Suggests</span>
          </div>
          {suggestionActions.map((action) => (
            <div
              key={action.label}
              className="flex items-center gap-2 rounded-lg bg-green-900/60 border border-green-700/50 px-3 py-2"
            >
              <Check size={14} className="text-green-400 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] text-green-400/70 font-medium">{action.label}</div>
                <div className="text-xs text-green-300 font-semibold truncate">{action.detail}</div>
              </div>
            </div>
          ))}
        </motion.div>
      )}

      <motion.div
        className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 pb-4"
        style={{ opacity: skipRevealOpacity }}
        aria-hidden="true"
      >
        <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-950/70 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
          <SkipForward size={14} />
          Skip
        </div>
      </motion.div>

      {onUndo && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 pt-4"
          style={{ opacity: undoRevealOpacity }}
          aria-hidden="true"
        >
          <span className="inline-flex items-center gap-2 rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-lg">
            <RotateCcw size={15} />
            Undo {undoLabel}
          </span>
        </motion.div>
      )}

      {/* Reveal area on the LEFT (shown when swiping RIGHT — focused apply) */}
      {hasFocusedSuggestion && (
        <motion.div
          className="absolute left-0 top-0 bottom-0 flex flex-col justify-center gap-2 pl-3"
          style={{ opacity: focusedRevealOpacity, width: focusedRevealWidth }}
        >
          <div className="flex items-center gap-1 mb-1">
            <Sparkles size={12} className="text-blue-400" />
            <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wide">Apply</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-blue-900/60 border border-blue-700/50 px-3 py-2">
            <Check size={14} className="text-blue-400 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-[10px] text-blue-400/70 font-medium">{focusedLabel}</div>
              <div className="text-xs text-blue-300 font-semibold truncate">{focusedDetail}</div>
            </div>
          </div>
        </motion.div>
      )}

      {/* The card itself — fills available height for a larger swipe target */}
      <motion.div
        data-quick-sort-card-task-id={task.id}
        tabIndex={-1}
        aria-label={`Task: ${task.title}`}
        className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[32px] bg-white/[0.04] shadow-2xl ring-1 ring-inset ring-white/[0.08] backdrop-blur-xl"
        style={{ x, y }}
      >
        <div
          aria-label="Task details"
          className="quick-sort-card-details flex min-h-0 flex-1 touch-pan-y flex-col gap-4 overflow-y-auto overscroll-contain p-5"
          role="region"
          tabIndex={0}
        >
          {/* Header: source badge + age */}
          <div className="flex items-start justify-between gap-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ring-inset',
                task.connectorType === 'microsoft-todo' || task.connectorType === 'ms-todo'
                  ? 'bg-blue-500/15 text-blue-200 ring-blue-400/25'
                  : task.connectorType === 'github-issues'
                    ? 'bg-violet-500/15 text-violet-200 ring-violet-400/25'
                    : 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/25'
              )}
            >
              {sourceLabel(task.connectorType)}
            </span>
            <div className="text-right flex-shrink-0">
              <p className="text-[12px] text-slate-500" title={`Created ${task.createdAt}`}>
                Created {formatDate(task.createdAt)}
              </p>
            </div>
          </div>

          {/* Title */}
          <h2 className="text-[20px] font-semibold leading-7 text-white">{task.title}</h2>

          {/* Subtitle: source list + missing info */}
          {task.sourceListName && (
            <p className="text-[13px] leading-5 text-slate-400">
              From &ldquo;{task.sourceListName}&rdquo; list
              {task.priority === 'none' && ' · no priority set'}
              {task.effort === null && ' · no effort estimate'}
            </p>
          )}

          {/* Compact context; full notes and relationships are available in View task. */}
          {(task.projects.length > 0 || task.phases.length > 0 || task.hasNotes) && (
            <div className="flex flex-wrap gap-2 text-[11px]">
              {task.projects.map((project) => (
                <span
                  key={project.id}
                  className="inline-flex max-w-[160px] items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 font-medium text-indigo-200 ring-1 ring-inset ring-indigo-400/20"
                >
                  <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: project.color }} />
                  <span className="truncate">{project.name}</span>
                </span>
              ))}
              {task.phases.map((phase) => (
                <span
                  key={phase.id}
                  className="inline-flex max-w-[160px] items-center gap-1 rounded-full bg-cyan-500/10 px-2.5 py-1 text-cyan-200 ring-1 ring-inset ring-cyan-400/20"
                >
                  <FolderOpen size={10} className="flex-shrink-0" />
                  <span className="truncate">{phase.name}</span>
                </span>
              ))}
              {task.hasNotes && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-slate-400 ring-1 ring-inset ring-white/10">
                  <FileText size={10} />
                  Has notes
                </span>
              )}
            </div>
          )}

          {/* Existing metadata chips */}
          <div className="flex flex-wrap gap-2">
            {task.priority && task.priority !== 'none' && (
              <span className="text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset ring-amber-400/25 bg-amber-500/14 text-amber-200 font-medium">
                {task.priority}
              </span>
            )}
            {task.effort && (
              <span className="text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset ring-sky-400/25 bg-sky-500/14 text-sky-200 font-medium">
                {EFFORT_LABELS[task.effort] ?? `E${task.effort}`}
              </span>
            )}
            {task.tags.filter(tag => !isSyntheticTag(tag.name)).map((tag) => (
              <span
                key={tag.id}
                className="text-[11px] px-2.5 py-1 rounded-full ring-1 ring-inset ring-white/10 bg-white/[0.04] text-slate-300 flex items-center gap-1.5"
              >
                {tag.color && (
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                )}
                {tag.name}
              </span>
            ))}
            {task.tags.filter(tag => !isSyntheticTag(tag.name)).length === 0 && mode !== 'no_tags' && (
              <span className="text-[11px] text-slate-500 flex items-center gap-1">
                <Tag size={10} />
                no tags
              </span>
            )}
          </div>

          {/* Missing fields indicator (for multi-attribute awareness) */}
          {missingFields.length > 1 && (
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <span>Also needs:</span>
              {missingFields
                .filter((f) => f !== mode)
                .map((f) => (
                  <span
                    key={f}
                    className="px-1.5 py-0.5 rounded-full bg-white/[0.04] ring-1 ring-inset ring-white/10"
                  >
                    {f === 'no_priority' ? 'priority' : f === 'no_effort' ? 'effort' : f === 'no_tags' ? 'tags' : 'due date'}
                  </span>
                ))}
            </div>
          )}

          {/* AI suggestion preview — shows what swipe-left will apply */}
          {suggestionActions.length > 0 && (
            <div className="rounded-[22px] bg-violet-500/10 px-4 py-3 ring-1 ring-inset ring-violet-400/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles size={12} className="text-violet-300" />
                  <span className="text-[12px] font-semibold text-violet-200">Houston suggests</span>
                </div>
                {primaryConfidence !== null && (
                  <span className="text-[11px] font-medium text-violet-300/80">
                    {Math.round(primaryConfidence * 100)}% confident
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {suggestionActions.map((action) => (
                  <span
                    key={action.label}
                    className="text-[13px] text-violet-100/80"
                  >
                    {action.label}: <span className="font-semibold text-amber-300">{action.detail}</span>
                  </span>
                ))}
              </div>
              {/* AI reasoning text (F-51) */}
              {aiReasoning && (
                <p className="mt-2 text-[12px] leading-relaxed text-violet-200/60 italic">
                  {aiReasoning}
                </p>
              )}
            </div>
          )}

          {/* Mode prompt */}
          <div className="mt-auto px-4 py-3 rounded-[22px] bg-white/[0.03] ring-1 ring-inset ring-white/[0.06]">
            <p className="text-[13px] text-slate-300 font-medium">{modePrompt}</p>
          </div>
        </div>
        <motion.div
          className={cn(
            'flex h-11 flex-shrink-0 touch-none select-none items-center justify-center gap-2 border-t border-white/[0.06] px-3 text-xs text-slate-400',
            busy ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing',
          )}
          data-testid="quick-sort-swipe-handle"
          role="group"
          aria-disabled={busy}
          aria-label={[
            'Swipe handle.',
            hasSuggestions ? 'Swipe left to apply all AI suggestions.' : '',
            hasFocusedSuggestion ? 'Swipe right to apply the focused AI suggestion.' : '',
            canSkip ? 'Swipe up to skip.' : `Skip unavailable. ${skipBlockedReason}`,
            onUndo ? `Swipe down to undo ${undoLabel ?? 'the previous action'}.` : '',
          ].filter(Boolean).join(' ')}
          title={!canSkip ? skipBlockedReason : undefined}
          onPanStart={handleDragStart}
          onPan={handleDrag}
          onPanEnd={handleDragEnd}
        >
          <span className="h-1 w-8 flex-shrink-0 rounded-full bg-slate-600" aria-hidden="true" />
          <span className="truncate" aria-hidden="true">
            {hasSuggestions || hasFocusedSuggestion ? 'Left/right: AI · ' : ''}
            {canSkip ? 'Up: skip' : 'Skip unavailable'}
            {onUndo ? ' · Down: undo' : ''}
          </span>
        </motion.div>
      </motion.div>
    </div>
  );
}
