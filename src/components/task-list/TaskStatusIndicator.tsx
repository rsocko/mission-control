import { Check, Pause, X } from 'lucide-react';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';
import { cn } from '@/lib/utils';

const BLOCKING_MICRO_STATUSES = new Set([
  'waiting_on_someone',
  'started_but_stuck',
  'blocked_external',
  'on_hold',
]);

type IndicatorSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<IndicatorSize, { circle: string; icon: number; marker: string; markerIcon: number }> = {
  sm: { circle: 'h-3.5 w-3.5', icon: 8, marker: '-bottom-1 -right-1 h-2.5 w-2.5', markerIcon: 6 },
  md: { circle: 'h-5 w-5', icon: 12, marker: '-bottom-1 -right-1 h-3 w-3', markerIcon: 7 },
  lg: { circle: 'h-6 w-6', icon: 14, marker: '-bottom-1 -right-1 h-3.5 w-3.5', markerIcon: 8 },
};

function normalizeStatus(status: string): string {
  if (status === 'completed') return 'done';
  if (status === 'in-progress') return 'in_progress';
  return status;
}

export function isTaskBlocked(status: string, microStatus?: string | null): boolean {
  return normalizeStatus(status) === 'blocked'
    || (microStatus ? BLOCKING_MICRO_STATUSES.has(microStatus) : false);
}

export function getTaskBlockerLabel(status: string, microStatus?: string | null): string | null {
  if (!isTaskBlocked(status, microStatus)) return null;
  if (microStatus && microStatus in MICRO_STATUS_CONFIG) {
    return MICRO_STATUS_CONFIG[microStatus as MicroStatus].label;
  }
  return microStatus === 'on_hold' ? 'On hold' : 'Blocked';
}

interface TaskStatusIndicatorProps {
  status: string;
  microStatus?: string | null;
  isCompleting?: boolean;
  size?: IndicatorSize;
  idleContent?: React.ReactNode;
  className?: string;
  testId?: string;
}

export function TaskStatusIndicator({
  status,
  microStatus,
  isCompleting = false,
  size = 'md',
  idleContent,
  className,
  testId,
}: TaskStatusIndicatorProps) {
  const normalizedStatus = normalizeStatus(status);
  const isDone = normalizedStatus === 'done' || isCompleting;
  const isCancelled = normalizedStatus === 'cancelled';
  const isBlocked = !isDone && isTaskBlocked(normalizedStatus, microStatus);
  const isInProgress = normalizedStatus === 'in_progress' || normalizedStatus === 'blocked';
  const sizing = SIZE_CLASSES[size];

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      data-task-status={isCompleting ? 'done' : normalizedStatus}
      data-task-blocked={isBlocked ? 'true' : undefined}
      aria-hidden="true"
    >
      <span
        data-testid={testId}
        className={cn(
          sizing.circle,
          'inline-flex items-center justify-center rounded-full border-2 transition-[border-color,background-color,color,transform] duration-200',
          isDone && 'border-green-400 bg-green-400 text-white',
          !isDone && isCancelled && 'border-slate-600 text-slate-500',
          !isDone && !isCancelled && isInProgress && 'border-blue-500 text-blue-400',
          !isDone && !isCancelled && !isInProgress && 'border-[var(--border-strong)] text-[var(--text-muted)]',
          !isDone && 'group-hover/status:border-green-500 group-active/status:bg-green-900/30',
        )}
      >
        {isDone ? <Check size={sizing.icon} strokeWidth={3} /> : isCancelled ? <X size={sizing.icon} /> : idleContent}
      </span>
      {isBlocked && (
        <span
          className={cn(
            sizing.marker,
            'absolute inline-flex items-center justify-center rounded-full border border-[var(--surface-1)] bg-amber-400 text-amber-950 shadow-sm',
          )}
          data-testid="task-blocked-marker"
        >
          <Pause size={sizing.markerIcon} strokeWidth={3} fill="currentColor" />
        </span>
      )}
    </span>
  );
}

export function TaskBlockedBadge({
  status,
  microStatus,
  className,
}: {
  status: string;
  microStatus?: string | null;
  className?: string;
}) {
  const label = getTaskBlockerLabel(status, microStatus);
  if (!label) return null;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-700/40 bg-amber-900/25 px-1.5 py-0.5 text-xs font-medium text-amber-300',
        className,
      )}
      title={label}
    >
      <Pause size={9} strokeWidth={3} fill="currentColor" aria-hidden="true" />
      {label}
    </span>
  );
}
