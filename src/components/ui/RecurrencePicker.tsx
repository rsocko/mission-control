'use client';

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2, Plus, X } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import type {
  RecurrenceControlState,
  RecurrenceEditorOptions,
  RecurrencePreviewResponse,
} from '@/lib/recurrence/editor-contract';

const PRESET_OPTIONS = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon\u2013Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom\u2026' },
] as const;

const DAYS_OF_WEEK = [
  { short: 'Mon', full: 'monday' },
  { short: 'Tue', full: 'tuesday' },
  { short: 'Wed', full: 'wednesday' },
  { short: 'Thu', full: 'thursday' },
  { short: 'Fri', full: 'friday' },
  { short: 'Sat', full: 'saturday' },
  { short: 'Sun', full: 'sunday' },
] as const;

const DEFAULT_RECURRENCE_OPTIONS: RecurrenceEditorOptions = {
  skipDates: [],
  catchUp: 'latest',
};

/**
 * Build the internal recurrence value string from custom interval settings.
 */
function buildCustomValue(intervalN: number, intervalUnit: string, selectedDays: string[]): string {
  if (intervalUnit === 'week' && selectedDays.length > 0) {
    if (intervalN === 1) {
      return `weekly (${selectedDays.join(', ')})`;
    }
    return `every ${intervalN} weeks (${selectedDays.join(', ')})`;
  }
  if (intervalN === 1) {
    const simpleMap: Record<string, string> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };
    return simpleMap[intervalUnit] || `every 1 ${intervalUnit}`;
  }
  if (intervalN === 2 && intervalUnit === 'week') return 'biweekly';
  return `every ${intervalN} ${intervalUnit}s`;
}

/**
 * Build a human-readable label for a custom recurrence value.
 */
export function getRecurrenceDisplayLabel(value: string): string {
  const preset = PRESET_OPTIONS.find(o => o.value === value);
  if (preset && preset.value !== 'custom') return preset.label;

  const dayShortLabels: Record<string, string> = {
    monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
    friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  };

  // "weekly (monday, wednesday)" or "every N weeks (monday, wednesday)"
  const weeklyDaysMatch = value.match(/^(?:weekly|every (\d+) weeks?) \(([^)]+)\)$/i);
  if (weeklyDaysMatch) {
    const n = weeklyDaysMatch[1] ? parseInt(weeklyDaysMatch[1], 10) : 1;
    const days = weeklyDaysMatch[2].split(',').map(s => s.trim());
    const labels = days.map(d => dayShortLabels[d] || d);
    const prefix = n === 1 ? 'Weekly' : `Every ${n} weeks`;
    return `${prefix} on ${labels.join(', ')}`;
  }

  // "every N days/weeks/months/years"
  const everyNMatch = value.match(/^every (\d+) (days?|weeks?|months?|years?)$/i);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    const unit = everyNMatch[2].replace(/s$/, '');
    if (n === 1) {
      const simple: Record<string, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
      return simple[unit] || `Every ${n} ${unit}`;
    }
    return `Every ${n} ${unit}s`;
  }

  return value;
}

/**
 * Parse an existing recurrence value into custom interval settings for editing.
 */
function parseExistingValue(value: string): { intervalN: number; intervalUnit: string; selectedDays: string[] } {
  // "weekly (monday, wednesday)" or "every N weeks (monday, wednesday)"
  const weeklyDaysMatch = value.match(/^(?:weekly|every (\d+) weeks?) \(([^)]+)\)$/i);
  if (weeklyDaysMatch) {
    const n = weeklyDaysMatch[1] ? parseInt(weeklyDaysMatch[1], 10) : 1;
    const days = weeklyDaysMatch[2].split(',').map(s => s.trim().toLowerCase());
    return { intervalN: n, intervalUnit: 'week', selectedDays: days };
  }

  const everyNMatch = value.match(/^every (\d+) (days?|weeks?|months?|years?)$/i);
  if (everyNMatch) {
    return { intervalN: parseInt(everyNMatch[1], 10), intervalUnit: everyNMatch[2].replace(/s$/, ''), selectedDays: [] };
  }

  const simpleMap: Record<string, { intervalN: number; intervalUnit: string; selectedDays: string[] }> = {
    daily: { intervalN: 1, intervalUnit: 'day', selectedDays: [] },
    weekdays: { intervalN: 1, intervalUnit: 'day', selectedDays: [] },
    weekly: { intervalN: 1, intervalUnit: 'week', selectedDays: [] },
    biweekly: { intervalN: 2, intervalUnit: 'week', selectedDays: [] },
    monthly: { intervalN: 1, intervalUnit: 'month', selectedDays: [] },
    yearly: { intervalN: 1, intervalUnit: 'year', selectedDays: [] },
  };
  return simpleMap[value] || { intervalN: 1, intervalUnit: 'day', selectedDays: [] };
}

interface RecurrencePickerProps {
  value: string;
  onChange: (value: string) => void;
  mode?: 'schedule' | 'completion';
  onModeChange?: (mode: 'schedule' | 'completion') => void;
  completionModeAvailable?: boolean;
  /** Compact inline style for detail panel vs. full-width for add-task modal */
  variant?: 'full' | 'compact';
  /** When true, the picker is non-interactive */
  disabled?: boolean;
  startDate?: string | null;
  timezone?: string;
  options?: RecurrenceEditorOptions;
  onOptionsChange?: (options: RecurrenceEditorOptions) => void;
  optionsSaving?: boolean;
  controlState?: RecurrenceControlState | null;
  advancedEditingAvailable?: boolean;
}

export default function RecurrencePicker({
  value,
  onChange,
  mode = 'schedule',
  onModeChange,
  completionModeAvailable = false,
  variant = 'full',
  disabled = false,
  startDate,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  options = DEFAULT_RECURRENCE_OPTIONS,
  onOptionsChange,
  optionsSaving = false,
  controlState,
  advancedEditingAvailable = true,
}: RecurrencePickerProps) {
  const isPreset = PRESET_OPTIONS.some(o => o.value === value) && value !== 'custom';
  const isCustom = !isPreset && value !== 'none';

  const [showCustom, setShowCustom] = useState(isCustom);
  const [intervalN, setIntervalN] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState('day');
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const [skipDate, setSkipDate] = useState('');
  const [preview, setPreview] = useState<RecurrencePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const controlId = useId();
  const recurrenceReadOnly = disabled
    || controlState?.owner === 'provider'
    || controlState?.support === 'unsupported'
    || controlState?.support === 'lossy';
  const canEditAdvanced = !recurrenceReadOnly
    && !optionsSaving
    && advancedEditingAvailable
    && Boolean(onOptionsChange);
  const effectiveTimezone = controlState?.timezone || timezone;
  const effectiveStartDate = startDate?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const effectiveLocalTime = controlState?.localTime
    ?? startDate?.match(/T([0-2]\d:[0-5]\d(?::[0-5]\d)?)/)?.[1]
    ?? null;

  // Sync custom fields when value changes externally
  useEffect(() => {
    if (isCustom && value !== 'none') {
      const parsed = parseExistingValue(value);
      setIntervalN(parsed.intervalN);
      setIntervalUnit(parsed.intervalUnit);
      setSelectedDays(parsed.selectedDays);
      setShowCustom(true);
    } else {
      setShowCustom(false);
    }
  }, [value, isCustom]);

  const selectValue = isCustom ? 'custom' : value;
  const displayedPreview: RecurrencePreviewResponse | null =
    controlState?.support === 'unsupported' && !controlState.rule
      ? { status: 'unsupported', reasons: controlState.reasons }
      : preview;

  useEffect(() => {
    if (
      value === 'none'
      || (controlState?.support === 'unsupported' && !controlState.rule)
    ) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      fetch('/api/recurrence/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          recurrence: value,
          mode,
          startDate: effectiveStartDate,
          localTime: effectiveLocalTime,
          timezone: effectiveTimezone,
          options,
          rule: controlState?.owner === 'provider' ? controlState.rule : undefined,
        }),
      })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(typeof body.error === 'string' ? body.error : 'Preview unavailable');
          }
          return response.json() as Promise<RecurrencePreviewResponse>;
        })
        .then(setPreview)
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : 'Preview unavailable');
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    controlState?.owner,
    controlState?.rule,
    effectiveLocalTime,
    effectiveStartDate,
    effectiveTimezone,
    mode,
    options,
    previewAttempt,
    value,
  ]);

  const handleSelectChange = (v: string) => {
    if (v === 'custom') {
      setShowCustom(true);
      // Default to "every 2 days" to make it immediately useful
      setIntervalN(2);
      setIntervalUnit('day');
      setSelectedDays([]);
      onChange('every 2 days');
    } else {
      setShowCustom(false);
      onChange(v);
    }
  };

  const handleCustomChange = (newN: number, newUnit: string, newDays: string[]) => {
    setIntervalN(newN);
    setIntervalUnit(newUnit);
    setSelectedDays(newDays);
    const newValue = buildCustomValue(newN, newUnit, newDays);
    onChange(newValue);
  };

  const toggleDay = (day: string) => {
    const newDays = selectedDays.includes(day)
      ? selectedDays.filter(d => d !== day)
      : [...selectedDays, day];
    handleCustomChange(intervalN, intervalUnit, newDays);
  };

  const isCompact = variant === 'compact';

  return (
    <div className={isCompact ? 'flex flex-col gap-1.5' : 'space-y-2'}>
      <Select value={selectValue} onValueChange={handleSelectChange} disabled={recurrenceReadOnly}>
        <SelectTrigger
          aria-label="Task recurrence"
          disabled={recurrenceReadOnly}
          className={
            isCompact
              ? `text-xs bg-[var(--surface-2)] outline-none rounded px-1 py-0.5 border border-transparent ${recurrenceReadOnly ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${value !== 'none' ? 'text-blue-400' : 'text-[var(--text-muted)]'}`
              : `w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] ${recurrenceReadOnly ? 'opacity-60 cursor-not-allowed' : ''}`
          }
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value !== 'none' && completionModeAvailable && onModeChange && (
        <div className="space-y-1">
          <Select value={mode} onValueChange={(next) => onModeChange(next as 'schedule' | 'completion')} disabled={recurrenceReadOnly}>
            <SelectTrigger
              aria-label="Recurrence anchor"
              className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="schedule">On the fixed schedule</SelectItem>
              <SelectItem value="completion">After I complete it</SelectItem>
            </SelectContent>
          </Select>
          {mode === 'completion' && (
            <p className="text-xs text-[var(--text-muted)]">
              The next task is scheduled from when this one is completed.
            </p>
          )}
        </div>
      )}

      {showCustom && !recurrenceReadOnly && (
        <div className={`space-y-2 ${isCompact ? '' : 'pl-0.5'}`}>
          {/* Interval row: every [N] [unit] */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[var(--text-muted)]">Every</span>
            <input
              type="number"
              min={1}
              max={365}
              value={intervalN}
              onChange={(e) => {
                const n = Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 1));
                handleCustomChange(n, intervalUnit, selectedDays);
              }}
              className="w-14 bg-[var(--surface-0)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-[var(--text-primary)] text-center focus:outline-none"
              aria-label="Repeat interval number"
            />
            <Select
              value={intervalUnit}
              onValueChange={(u) => {
                const newDays = u === 'week' ? selectedDays : [];
                handleCustomChange(intervalN, u, newDays);
              }}
            >
              <SelectTrigger className="w-24 bg-[var(--surface-0)] border border-[var(--border)] rounded-md px-2 py-1 text-xs text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">{intervalN === 1 ? 'day' : 'days'}</SelectItem>
                <SelectItem value="week">{intervalN === 1 ? 'week' : 'weeks'}</SelectItem>
                <SelectItem value="month">{intervalN === 1 ? 'month' : 'months'}</SelectItem>
                <SelectItem value="year">{intervalN === 1 ? 'year' : 'years'}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Day-of-week multi-select (only for weekly intervals) */}
          {intervalUnit === 'week' && (
            <div className="flex gap-1 flex-wrap">
              {DAYS_OF_WEEK.map(({ short, full }) => (
                <button
                  key={full}
                  type="button"
                  onClick={() => toggleDay(full)}
                  className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                    selectedDays.includes(full)
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-[var(--surface-0)] border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-secondary)]'
                  }`}
                  aria-label={`Toggle ${short}`}
                  aria-pressed={selectedDays.includes(full)}
                >
                  {short}
                </button>
              ))}
            </div>
          )}

          {/* Summary label */}
          <p className="text-xs text-[var(--text-muted)] italic">
            {getRecurrenceDisplayLabel(value)}
          </p>
        </div>
      )}

      {value !== 'none' && (
        <details
          aria-busy={optionsSaving}
          className="group rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)]/55"
        >
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
            <CalendarClock size={13} aria-hidden="true" className="text-blue-400" />
            Schedule details
            <span className="ml-auto text-xs font-normal text-[var(--text-muted)]">
              {options.skipDates.length > 0 ? `${options.skipDates.length} skipped` : effectiveTimezone}
            </span>
          </summary>
          <div className="space-y-3 border-t border-[var(--border-subtle)] p-3">
            {controlState && (
              <div
                className={`rounded-lg border px-2.5 py-2 text-xs ${
                  controlState.owner === 'provider' || controlState.support !== 'supported'
                    ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                    : 'border-blue-400/20 bg-blue-500/[0.06] text-blue-200'
                }`}
                role={controlState.support === 'unsupported' ? 'alert' : 'status'}
              >
                {controlState.owner === 'provider'
                  ? 'This schedule is owned by the provider. Change it at the source; Mission Control will not write previewed dates back.'
                  : 'Mission Control owns this schedule. Saved changes stay with this task.'}
                {controlState.support !== 'supported' && (
                  <span className="mt-1 block text-amber-300">
                    {controlState.support === 'lossy'
                      ? 'The imported rule lost provider-specific detail, so editing is disabled.'
                      : 'This imported rule cannot be projected or edited safely.'}
                  </span>
                )}
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {effectiveLocalTime ? `Wall-clock time in ${effectiveTimezone}` : `Dates use ${effectiveTimezone}`}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
                {effectiveLocalTime
                  ? 'The local time stays fixed across daylight-saving changes. Missing times shift forward; repeated times use the earlier offset.'
                  : 'This is an all-day schedule, so daylight-saving clock changes do not move its date.'}
              </p>
            </div>

            {mode === 'schedule' && (
              <div className="space-y-1.5">
                <label htmlFor={`${controlId}-catch-up`} className="text-xs font-medium text-[var(--text-secondary)]">
                  If Mission Control falls behind
                </label>
                <Select
                  value={options.catchUp}
                  onValueChange={(catchUp) => onOptionsChange?.({
                    ...options,
                    catchUp: catchUp as RecurrenceEditorOptions['catchUp'],
                  })}
                  disabled={!canEditAdvanced}
                >
                  <SelectTrigger
                    id={`${controlId}-catch-up`}
                    aria-label="Recurrence catch-up policy"
                    className="w-full bg-[var(--surface-0)] text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">Create only the latest missed task</SelectItem>
                    <SelectItem value="none">Wait for the next scheduled task</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-[var(--text-muted)]">
                  {optionsSaving ? 'Saving recurrence options…' : 'Missed dates never pile up into a backlog.'}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor={`${controlId}-skip-date`} className="text-xs font-medium text-[var(--text-secondary)]">
                Skip dates
              </label>
              <div className="flex min-w-0 gap-2">
                <input
                  id={`${controlId}-skip-date`}
                  type="date"
                  value={skipDate}
                  onChange={(event) => setSkipDate(event.target.value)}
                  disabled={!canEditAdvanced}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!skipDate || options.skipDates.includes(skipDate)) return;
                    onOptionsChange?.({
                      ...options,
                      skipDates: [...options.skipDates, skipDate].sort(),
                    });
                    setSkipDate('');
                  }}
                  disabled={!canEditAdvanced || !skipDate || options.skipDates.includes(skipDate)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={12} aria-hidden="true" />
                  Skip
                </button>
              </div>
              {options.skipDates.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">No dates are excluded.</p>
              ) : (
                <ul aria-label="Skipped recurrence dates" className="flex flex-wrap gap-1.5">
                  {options.skipDates.map((date) => (
                    <li key={date} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-2 pr-1 text-xs text-[var(--text-secondary)]">
                      <time dateTime={date}>{formatPreviewDate(date)}</time>
                      <button
                        type="button"
                        onClick={() => onOptionsChange?.({
                          ...options,
                          skipDates: options.skipDates.filter((candidate) => candidate !== date),
                        })}
                        disabled={!canEditAdvanced}
                        aria-label={`Remove skipped date ${date}`}
                        className="rounded-full p-0.5 hover:bg-[var(--surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div aria-live="polite" aria-busy={previewLoading} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-2.5">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {mode === 'completion' ? 'If completed now' : 'Upcoming'}
              </p>
              {previewLoading ? (
                <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Loader2 size={12} aria-hidden="true" className="animate-spin" />
                  Calculating preview…
                </div>
              ) : previewError ? (
                <div className="mt-2 flex items-start gap-2 text-xs text-red-300">
                  <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
                  <span className="flex-1">{previewError}</span>
                  <button
                    type="button"
                    onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
                    className="font-medium text-blue-300 underline underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              ) : displayedPreview?.status === 'success' && displayedPreview.occurrences.length > 0 ? (
                <ol className="mt-2 grid gap-1 sm:grid-cols-2">
                  {displayedPreview.occurrences.map((occurrence) => (
                    <li key={`${occurrence.localDate}-${occurrence.instant ?? ''}`} className="text-xs text-[var(--text-secondary)]">
                      <time dateTime={occurrence.instant ?? occurrence.localDate}>
                        {formatPreviewDate(occurrence.localDate, occurrence.localTime)}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : displayedPreview?.status === 'unsupported' || displayedPreview?.status === 'invalid' ? (
                <p className="mt-2 text-xs leading-relaxed text-amber-300">
                  Preview unavailable: {formatReason(
                    displayedPreview.status === 'unsupported'
                      ? displayedPreview.reasons
                      : displayedPreview.issues,
                  )}
                </p>
              ) : (
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  No occurrences fall within the next ten years.
                </p>
              )}
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Preview only — no tasks are created and nothing is sent to a provider.
              </p>
            </div>

            {!advancedEditingAvailable && controlState?.owner !== 'provider' && (
              <p className="text-xs text-[var(--text-muted)]">
                Exceptions and catch-up policy are managed in Mission Control for local tasks.
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function formatPreviewDate(date: string, localTime?: string | null): string {
  const parsed = new Date(`${date}T12:00:00`);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
  if (!localTime) return dateLabel;
  const [hour, minute] = localTime.split(':').map(Number);
  parsed.setHours(hour, minute, 0, 0);
  return `${dateLabel}, ${new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed)}`;
}

function formatReason(reasons: readonly string[]): string {
  return reasons
    .map((reason) => reason.replace(/^.*?:\s*/, '').replaceAll('_', ' '))
    .join(', ');
}
