'use client';

import { useCallback, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, useReducedMotion, type PanInfo } from 'motion/react';
import {
  Archive, Calendar, CalendarClock, Check, CircleCheck, Clock, Moon, Sun, X,
} from 'lucide-react';
import { CompletionBurst } from '@/components/ui/CompletionBurst';
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { triggerHaptic, triggerHapticFeedback } from '@/lib/utils/haptics';
import { formatDueDate } from '@/lib/utils/date-format';
import { getLocalToday } from '@/lib/utils/client-date';
import { isInactiveTaskStatus } from '@/lib/constants/task-formatting';
import { CONNECTOR_ICONS } from '@/types/dashboard';
import type { MyDayItem } from './types';
import {
  canEditTaskField,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { LocalDisposition } from '@/types';

const PRIORITY_DOT_COLORS: Record<string, string> = {
  critical: 'bg-rose-400',
  high: 'bg-orange-400',
  medium: 'bg-amber-300',
  low: 'bg-sky-400',
  none: 'bg-gray-500',
};

const SWIPE_THRESHOLD = 80;
const FULL_SWIPE_THRESHOLD = 160;

interface HubProject {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  phases?: { id: string; name: string }[];
}

interface MobileSwipeTaskRowProps {
  item: MyDayItem;
  onComplete: (taskId: string) => void;
  onRemoveFromDay: (taskId: string) => void;
  onSetLocalDisposition?: (taskId: string, disposition: LocalDisposition) => void;
  onTap: (item: MyDayItem) => void;
  onScheduleTomorrow: (taskId: string) => void;
  onSchedulePickDay: (taskId: string) => void;
  onSnooze: (taskId: string, duration: '1hr' | '3hr' | 'tonight') => void;
  isCompleting?: boolean;
  /** Whether this is a high-priority item that should show AI suggestion chip */
  showAiChip?: boolean;
  aiSuggestion?: string;
  projects?: HubProject[];
  /** Controlled: whether the scheduling tray is open for this row */
  scheduleTrayOpen?: boolean;
  /** Controlled: notify parent when tray open state changes */
  onScheduleTrayChange?: (open: boolean) => void;
}

/**
 * Mobile-optimized task row with swipe gestures.
 *
 * Covers:
 * - F-18: Each row: priority dot, title, project tag, due indicator
 * - F-24: Left swipe: reveal "Not Today" action (short swipe reveals, full swipe executes)
 * - F-25: Right swipe: reveal scheduling tray
 * - F-26: Scheduling tray options: Tomorrow, Pick Day, Snooze (1hr/3hr/tonight)
 * - F-27: Tap dot/checkbox to complete
 * - F-28: Add haptic feedback on swipe threshold
 */
export function MobileSwipeTaskRow({
  item,
  onComplete,
  onRemoveFromDay,
  onSetLocalDisposition,
  onTap,
  onScheduleTomorrow,
  onSchedulePickDay,
  onSnooze,
  isCompleting = false,
  showAiChip = false,
  aiSuggestion,
  projects = [],
  scheduleTrayOpen,
  onScheduleTrayChange,
}: MobileSwipeTaskRowProps) {
  const x = useMotionValue(0);
  const [swipeState, setSwipeState] = useState<'idle' | 'left-reveal' | 'right-reveal'>('idle');
  const [internalShowTray, setInternalShowTray] = useState(false);
  const hapticTriggered = useRef(false);
  const prefersReducedMotion = useReducedMotion();

  // Support both controlled (parent manages) and uncontrolled (local state) modes
  const showScheduleTray = scheduleTrayOpen ?? internalShowTray;
  const setShowScheduleTray = useCallback((open: boolean) => {
    if (onScheduleTrayChange) {
      onScheduleTrayChange(open);
    } else {
      setInternalShowTray(open);
    }
  }, [onScheduleTrayChange]);

  const today = getLocalToday();
  const dueDateStr = item.dueDate?.split('T')[0] ?? null;
  const isOverdue = !!dueDateStr && dueDateStr < today;
  const isDueToday = dueDateStr === today;
  const canEditDueDate = canEditTaskField(item.editPolicy, 'dueDate');
  const canEditSnooze = canEditTaskField(item.editPolicy, 'snoozedUntil');
  const canEditStatus = canEditTaskField(item.editPolicy, 'status');
  const dispositionOptions = TASK_DISPOSITION_OPTIONS.filter((option) => (
    option.value !== 'active'
    && option.value !== item.localDisposition
    && canSetTaskLocalDisposition(item.editPolicy, item.localDisposition, option.value)
  ));

  // Background colors for swipe indicators
  const leftBgOpacity = useTransform(x, [-FULL_SWIPE_THRESHOLD, -SWIPE_THRESHOLD, 0], [1, 0.6, 0]);
  const rightBgOpacity = useTransform(x, [0, SWIPE_THRESHOLD, FULL_SWIPE_THRESHOLD], [0, 0.6, 1]);

  const handleDrag = useCallback((_: unknown, info: PanInfo) => {
    const offset = info.offset.x;
    if (offset < -SWIPE_THRESHOLD && swipeState !== 'left-reveal') {
      setSwipeState('left-reveal');
      if (!hapticTriggered.current) {
        triggerHaptic('medium');
        hapticTriggered.current = true;
      }
    } else if (offset > SWIPE_THRESHOLD && swipeState !== 'right-reveal') {
      setSwipeState('right-reveal');
      if (!hapticTriggered.current) {
        triggerHaptic('medium');
        hapticTriggered.current = true;
      }
    } else if (Math.abs(offset) < SWIPE_THRESHOLD) {
      setSwipeState('idle');
      hapticTriggered.current = false;
    }
  }, [swipeState]);

  const handleDragEnd = useCallback((_: unknown, info: PanInfo) => {
    const offset = info.offset.x;
    hapticTriggered.current = false;

    if (offset < -FULL_SWIPE_THRESHOLD) {
      // Full left swipe — execute "Not Today"
      triggerHapticFeedback('defer');
      onRemoveFromDay(item.taskId);
    } else if (offset < -SWIPE_THRESHOLD) {
      // Short left swipe — reveal "Not Today" button (reset but show action)
      setSwipeState('idle');
      // Execute since it was revealed
      triggerHapticFeedback('defer');
      onRemoveFromDay(item.taskId);
    } else if (offset > SWIPE_THRESHOLD) {
      // Right swipe — reveal scheduling tray
      triggerHaptic('medium');
      setShowScheduleTray(true);
    }

    setSwipeState('idle');
  }, [item.taskId, onRemoveFromDay, setShowScheduleTray]);

  const handleCompleteTap = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    triggerHapticFeedback('taskComplete');
    onComplete(item.taskId);
  }, [item.taskId, onComplete]);

  if (showScheduleTray) {
    return (
      <div className="bg-[var(--surface-0)] border-b border-[var(--border-subtle)]">
        <div className="px-4 py-2">
          <p className="text-xs text-[var(--text-muted)] mb-2 truncate">{item.title}</p>
        </div>
        <div className="flex items-center gap-2 pl-4 pb-3">
          <div className="flex items-center gap-2 overflow-x-auto min-w-0">
            <button
              onClick={() => { onScheduleTomorrow(item.taskId); setShowScheduleTray(false); triggerHaptic('light'); }}
              disabled={!canEditDueDate}
              title={!canEditDueDate ? taskFieldBlockedReason(item.editPolicy, 'dueDate') : undefined}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-blue-900/20 text-blue-400 rounded-lg active:bg-blue-900/30 min-h-[44px] whitespace-nowrap"
              aria-label="Schedule for tomorrow"
            >
              <CalendarClock size={14} />
              Tomorrow
            </button>
            <button
              onClick={() => { onSchedulePickDay(item.taskId); setShowScheduleTray(false); triggerHaptic('light'); }}
              disabled={!canEditDueDate}
              title={!canEditDueDate ? taskFieldBlockedReason(item.editPolicy, 'dueDate') : undefined}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-purple-900/20 text-purple-400 rounded-lg active:bg-purple-900/30 min-h-[44px] whitespace-nowrap"
              aria-label="Pick a specific day"
            >
              <Calendar size={14} />
              Pick Day
            </button>
            <button
              onClick={() => { onSnooze(item.taskId, '1hr'); setShowScheduleTray(false); triggerHapticFeedback('defer'); }}
              disabled={!canEditSnooze}
              title={!canEditSnooze ? taskFieldBlockedReason(item.editPolicy, 'snoozedUntil') : undefined}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-amber-900/20 text-amber-400 rounded-lg active:bg-amber-900/30 min-h-[44px] whitespace-nowrap"
              aria-label="Snooze for 1 hour"
            >
              <Clock size={14} />
              1hr
            </button>
            <button
              onClick={() => { onSnooze(item.taskId, '3hr'); setShowScheduleTray(false); triggerHapticFeedback('defer'); }}
              disabled={!canEditSnooze}
              title={!canEditSnooze ? taskFieldBlockedReason(item.editPolicy, 'snoozedUntil') : undefined}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-amber-900/20 text-amber-400 rounded-lg active:bg-amber-900/30 min-h-[44px] whitespace-nowrap"
              aria-label="Snooze for 3 hours"
            >
              <Clock size={14} />
              3hr
            </button>
            <button
              onClick={() => { onSnooze(item.taskId, 'tonight'); setShowScheduleTray(false); triggerHapticFeedback('defer'); }}
              disabled={!canEditSnooze}
              title={!canEditSnooze ? taskFieldBlockedReason(item.editPolicy, 'snoozedUntil') : undefined}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-indigo-900/20 text-indigo-400 rounded-lg active:bg-indigo-900/30 min-h-[44px] whitespace-nowrap"
              aria-label="Snooze until tonight"
            >
              <Moon size={14} />
              Tonight
            </button>
            {onSetLocalDisposition && dispositionOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  onSetLocalDisposition(item.taskId, option.value);
                  setShowScheduleTray(false);
                  triggerHaptic('light');
                }}
                title={`${option.detail} Mission Control only.`}
                aria-label={`${option.label}. ${option.detail} Mission Control only.`}
                className="flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-900/20 px-3 py-2 text-xs font-medium text-emerald-400 active:bg-emerald-900/30"
              >
                {option.value === 'handled' ? <CircleCheck size={14} /> : <Archive size={14} />}
                {option.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowScheduleTray(false)}
            className="p-2 pr-4 text-[var(--text-muted)] min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden border-b border-[var(--border-subtle)]">
      {/* Left swipe background (Not Today) */}
      <motion.div
        className="absolute inset-0 flex items-center justify-end px-6 bg-amber-600/20"
        style={{ opacity: leftBgOpacity }}
      >
        <div className="flex items-center gap-2 text-amber-400">
          <Sun size={16} />
          <span className="text-xs font-medium">Not Today</span>
        </div>
      </motion.div>

      {/* Right swipe background (Schedule) */}
      <motion.div
        className="absolute inset-0 flex items-center justify-start px-6 bg-blue-600/20"
        style={{ opacity: rightBgOpacity }}
      >
        <div className="flex items-center gap-2 text-blue-400">
          <Calendar size={16} />
          <span className="text-xs font-medium">Schedule</span>
        </div>
      </motion.div>

      {/* Swipeable task row */}
      <motion.div
        className={cn(
          'relative bg-[var(--surface-1)] px-4 py-3 flex items-center gap-3 min-h-[52px] active:bg-[var(--surface-0)] transition-[background-color,opacity] duration-150',
          (isCompleting || isInactiveTaskStatus(item.status)) && 'opacity-50'
        )}
        style={{ x }}
        drag="x"
        dragConstraints={{ left: -FULL_SWIPE_THRESHOLD - 20, right: FULL_SWIPE_THRESHOLD + 20 }}
        dragTransition={prefersReducedMotion ? { bounceStiffness: 0, bounceDamping: Infinity } : undefined}
        dragElastic={0.2}
        dragMomentum={false}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        onClick={() => onTap(item)}
      >
        {/* Priority dot / checkbox (F-27) */}
        <CompletionBurst celebrating={isCompleting}>
          <button
            onClick={handleCompleteTap}
            disabled={isCompleting || !canEditStatus}
            title={!canEditStatus ? taskFieldBlockedReason(item.editPolicy, 'status') : undefined}
            className={cn(
              'w-11 h-11 rounded-full flex-shrink-0 flex items-center justify-center -ml-1',
              isCompleting && 'border-2 border-green-400 bg-green-400 text-white'
            )}
            aria-label={`Complete ${item.title}`}
          >
            {isCompleting ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <span
                className={cn('w-3 h-3 rounded-full', PRIORITY_DOT_COLORS[item.priority] || PRIORITY_DOT_COLORS.none)}
                aria-hidden="true"
              />
            )}
          </button>
        </CompletionBurst>

        {/* Title + project tag + due indicator */}
        <div className="flex-1 min-w-0">
          <p className={cn(
            'text-sm font-medium truncate',
            isCompleting ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'
          )}>
            {item.title}
          </p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {/* Project tag (hub project name) */}
            {item.hubProjectIds && item.hubProjectIds.length > 0 && projects.length > 0 && (() => {
              const matched = projects.filter((p) => item.hubProjectIds!.includes(p.id));
              return matched.length > 0 ? (
                <span className="text-xs text-indigo-400 truncate max-w-[100px] flex-shrink-0">
                  {matched.map((p) => p.name).join(', ')}
                </span>
              ) : null;
            })()}
            {/* Source icon + list name (always shown when available) */}
            {item.sourceListName && (
              <span className="text-xs text-[var(--text-muted)] truncate max-w-[120px] flex items-center gap-1 flex-shrink min-w-0">
                {CONNECTOR_ICONS[item.connectorType] && (
                  <Image
                    src={CONNECTOR_ICONS[item.connectorType]}
                    alt={item.connectorType}
                    width={11}
                    height={11}
                    className="flex-shrink-0"
                  />
                )}
                {item.sourceListName}
              </span>
            )}
            {/* Source icon only (when no list name but connector icon exists) */}
            {!item.sourceListName && CONNECTOR_ICONS[item.connectorType] && (
              <Image
                src={CONNECTOR_ICONS[item.connectorType]}
                alt={item.connectorType}
                width={11}
                height={11}
                className="flex-shrink-0 opacity-60"
              />
            )}
            {/* Due indicator */}
            {dueDateStr && (
              <span className={cn(
                'text-xs flex items-center gap-0.5',
                isOverdue ? 'text-red-400 font-medium' : isDueToday ? 'text-amber-400' : 'text-[var(--text-muted)]'
              )}>
                <Calendar size={10} />
                {formatDueDate(dueDateStr)}
              </span>
            )}
            {/* AI suggestion chip (F-19) — right-aligned as a distinct concept */}
            {showAiChip && aiSuggestion && (
              <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium text-purple-300 bg-purple-900/20 border border-purple-800/30 rounded-full">
                <span className="text-purple-400">✦</span>
                {aiSuggestion}
              </span>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
