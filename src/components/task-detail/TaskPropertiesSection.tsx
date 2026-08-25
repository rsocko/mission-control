'use client';

import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowLeftRight,
  Ban,
  Calendar,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Copy,
  Flag,
  Gauge,
  Loader2,
  Repeat,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { DatePicker } from '@/components/ui/date-picker';
import { EffortSelect } from '@/components/EffortBadge';
import { MicroStatusIcon } from '@/components/task-list/MicroStatusIcon';
import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus, PlanningHorizon, TaskStatus } from '@/types';
import { cn } from '@/lib/utils';
import { PRIORITY_TEXT_COLORS, TASK_PRIORITY_VISUALS, TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';
import { PLANNING_HORIZONS, PLANNING_HORIZON_LABELS } from '@/lib/tasks/planning-horizon';
import type { MicroStatusSuggestion, TaskDetailMode } from './task-detail-types';

const DURATION_OPTIONS = [
  { value: 'none', label: 'No duration' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '240', label: '4 hours' },
  { value: '480', label: '1 day' },
  { value: '2400', label: '1 week' },
] as const;

export interface TaskStatusFieldProps {
  status: string;
  statusReason: string | null;
  microStatus: string | null;
  /** GitHub issues expose extra "close as…" options. */
  connectorType: string;
  supportedStatusValues?: TaskStatus[];
  canEditStatus: boolean;
  canEditMicroStatus: boolean;
  statusBlockedReason?: string;
  statusSaveLabel?: string;
  microStatusBlockedReason?: string;
  microStatusSaveLabel?: string;
  onStatusChange: (status: string) => void;
  onComplete: () => void;
  showMicroStatusPicker: boolean;
  onToggleMicroStatusPicker: () => void;
  onMicroStatusChange: (microStatus: string | null) => void;
  microStatusSuggestion: MicroStatusSuggestion | null;
  onRequestMicroStatusSuggestion: () => void;
  onDismissMicroStatusSuggestion: () => void;
  showCloseReasonPicker: boolean;
  onCloseWithReason: (reason: 'not_planned' | 'duplicate') => void;
  onCancelCloseReason: () => void;
}

const DEFAULT_STATUS_OPTIONS = [
  { value: 'todo', label: 'To Do', className: TASK_STATUS_VISUALS.todo.textClass },
  { value: 'in_progress', label: 'In Progress', className: TASK_STATUS_VISUALS.in_progress.textClass },
  { value: 'blocked', label: 'Blocked', className: TASK_STATUS_VISUALS.blocked.textClass },
  { value: 'done', label: 'Done', className: TASK_STATUS_VISUALS.done.textClass },
  { value: 'cancelled', label: 'Cancelled', className: TASK_STATUS_VISUALS.cancelled.textClass },
] as const;

export function getTaskStatusOptions(
  connectorType: string,
  supportedStatusValues?: readonly TaskStatus[],
) {
  const supported = supportedStatusValues ? new Set<string>(supportedStatusValues) : null;
  return DEFAULT_STATUS_OPTIONS
    .filter((option) => !supported || supported.has(option.value))
    .map((option) => ({
      ...option,
      label: connectorType === 'document-intelligence' && option.value === 'cancelled'
        ? "Won't do"
        : option.label,
    }));
}

/** Status select, status reason badge, micro-status, and GitHub close reasons. */
export function TaskStatusField({
  status,
  statusReason,
  microStatus,
  connectorType,
  supportedStatusValues,
  canEditStatus,
  canEditMicroStatus,
  statusBlockedReason,
  statusSaveLabel,
  microStatusBlockedReason,
  microStatusSaveLabel,
  onStatusChange,
  onComplete,
  showMicroStatusPicker,
  onToggleMicroStatusPicker,
  onMicroStatusChange,
  microStatusSuggestion,
  onRequestMicroStatusSuggestion,
  onDismissMicroStatusSuggestion,
  showCloseReasonPicker,
  onCloseWithReason,
  onCancelCloseReason,
}: TaskStatusFieldProps) {
  const microStatusConfig = microStatus ? MICRO_STATUS_CONFIG[microStatus as MicroStatus] : undefined;
  const isClosed = status === 'done' || status === 'cancelled';
  const statusOptions = getTaskStatusOptions(connectorType, supportedStatusValues);

  return (
    <div className="relative flex min-h-28 flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {status === 'done' ? (
          <CheckCircle2 size={13} className="flex-shrink-0 text-[var(--success)]" />
        ) : (
          <Circle size={13} className={`flex-shrink-0 ${
            TASK_STATUS_VISUALS[status as keyof typeof TASK_STATUS_VISUALS]?.textClass ?? TASK_STATUS_VISUALS.todo.textClass
          }`} />
        )}
        Status
      </span>
      <div className="flex items-center gap-2">
        <Select
          value={status}
          onValueChange={(next) => {
            if (next === 'done') onComplete();
            else onStatusChange(next);
          }}
          disabled={!canEditStatus}
        >
          <SelectTrigger
            aria-label="Task status"
            title={!canEditStatus ? statusBlockedReason : statusSaveLabel}
            className={
            status === 'done' ? 'text-[var(--success)]' :
            TASK_STATUS_VISUALS[status as keyof typeof TASK_STATUS_VISUALS]?.textClass ?? TASK_STATUS_VISUALS.todo.textClass
          }>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} className={option.className}>
                {option.label}
              </SelectItem>
            ))}
            {connectorType === 'github-issues' && (
              <>
                <SelectItem value="cancelled:not_planned" className="text-rose-400">Close as Not Planned</SelectItem>
                <SelectItem value="cancelled:duplicate" className="text-rose-400">Close as Duplicate</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>

        {/* Status reason badge — shown when task is closed with a specific reason */}
        {isClosed && statusReason && statusReason !== 'completed' && (
          <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${
            statusReason === 'not_planned'
              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
              : statusReason === 'moved'
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
              : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
          }`}>
            {statusReason === 'not_planned' ? <><Ban size={12} className="inline" /> Not Planned</> : statusReason === 'moved' ? <><ArrowLeftRight size={12} className="inline" /> Moved</> : <><Copy size={12} className="inline" /> Duplicate</>}
          </span>
        )}

      </div>

      {/* Status Reason (Micro-Status) */}
      {!isClosed && (
        <div className="mt-auto flex items-center gap-1.5">
          <AlertCircle size={11} className={`flex-shrink-0 ${microStatus ? '' : 'text-[var(--text-muted)]'}`}
            style={microStatusConfig ? { color: microStatusConfig.color } : undefined}
          />
          <button
            onClick={onToggleMicroStatusPicker}
            disabled={!canEditMicroStatus}
            title={!canEditMicroStatus ? microStatusBlockedReason : microStatusSaveLabel}
            className={`flex min-h-8 flex-1 items-center justify-between rounded-lg border border-[var(--border-subtle)] px-2 text-left text-xs transition-colors ${
              microStatus
                ? 'font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
            }`}
            style={microStatusConfig ? {
              backgroundColor: `${microStatusConfig.color}20`,
              color: microStatusConfig.color,
              border: `1px solid ${microStatusConfig.color}30`,
            } : undefined}
          >
            {microStatusConfig && microStatus ? (
              <span className="flex items-center gap-1.5">
                <MicroStatusIcon status={microStatus as MicroStatus} size={13} />
                {microStatusConfig.label}
              </span>
            ) : 'Add reason'}
            <ChevronDown size={11} />
          </button>

          {/* AI suggestion badge */}
          {!microStatus && !microStatusSuggestion && (
            <Tooltip content="Get AI suggestion">
              <button
                onClick={onRequestMicroStatusSuggestion}
                disabled={!canEditMicroStatus}
                title={!canEditMicroStatus ? microStatusBlockedReason : undefined}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-0.5"
              >
                <Sparkles size={10} />
              </button>
            </Tooltip>
          )}
        </div>
      )}

      {/* AI suggestion & dropdown — below the status row */}
      {canEditMicroStatus && !isClosed && (
        <>
          {microStatusSuggestion && MICRO_STATUS_CONFIG[microStatusSuggestion.status as MicroStatus] && (
            <div className="ml-[25px] flex items-start gap-1.5 p-1.5 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/20">
              <Sparkles size={10} className="text-[var(--accent)] mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <button
                  onClick={() => onMicroStatusChange(microStatusSuggestion.status)}
                  className="text-xs text-[var(--accent)] hover:underline font-medium"
                >
                  <MicroStatusIcon status={microStatusSuggestion.status as MicroStatus} size={12} className="mr-1 inline" />
                  {MICRO_STATUS_CONFIG[microStatusSuggestion.status as MicroStatus].label}
                </button>
                <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-tight">{microStatusSuggestion.reason}</p>
              </div>
              <button
                onClick={onDismissMicroStatusSuggestion}
                className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex-shrink-0"
              >
                <X size={10} />
              </button>
            </div>
          )}

          {/* Micro-status picker dropdown */}
          <AnimatePresence>
            {showMicroStatusPicker && (
              <motion.div
                className="absolute left-0 top-full mt-1 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl z-20"
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.12 }}
              >
                <div className="px-3 pt-2.5 pb-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  Why isn&apos;t this moving?
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {/* Clear option */}
                  {microStatus && (
                    <button
                      onClick={() => onMicroStatusChange(null)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors text-xs text-[var(--text-muted)]"
                    >
                      <span className="w-4 text-center"><X size={12} /></span>
                      <span>Clear status reason</span>
                    </button>
                  )}
                  {(Object.entries(MICRO_STATUS_CONFIG) as [MicroStatus, typeof MICRO_STATUS_CONFIG[MicroStatus]][]).map(([key, config]) => (
                    <button
                      key={key}
                      onClick={() => onMicroStatusChange(key)}
                      className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors ${
                        microStatus === key ? 'bg-[var(--surface-0)]' : ''
                      }`}
                    >
                      <MicroStatusIcon status={key} size={14} className="mt-px" style={{ color: config.color }} />
                      <div className="min-w-0 flex-1">
                        <span className="block text-xs font-medium" style={{ color: config.color }}>{config.label}</span>
                        <span className="block text-xs text-[var(--text-muted)] leading-tight">{config.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      {/* Close reason picker — shown when user is cancelling a GitHub task */}
      <AnimatePresence>
        {showCloseReasonPicker && canEditStatus && (
          <motion.div
            className="ml-[25px] rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden"
            initial={{ opacity: 0, y: -4, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: -4, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="px-3 pt-2.5 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              Close reason
            </div>
            <button
              onClick={() => onCloseWithReason('not_planned')}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-1)] transition-colors"
            >
              <span className="text-sm flex-shrink-0"><Ban size={14} /></span>
              <div className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-amber-500">Not Planned</span>
                <span className="block text-xs text-[var(--text-muted)] leading-tight">Won&apos;t be worked on — close without completing</span>
              </div>
            </button>
            <button
              onClick={() => onCloseWithReason('duplicate')}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-1)] transition-colors"
            >
              <span className="text-sm flex-shrink-0"><Copy size={14} /></span>
              <div className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-purple-400">Duplicate</span>
                <span className="block text-xs text-[var(--text-muted)] leading-tight">This is a duplicate of another issue</span>
              </div>
            </button>
            <button
              onClick={onCancelCloseReason}
              className="w-full px-3 py-2 text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-1)] transition-colors border-t border-[var(--border-subtle)]"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface TaskPriorityFieldProps {
  priority: string;
  planningHorizon: PlanningHorizon | null;
  canEditPriority: boolean;
  canEditPlanningHorizon: boolean;
  priorityBlockedReason?: string;
  planningHorizonBlockedReason?: string;
  prioritySaveLabel?: string;
  planningHorizonSaveLabel?: string;
  onPriorityChange: (priority: string) => void;
  onPlanningHorizonChange: (planningHorizon: PlanningHorizon | null) => void;
}

/** Priority and broad planning intent. */
export function TaskPriorityField({
  priority,
  planningHorizon,
  canEditPriority,
  canEditPlanningHorizon,
  priorityBlockedReason,
  planningHorizonBlockedReason,
  prioritySaveLabel,
  planningHorizonSaveLabel,
  onPriorityChange,
  onPlanningHorizonChange,
}: TaskPriorityFieldProps) {
  return (
    <div className="flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Flag size={13} />Priority</span>
      <Select value={priority || 'none'} onValueChange={onPriorityChange} disabled={!canEditPriority}>
        <SelectTrigger
          aria-label="Task priority"
          title={!canEditPriority ? priorityBlockedReason : prioritySaveLabel}
          variant="inline"
          className={PRIORITY_TEXT_COLORS[priority] || PRIORITY_TEXT_COLORS.none}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(TASK_PRIORITY_VISUALS).map(([value, visual]) => (
            <SelectItem key={value} value={value} className={visual.textClass}>{visual.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={planningHorizon ?? 'none'}
        onValueChange={(value) => onPlanningHorizonChange(
          value === 'none' ? null : value as PlanningHorizon,
        )}
        disabled={!canEditPlanningHorizon}
      >
        <SelectTrigger
          aria-label="Planning horizon"
          title={!canEditPlanningHorizon
            ? planningHorizonBlockedReason
            : planningHorizonSaveLabel}
          variant="inline"
          className="mt-auto min-h-8 w-full justify-between rounded-lg border border-[var(--border-subtle)] px-2 text-xs"
        >
          <SelectValue placeholder="Planning horizon" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not set</SelectItem>
          {PLANNING_HORIZONS.map((value) => (
            <SelectItem key={value} value={value}>
              {PLANNING_HORIZON_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface TaskDueDateFieldProps {
  /** Date-only portion of the due date, or null when unset. */
  dueDate: string | null;
  isOverdue: boolean;
  /** Whether a recurrence rule is active, which reveals the jump affordance. */
  hasRecurrence: boolean;
  canEditDueDate: boolean;
  dueDateBlockedReason?: string;
  dueDateSaveLabel?: string;
  onDueDateChange: (date: string) => void;
  onJumpToRecurrence: () => void;
  isInMyDay: boolean;
  updatingMyDay: boolean;
  onToggleMyDay: () => void;
}

/** Due date picker, overdue badge, recurrence jump, and My Day toggle. */
export function TaskDueDateField({
  dueDate,
  isOverdue,
  hasRecurrence,
  canEditDueDate,
  dueDateBlockedReason,
  dueDateSaveLabel,
  onDueDateChange,
  onJumpToRecurrence,
  isInMyDay,
  updatingMyDay,
  onToggleMyDay,
}: TaskDueDateFieldProps) {
  return (
    <div className="relative flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Calendar size={13} />Due date</span>
      {hasRecurrence && (
        <Tooltip content="View recurrence settings">
          <button
            type="button"
            onClick={onJumpToRecurrence}
            aria-label="View recurrence settings"
            className="absolute right-2 top-2 flex min-h-7 min-w-7 items-center justify-center rounded-md bg-blue-500/10 text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60"
          >
            <Repeat size={13} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <div className="flex w-full items-center gap-1.5">
        <DatePicker
          value={dueDate}
          onChange={canEditDueDate ? onDueDateChange : () => {}}
          variant="inline"
          placeholder="Set due date"
          aria-label="Due date"
          disabled={!canEditDueDate}
          title={!canEditDueDate ? dueDateBlockedReason : dueDateSaveLabel}
          className={isOverdue ? 'text-rose-400' : undefined}
        />
        {isOverdue && (
          <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-400">
            Overdue
          </span>
        )}
      </div>
      <button
        onClick={onToggleMyDay}
        disabled={updatingMyDay}
        className={cn(
          'mt-auto flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2 text-left text-xs transition-colors',
          isInMyDay ? 'bg-amber-500/10 text-amber-400' : 'text-[var(--text-muted)] hover:text-amber-400',
        )}
      >
        {updatingMyDay
          ? <Loader2 size={13} className="animate-spin" />
          : <Sun size={13} fill={isInMyDay ? 'currentColor' : 'none'} />}
        {isInMyDay ? 'On My Day' : 'Add to My Day'}
      </button>
    </div>
  );
}

export interface TaskEffortFieldProps {
  effort?: number | null;
  estimatedDuration?: number | null;
  canEditEffortAndDuration: boolean;
  /** Explains why effort or duration is locked, when either is. */
  effortDurationBlockedReason?: string;
  durationSaveLabel?: string;
  effortHighlight: boolean;
  durationHighlight: boolean;
  onEffortChange: (effort: number | null) => void;
  onDurationChange: (minutes: number | null) => void;
}

/** Effort select with its linked duration estimate. */
export function TaskEffortField({
  effort,
  estimatedDuration,
  canEditEffortAndDuration,
  effortDurationBlockedReason,
  durationSaveLabel,
  effortHighlight,
  durationHighlight,
  onEffortChange,
  onDurationChange,
}: TaskEffortFieldProps) {
  return (
    <div className="flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Gauge size={13} />Effort</span>
      <div className="w-full" title={effortDurationBlockedReason}>
        <EffortSelect effort={effort} onChange={onEffortChange} disabled={!canEditEffortAndDuration} highlight={effortHighlight} />
      </div>
      <Select
        value={estimatedDuration == null ? 'none' : String(estimatedDuration)}
        onValueChange={(value) => onDurationChange(value === 'none' ? null : Number(value))}
        disabled={!canEditEffortAndDuration}
      >
        <SelectTrigger
          aria-label="Task duration"
          title={effortDurationBlockedReason ?? durationSaveLabel}
          variant="inline"
          className={cn(
            'mt-auto min-h-8 w-full justify-between rounded-lg border border-[var(--border-subtle)] px-2 text-xs',
            durationHighlight && 'ring-2 ring-[var(--accent)]/40',
          )}
        >
          <span className="flex items-center gap-1.5">
            <Clock size={12} />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          {DURATION_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.value === 'none' ? option.label : `Duration: ${option.label}`}
            </SelectItem>
          ))}
          {estimatedDuration != null && !DURATION_OPTIONS.some((option) => option.value === String(estimatedDuration)) && (
            <SelectItem value={String(estimatedDuration)}>Duration: {estimatedDuration} minutes</SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface TaskPropertiesSectionProps {
  mode: TaskDetailMode;
  status: TaskStatusFieldProps;
  priority: TaskPriorityFieldProps;
  dueDate: TaskDueDateFieldProps;
  effort: TaskEffortFieldProps;
}

/** The primary 2x2 grid of task properties. */
export function TaskPropertiesSection({
  mode,
  status,
  priority,
  dueDate,
  effort,
}: TaskPropertiesSectionProps) {
  return (
    <div className="contents">
      <div className={cn(
        'grid grid-cols-2 items-stretch gap-3',
        (mode === 'panel' || mode === 'mobile') && 'order-0',
        mode === 'dialog' && 'col-start-1 row-start-3',
        mode === 'workspace' && 'col-start-1 row-start-3',
      )}>
        <TaskStatusField {...status} />
        <TaskPriorityField {...priority} />
        <TaskDueDateField {...dueDate} />
        <TaskEffortField {...effort} />
      </div>
    </div>
  );
}
