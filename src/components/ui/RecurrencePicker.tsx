'use client';

import { useState, useEffect } from 'react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';

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
  /** Compact inline style for detail panel vs. full-width for add-task modal */
  variant?: 'full' | 'compact';
  /** When true, the picker is non-interactive */
  disabled?: boolean;
}

export default function RecurrencePicker({ value, onChange, variant = 'full', disabled = false }: RecurrencePickerProps) {
  const isPreset = PRESET_OPTIONS.some(o => o.value === value) && value !== 'custom';
  const isCustom = !isPreset && value !== 'none';

  const [showCustom, setShowCustom] = useState(isCustom);
  const [intervalN, setIntervalN] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState('day');
  const [selectedDays, setSelectedDays] = useState<string[]>([]);

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
      <Select value={selectValue} onValueChange={handleSelectChange} disabled={disabled}>
        <SelectTrigger
          aria-label="Task recurrence"
          disabled={disabled}
          className={
            isCompact
              ? `text-xs bg-[var(--surface-2)] outline-none rounded px-1 py-0.5 border border-transparent ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${value !== 'none' ? 'text-blue-400' : 'text-[var(--text-muted)]'}`
              : `w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`
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

      {showCustom && (
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
    </div>
  );
}
