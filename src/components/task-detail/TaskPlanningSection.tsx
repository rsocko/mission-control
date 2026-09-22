'use client';

import { Bell, FastForward, Repeat } from 'lucide-react';
import RecurrencePicker from '@/components/ui/RecurrencePicker';
import { ReminderPicker } from '@/components/ui/ReminderPicker';
import { formatShortDate } from '@/lib/utils/task-detail-date';
import { cn } from '@/lib/utils';
import type { TaskDetailMode } from './task-detail-types';
import type { ReminderRelativeRule } from '@/lib/tasks/relative-reminder';
import type {
  RecurrenceControlState,
  RecurrenceEditorOptions,
} from '@/lib/recurrence/editor-contract';

export interface TaskPlanningSectionProps {
  mode: TaskDetailMode;
  sectionRef: React.RefObject<HTMLElement | null>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  /** Highlights the section briefly after a jump from the due date field. */
  highlighted: boolean;
  reminderAt: string | null;
  reminderRelative: ReminderRelativeRule | null;
  reminderDueTime: string | null;
  reminderNagInterval: 1 | 5 | 15 | null;
  reminderNagStopAt: string | null;
  reminderTimezone: string;
  dueDate: string | null;
  reminderSaving: boolean;
  canEditReminder: boolean;
  reminderBlockedReason?: string;
  reminderSaveLabel?: string;
  onReminderChange: React.ComponentProps<typeof ReminderPicker>['onChange'];
  /** Whether the connector accepts recurrence edits. */
  supportsRecurrence: boolean;
  /** Active recurrence rule, or 'none'. */
  currentRecurrence: string;
  recurrenceMode: 'schedule' | 'completion';
  completionModeAvailable: boolean;
  canEditRecurrence: boolean;
  recurrenceBlockedReason?: string;
  recurrenceSaveLabel?: string;
  recurrenceControl?: RecurrenceControlState;
  recurrenceOptions: RecurrenceEditorOptions;
  recurrenceOptionsSaving: boolean;
  onRecurrenceChange: (recurrence: string) => void;
  onRecurrenceModeChange: (mode: 'schedule' | 'completion') => void;
  onRecurrenceOptionsChange: (options: RecurrenceEditorOptions) => void;
  /** Next occurrence date when the task is overdue and recurring, else null. */
  skipToCurrentDate: string | null;
  skippingToCurrent: boolean;
  canEditDueDate: boolean;
  dueDateBlockedReason?: string;
  onSkipToCurrent: () => void;
}

/** Reminder and recurrence planning controls. */
export function TaskPlanningSection({
  mode,
  sectionRef,
  headingRef,
  highlighted,
  reminderAt,
  reminderRelative,
  reminderDueTime,
  reminderNagInterval,
  reminderNagStopAt,
  reminderTimezone,
  dueDate,
  reminderSaving,
  canEditReminder,
  reminderBlockedReason,
  reminderSaveLabel,
  onReminderChange,
  supportsRecurrence,
  currentRecurrence,
  recurrenceMode,
  completionModeAvailable,
  canEditRecurrence,
  recurrenceBlockedReason,
  recurrenceSaveLabel,
  recurrenceControl,
  recurrenceOptions,
  recurrenceOptionsSaving,
  onRecurrenceChange,
  onRecurrenceModeChange,
  onRecurrenceOptionsChange,
  skipToCurrentDate,
  skippingToCurrent,
  canEditDueDate,
  dueDateBlockedReason,
  onSkipToCurrent,
}: TaskPlanningSectionProps) {
  const hasRecurrence = currentRecurrence !== 'none';

  return (
    <section
      ref={sectionRef}
      className={cn(
        'overflow-hidden rounded-xl border bg-[var(--surface-0)]/35 transition-[border-color,box-shadow] duration-200',
        highlighted
          ? 'border-blue-400/70 ring-4 ring-blue-500/10'
          : 'border-[var(--border-subtle)]',
        (mode === 'panel' || mode === 'mobile') && 'order-4',
        mode === 'dialog' && 'col-start-2 row-start-3',
        mode === 'workspace' && 'col-start-2 row-start-3',
      )}
    >
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="border-b border-[var(--border-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--text-secondary)] outline-none"
      >
        Planning
      </h3>
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-3" title={!canEditReminder ? reminderBlockedReason : reminderSaveLabel}>
          <Bell size={13} className={`flex-shrink-0 ${reminderAt ? 'text-purple-400' : 'text-[var(--text-muted)]'}`} />
          <ReminderPicker
            value={reminderAt ?? null}
            relativeRule={reminderRelative}
            dueDate={dueDate}
            dueTime={reminderDueTime}
            nagInterval={reminderNagInterval}
            nagStopAt={reminderNagStopAt}
            timezone={reminderTimezone}
            saving={reminderSaving}
            onChange={canEditReminder ? onReminderChange : () => false}
            disabled={!canEditReminder}
          />
        </div>

        {(supportsRecurrence || hasRecurrence) && (
          <div className={cn(
            'flex items-start gap-3 rounded-lg border p-2 transition-colors',
            hasRecurrence
              ? 'border-blue-400/25 bg-blue-500/[0.06]'
              : 'border-transparent',
          )}>
            <Repeat size={13} className={`mt-1 flex-shrink-0 ${hasRecurrence ? 'text-blue-400' : 'text-[var(--text-muted)]'}`} />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div title={!canEditRecurrence ? recurrenceBlockedReason : recurrenceSaveLabel}>
                <RecurrencePicker
                  value={currentRecurrence}
                  onChange={onRecurrenceChange}
                  mode={recurrenceMode}
                  onModeChange={onRecurrenceModeChange}
                  completionModeAvailable={completionModeAvailable}
                  variant="compact"
                  disabled={!supportsRecurrence || !canEditRecurrence}
                  startDate={dueDate}
                  timezone={reminderTimezone}
                  options={recurrenceOptions}
                  onOptionsChange={onRecurrenceOptionsChange}
                  optionsSaving={recurrenceOptionsSaving}
                  controlState={recurrenceControl}
                  advancedEditingAvailable={completionModeAvailable}
                />
              </div>
              {skipToCurrentDate && (
                <button
                  type="button"
                  onClick={onSkipToCurrent}
                  disabled={skippingToCurrent || !canEditDueDate}
                  title={!canEditDueDate
                    ? dueDateBlockedReason
                    : `Skip overdue occurrences and set due date to ${formatShortDate(skipToCurrentDate)}`}
                  aria-busy={skippingToCurrent}
                  className="flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-blue-400/30 bg-blue-500/10 px-2 text-left text-xs font-medium text-blue-300 transition-colors hover:border-blue-400/50 hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:cursor-wait disabled:opacity-60"
                >
                  <FastForward size={12} aria-hidden="true" />
                  Skip to current
                  <span className="ml-auto text-xs font-normal text-[var(--text-muted)]">
                    Next: {formatShortDate(skipToCurrentDate)}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
