'use client';

import * as Popover from '@radix-ui/react-popover';
import {
  CalendarDays,
  AlertCircle,
  Archive,
  CircleDot,
  CircleCheck,
  Clock3,
  FileText,
  Flag,
  Loader2,
  Sun,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DayPicker } from 'react-day-picker';
import { calendarClassNames } from '@/components/ui/calendar-classes';
import { Tooltip } from '@/components/ui/Tooltip';
import { getLocalToday, getLocalTomorrow } from '@/lib/utils/client-date';
import { formatDueDate } from '@/lib/utils/date-format';
import { cn } from '@/lib/utils/cn';
import type { LocalDisposition } from '@/types';
import {
  canEditTaskField,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskFieldBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import type { TaskEditPolicy } from '@/types';
import { TASK_PRIORITY_VISUALS, TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';

const MENU_CONTENT_CLASS =
  'z-[100] min-w-48 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1.5 shadow-2xl';
const MENU_ITEM_CLASS =
  'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-sm text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-2)] focus-visible:text-[var(--text-primary)]';
const ACTION_BUTTON_CLASS =
  'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 disabled:cursor-not-allowed disabled:opacity-40';
const CORE_HOVER_ACTION_SLOT_CLASS =
  'hidden items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @min-[480px]:flex';
const SECONDARY_HOVER_ACTION_SLOT_CLASS =
  'hidden items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @min-[640px]:flex';
const TERTIARY_HOVER_ACTION_SLOT_CLASS =
  'hidden items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @min-[768px]:flex';
const WIDE_HOVER_ACTION_SLOT_CLASS =
  'hidden items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 @min-[960px]:flex';
const MY_DAY_ACTION_CLASS = 'text-amber-400 hover:bg-amber-400/15 hover:text-amber-300';
const DATE_ACTION_CLASS = 'text-sky-400 hover:bg-sky-400/15 hover:text-sky-300';
const OVERDUE_DATE_ACTION_CLASS = 'font-medium text-red-400 hover:bg-red-400/15 hover:text-red-300';
const NOTES_ACTION_CLASS = 'text-violet-400 hover:bg-violet-400/15 hover:text-violet-300';
const SNOOZE_ACTION_CLASS = 'text-blue-400 hover:bg-blue-400/15 hover:text-blue-300';

const PRIORITY_OPTIONS = [
  ...Object.entries(TASK_PRIORITY_VISUALS).map(([value, visual]) => ({
    value,
    label: visual.label,
    shortLabel: visual.shortLabel,
    color: visual.dotClass,
    actionClass: visual.actionClass,
  })),
] as const;

const STATUS_OPTIONS = [
  ...(['todo', 'in_progress', 'done', 'cancelled'] as const).map((value) => ({
    value,
    label: TASK_STATUS_VISUALS[value].label,
    color: TASK_STATUS_VISUALS[value].dotClass,
    actionClass: TASK_STATUS_VISUALS[value].actionClass,
  })),
] as const;

type AsyncAction = () => void | Promise<void>;

interface ActionPopoverProps {
  label: string;
  icon: ReactNode;
  children: (close: () => void, run: (action: AsyncAction) => Promise<void>) => ReactNode;
  buttonClassName?: string;
  disabled?: boolean;
}

function ActionPopover({
  label,
  icon,
  children,
  buttonClassName,
  disabled = false,
}: ActionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function run(action: AsyncAction) {
    setPending(true);
    try {
      await action();
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <Tooltip content={label}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            disabled={disabled || pending}
            onClick={(event) => event.stopPropagation()}
            className={cn(ACTION_BUTTON_CLASS, buttonClassName)}
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : icon}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          align="center"
          side="bottom"
          sideOffset={6}
          collisionPadding={12}
          onClick={(event) => event.stopPropagation()}
          className={MENU_CONTENT_CLASS}
        >
          {children(() => setOpen(false), run)}
          <Popover.Arrow className="fill-[var(--border)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getNextMonday(): Date {
  const date = new Date();
  const daysUntilMonday = ((8 - date.getDay()) % 7) || 7;
  date.setDate(date.getDate() + daysUntilMonday);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getSnoozeTime(kind: 'later' | 'tomorrow' | 'monday'): string {
  const date = kind === 'monday' ? getNextMonday() : new Date();
  if (kind === 'later') {
    date.setHours(Math.min(date.getHours() + 3, 23), date.getHours() >= 20 ? 59 : date.getMinutes(), 0, 0);
  } else if (kind === 'tomorrow') {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
  } else {
    date.setHours(9, 0, 0, 0);
  }
  return date.toISOString();
}

function DateMenu({
  dueDate,
  disabled,
  disabledReason,
  onChange,
}: {
  dueDate: string | null;
  disabled: boolean;
  disabledReason?: string;
  onChange: (date: string | null) => void | Promise<void>;
}) {
  const [showCalendar, setShowCalendar] = useState(false);
  const parsedDate = dueDate ? new Date(`${dueDate.slice(0, 10)}T00:00:00`) : undefined;
  const isOverdue = Boolean(dueDate && dueDate.slice(0, 10) < getLocalToday());
  const dueDateContent = dueDate ? (
    <>
      {isOverdue && <AlertCircle size={10} />}
      <span className="whitespace-nowrap text-xs">{formatDueDate(dueDate)}</span>
    </>
  ) : <CalendarDays size={14} />;

  if (disabled && dueDate) {
    return (
      <span className={cn('flex shrink-0 items-center gap-0.5 text-xs text-[var(--text-muted)]', isOverdue && 'font-medium text-red-400')}>
        {dueDateContent}
      </span>
    );
  }

  return (
    <ActionPopover
      label={disabled && disabledReason
        ? disabledReason
        : dueDate ? `Change due date, currently ${formatDueDate(dueDate)}` : 'Add due date'}
      icon={dueDateContent}
      disabled={disabled}
      buttonClassName={cn(
        dueDate && 'h-7 w-auto gap-0.5 px-1.5',
        isOverdue ? OVERDUE_DATE_ACTION_CLASS : DATE_ACTION_CLASS,
      )}
    >
      {(close, run) => showCalendar ? (
        <DayPicker
          mode="single"
          selected={parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : undefined}
          onSelect={(date) => {
            if (!date) return;
            void run(() => onChange(formatLocalDate(date)));
            setShowCalendar(false);
          }}
          defaultMonth={parsedDate}
          showOutsideDays
          classNames={calendarClassNames}
        />
      ) : (
        <>
          <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Set due date</p>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(getLocalToday()))}>
            <CalendarDays size={14} className="text-blue-400" /> Today
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(getLocalTomorrow()))}>
            <CalendarDays size={14} className="text-orange-400" /> Tomorrow
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(formatLocalDate(getNextMonday())))}>
            <CalendarDays size={14} className="text-purple-400" /> Next Monday
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => setShowCalendar(true)}>
            <CalendarDays size={14} className="text-[var(--text-muted)]" /> Pick date
          </button>
          {dueDate && (
            <>
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(null))}>
                Clear due date
              </button>
            </>
          )}
          <button type="button" className="sr-only" onClick={close}>Close</button>
        </>
      )}
    </ActionPopover>
  );
}

function SnoozeMenu({
  snoozedUntil,
  disabled = false,
  disabledReason,
  onChange,
}: {
  snoozedUntil?: string | null;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (until: string | null) => void | Promise<void>;
}) {
  const [showCalendar, setShowCalendar] = useState(false);

  return (
    <ActionPopover
      label={disabled && disabledReason ? disabledReason : 'Snooze task'}
      icon={<Clock3 size={14} />}
      buttonClassName={SNOOZE_ACTION_CLASS}
      disabled={disabled}
    >
      {(_close, run) => showCalendar ? (
        <DayPicker
          mode="single"
          onSelect={(date) => {
            if (!date) return;
            date.setHours(9, 0, 0, 0);
            void run(() => onChange(date.toISOString()));
            setShowCalendar(false);
          }}
          showOutsideDays
          classNames={calendarClassNames}
        />
      ) : (
        <>
          <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Snooze until</p>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(getSnoozeTime('later')))}>
            <Clock3 size={14} className="text-blue-400" /> Later today
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(getSnoozeTime('tomorrow')))}>
            <Clock3 size={14} className="text-orange-400" /> Tomorrow
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(getSnoozeTime('monday')))}>
            <Clock3 size={14} className="text-purple-400" /> Next Monday
          </button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={() => setShowCalendar(true)}>
            <CalendarDays size={14} /> Pick date
          </button>
          {snoozedUntil && (
            <>
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <button type="button" className={MENU_ITEM_CLASS} onClick={() => void run(() => onChange(null))}>
                Unsnooze
              </button>
            </>
          )}
        </>
      )}
    </ActionPopover>
  );
}

function StatusMenu({
  status,
  onChange,
  persistent = false,
  disabled = false,
  disabledReason,
}: {
  status: string;
  onChange: (status: string) => void | Promise<void>;
  persistent?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const selected = STATUS_OPTIONS.find((option) => option.value === status);
  return (
    <ActionPopover
      label={disabled && disabledReason
        ? disabledReason
        : persistent && selected ? `Status: ${selected.label}` : 'Set status'}
      icon={persistent && selected ? (
        <>
          <span className={cn('h-2 w-2 rounded-full', selected.color)} />
          <span>{selected.label}</span>
        </>
      ) : <CircleDot size={14} />}
      buttonClassName={cn(
        selected?.actionClass,
        persistent && 'h-6 w-auto gap-1.5 border border-current/25 px-1.5 text-xs',
      )}
      disabled={disabled}
    >
      {(_close, run) => (
        <>
          <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Set status</p>
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(MENU_ITEM_CLASS, status === option.value && 'bg-[var(--surface-2)] text-[var(--text-primary)]')}
              onClick={() => void run(() => onChange(option.value))}
            >
              <span className={cn('h-2 w-2 rounded-full', option.color)} />
              {option.label}
            </button>
          ))}
        </>
      )}
    </ActionPopover>
  );
}

function PriorityMenu({
  priority,
  onChange,
  persistent = false,
  disabled = false,
  disabledReason,
}: {
  priority: string;
  onChange: (priority: string) => void | Promise<void>;
  persistent?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const selected = PRIORITY_OPTIONS.find((option) => option.value === priority);
  return (
    <ActionPopover
      label={disabled && disabledReason
        ? disabledReason
        : persistent && selected ? `Priority: ${selected.label}` : 'Set priority'}
      icon={persistent && selected ? (
        <>
          <span className={cn('h-2 w-2 rounded-full', selected.color)} />
          <span>{selected.shortLabel}</span>
        </>
      ) : <Flag size={14} />}
      buttonClassName={cn(
        selected?.actionClass,
        persistent && 'h-6 w-auto gap-1.5 border border-current/25 px-1.5 text-xs',
      )}
      disabled={disabled}
    >
      {(_close, run) => (
        <>
          <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Set priority</p>
          {PRIORITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(MENU_ITEM_CLASS, priority === option.value && 'bg-[var(--surface-2)] text-[var(--text-primary)]')}
              onClick={() => void run(() => onChange(option.value))}
            >
              <span className={cn('h-2 w-2 rounded-full', option.color)} />
              {option.label}
              <span className="ml-auto text-xs text-[var(--text-muted)]">{option.shortLabel}</span>
            </button>
          ))}
        </>
      )}
    </ActionPopover>
  );
}

function DispositionMenu({
  disposition,
  editPolicy,
  onChange,
}: {
  disposition: LocalDisposition;
  editPolicy: TaskEditPolicy;
  onChange: (disposition: LocalDisposition) => void | Promise<void>;
}) {
  const visibleOptions = TASK_DISPOSITION_OPTIONS
    .filter((option) => canSetTaskLocalDisposition(editPolicy, disposition, option.value));
  const restoreOnly = visibleOptions.length === 1 && visibleOptions[0]?.value === 'active';
  const iconFor = (value: LocalDisposition) => value === 'active'
    ? <CircleDot size={14} className="text-sky-400" />
    : value === 'handled'
      ? <CircleCheck size={14} className="text-emerald-400" />
      : <XCircle size={14} className="text-rose-400" />;

  return (
    <ActionPopover
      label={restoreOnly
        ? 'Restore task in Mission Control'
        : 'Manage read-only task in Mission Control'}
      icon={<Archive size={14} />}
      buttonClassName="text-emerald-400 hover:bg-emerald-400/15 hover:text-emerald-300"
    >
      {(_close, run) => (
        <>
          <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Mission Control only
          </p>
          <p className="max-w-64 px-2.5 pb-1.5 text-xs text-[var(--text-muted)]">
            {restoreOnly
              ? 'Restore this previously handled task locally. The upstream task is unchanged.'
              : "These actions never change the upstream task's status."}
          </p>
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`${option.label}. ${option.detail}`}
              className={cn(
                MENU_ITEM_CLASS,
                'items-start py-2',
                disposition === option.value && 'bg-[var(--surface-2)] text-[var(--text-primary)]',
              )}
              onClick={() => void run(() => onChange(option.value))}
            >
              <span className="mt-0.5">{iconFor(option.value)}</span>
              <span>
                <span className="block">{option.label}</span>
                <span className="block text-xs text-[var(--text-muted)]">{option.detail}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </ActionPopover>
  );
}

export interface TaskRowActionsProps {
  dueDate: string | null;
  hasDescription: boolean;
  isInMyDay: boolean;
  priority: string;
  status: string;
  localDisposition?: LocalDisposition;
  editPolicy: TaskEditPolicy;
  surface: 'dashboard' | 'my-day';
  snoozedUntil?: string | null;
  surfaceActions?: ReactNode;
  onSetDueDate: (date: string | null) => void | Promise<void>;
  onSetPriority: (priority: string) => void | Promise<void>;
  onSetStatus: (status: string) => void | Promise<void>;
  onToggleMyDay: () => void | Promise<void>;
  onOpenNotes: (mode: 'read' | 'edit') => void;
  onSnoozeUntil?: (until: string | null) => void | Promise<void>;
  onSetLocalDisposition?: (disposition: LocalDisposition) => void | Promise<void>;
}

export function TaskRowActions({
  dueDate,
  hasDescription,
  isInMyDay,
  priority,
  status,
  localDisposition = 'active',
  editPolicy,
  surface,
  snoozedUntil,
  surfaceActions,
  onSetDueDate,
  onSetPriority,
  onSetStatus,
  onToggleMyDay,
  onOpenNotes,
  onSnoozeUntil,
  onSetLocalDisposition,
}: TaskRowActionsProps) {
  const canEditDueDate = canEditTaskField(editPolicy, 'dueDate');
  const canEditDescription = canEditTaskField(editPolicy, 'description');
  const canEditPriority = canEditTaskField(editPolicy, 'priority');
  const canEditSnooze = canEditTaskField(editPolicy, 'snoozedUntil');
  const canEditStatus = canEditTaskField(editPolicy, 'status');
  const persistentStatus = surface === 'my-day' && status !== 'todo';
  const persistentPriority = surface === 'my-day' && priority !== 'none';

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md px-0.5 transition-[background-color,box-shadow] group-hover:bg-[var(--surface-0)] group-hover:shadow-sm group-focus-within:bg-[var(--surface-0)] group-focus-within:shadow-sm">
      {surfaceActions && (
        <span className={TERTIARY_HOVER_ACTION_SLOT_CLASS}>
          {surfaceActions}
        </span>
      )}

      {surface === 'dashboard' && onSnoozeUntil && (
        <span className={cn('items-center', snoozedUntil ? 'flex' : TERTIARY_HOVER_ACTION_SLOT_CLASS)}>
          <SnoozeMenu
            snoozedUntil={snoozedUntil}
            onChange={onSnoozeUntil}
            disabled={!canEditSnooze}
            disabledReason={taskFieldBlockedReason(editPolicy, 'snoozedUntil')}
          />
        </span>
      )}

      <span className={cn('items-center', isInMyDay ? 'flex' : CORE_HOVER_ACTION_SLOT_CLASS)}>
        <Tooltip content={isInMyDay ? 'Remove from My Day' : 'Add to My Day'}>
          <button
            type="button"
            aria-label={isInMyDay ? 'Remove from My Day' : 'Add to My Day'}
            onClick={(event) => {
              event.stopPropagation();
              void onToggleMyDay();
            }}
            className={cn(ACTION_BUTTON_CLASS, MY_DAY_ACTION_CLASS)}
          >
            <Sun size={14} fill={isInMyDay ? 'currentColor' : undefined} />
          </button>
        </Tooltip>
      </span>

      <span className={cn('items-center', dueDate ? 'flex' : CORE_HOVER_ACTION_SLOT_CLASS)}>
        <DateMenu
          dueDate={dueDate}
          disabled={!canEditDueDate}
          disabledReason={taskFieldBlockedReason(editPolicy, 'dueDate')}
          onChange={onSetDueDate}
        />
      </span>

      <span className={cn('items-center', hasDescription ? 'flex' : SECONDARY_HOVER_ACTION_SLOT_CLASS)}>
        {hasDescription ? (
          <Tooltip content="Open notes">
            <button
              type="button"
              aria-label="Open notes"
              onClick={(event) => {
                event.stopPropagation();
                onOpenNotes('read');
              }}
              className={cn(
                ACTION_BUTTON_CLASS,
                NOTES_ACTION_CLASS,
                'after:absolute after:right-1 after:top-1 after:h-1.5 after:w-1.5 after:rounded-full after:bg-current',
              )}
            >
              <FileText size={14} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content={canEditDescription ? 'Add notes' : taskFieldBlockedReason(editPolicy, 'description')}>
            <button
              type="button"
              aria-label="Add notes"
              onClick={(event) => {
                event.stopPropagation();
                onOpenNotes('edit');
              }}
              disabled={!canEditDescription}
              className={cn(ACTION_BUTTON_CLASS, NOTES_ACTION_CLASS)}
            >
              <FileText size={14} />
            </button>
          </Tooltip>
        )}
      </span>

      <span className={cn(
        'items-center',
        persistentStatus ? 'flex' : WIDE_HOVER_ACTION_SLOT_CLASS,
      )}>
        <StatusMenu
          status={status}
          onChange={onSetStatus}
          persistent={persistentStatus}
          disabled={!canEditStatus}
          disabledReason={taskFieldBlockedReason(editPolicy, 'status')}
        />
      </span>

      <span className={cn(
        'items-center',
        persistentPriority ? 'flex' : WIDE_HOVER_ACTION_SLOT_CLASS,
      )}>
        <PriorityMenu
          priority={priority}
          onChange={onSetPriority}
          persistent={persistentPriority}
          disabled={!canEditPriority}
          disabledReason={taskFieldBlockedReason(editPolicy, 'priority')}
        />
      </span>

      {onSetLocalDisposition
        && TASK_DISPOSITION_OPTIONS.some((option) => (
          option.value !== localDisposition
          && canSetTaskLocalDisposition(editPolicy, localDisposition, option.value)
        )) && (
        <DispositionMenu
          disposition={localDisposition}
          editPolicy={editPolicy}
          onChange={onSetLocalDisposition}
        />
      )}
    </div>
  );
}
