'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import { Bell, Clock, Sun, Calendar, X } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { calendarClassNames } from './calendar-classes';

// ─── Preset helpers ─────────────────────────────────────────────────────────

function getLaterToday(): Date | null {
  const now = new Date();
  // If it's past 6pm, "later today" doesn't make sense
  if (now.getHours() >= 18) return null;
  const later = new Date(now);
  // Round up to next hour + 3 hours (or 6pm if sooner)
  later.setMinutes(0, 0, 0);
  later.setHours(Math.min(later.getHours() + 3, 18));
  return later;
}

function getTomorrow9am(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function getNextWeekMonday9am(): Date {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d;
}

function formatPresetTime(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatReminderDisplay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  // Today
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  if (d >= todayStart && d < tomorrow) return `Today, ${timeStr}`;
  if (d >= tomorrow && d < dayAfter) return `Tomorrow, ${timeStr}`;

  return format(d, 'MMM d') + `, ${timeStr}`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface ReminderPickerProps {
  value: string | null;
  onChange: (isoDatetime: string | null) => void;
  disabled?: boolean;
  /** Compact inline trigger (used in detail panel) */
  variant?: 'inline' | 'badge';
}

export function ReminderPicker({
  value,
  onChange,
  disabled = false,
  variant = 'inline',
}: ReminderPickerProps) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customTime, setCustomTime] = useState('09:00');
  const timeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Reset custom picker when popover closes
  useEffect(() => {
    if (!open) setShowCustom(false);
  }, [open]);

  const laterToday = getLaterToday();
  const tomorrow = getTomorrow9am();
  const nextWeek = getNextWeekMonday9am();

  const isPast = value ? new Date(value) < new Date() : false;
  const hasReminder = !!value && !isPast;

  const handlePreset = useCallback((d: Date) => {
    onChange(d.toISOString());
    setOpen(false);
  }, [onChange]);

  const handleCustomSelect = useCallback((day: Date | undefined) => {
    if (!day) return;
    const [h, m] = customTime.split(':').map(Number);
    day.setHours(h, m, 0, 0);
    // Don't allow past reminders
    if (day <= new Date()) {
      day.setHours(new Date().getHours() + 1, 0, 0, 0);
    }
    onChange(day.toISOString());
    setOpen(false);
  }, [customTime, onChange]);

  const handleClear = useCallback(() => {
    onChange(null);
    setOpen(false);
  }, [onChange]);

  const triggerContent = value && !isPast
    ? formatReminderDisplay(value)
    : 'Set reminder';

  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!disabled) setOpen(next); }}>
      <Popover.Trigger asChild>
        {variant === 'inline' ? (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-[background-color,border-color] duration-150 outline-none',
              'hover:bg-[var(--surface-2)] active:scale-[0.96]',
              'border border-transparent',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              hasReminder ? 'text-purple-400' : 'text-[var(--text-muted)]',
            )}
            aria-label="Set reminder"
          >
            <Bell size={12} className="shrink-0" />
            <span>{triggerContent}</span>
            {hasReminder && !disabled && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); handleClear(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleClear(); } }}
                className="ml-0.5 hover:text-red-400 transition-colors"
                title="Clear reminder"
                aria-label="Clear reminder"
              >
                <X size={10} />
              </span>
            )}
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            className={cn(
              'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border transition-colors',
              hasReminder
                ? 'border-purple-800/30 bg-purple-900/20 text-purple-400'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
              disabled && 'cursor-not-allowed opacity-60',
            )}
            aria-label="Set reminder"
          >
            <Bell size={10} />
            {hasReminder && <span>{formatReminderDisplay(value!)}</span>}
          </button>
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className={cn(
            'z-[100] rounded-[var(--radius-lg)] border border-[var(--border-subtle)]',
            'bg-[var(--surface-1)] shadow-2xl',
            'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            showCustom ? 'w-auto' : 'w-56',
          )}
        >
          {!showCustom ? (
            <div className="py-1">
              <div className="px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                Remind me
              </div>

              {laterToday && (
                <button
                  onClick={() => handlePreset(laterToday)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  <Clock size={14} className="text-purple-400/70 shrink-0" />
                  <span className="flex-1 text-left">Later today</span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {laterToday.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                  </span>
                </button>
              )}

              <button
                onClick={() => handlePreset(tomorrow)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <Sun size={14} className="text-purple-400/70 shrink-0" />
                <span className="flex-1 text-left">Tomorrow</span>
                <span className="text-xs text-[var(--text-muted)]">{formatPresetTime(tomorrow)}</span>
              </button>

              <button
                onClick={() => handlePreset(nextWeek)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <Calendar size={14} className="text-purple-400/70 shrink-0" />
                <span className="flex-1 text-left">Next week</span>
                <span className="text-xs text-[var(--text-muted)]">{formatPresetTime(nextWeek)}</span>
              </button>

              <div className="border-t border-[var(--border-subtle)] my-1" />

              <button
                onClick={() => setShowCustom(true)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <Calendar size={14} className="text-[var(--text-muted)] shrink-0" />
                <span className="flex-1 text-left">Pick a date &amp; time</span>
              </button>

              {hasReminder && (
                <>
                  <div className="border-t border-[var(--border-subtle)] my-1" />
                  <button
                    onClick={handleClear}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/10 transition-colors"
                  >
                    <X size={14} className="shrink-0" />
                    <span className="flex-1 text-left">Remove reminder</span>
                  </button>
                </>
              )}
            </div>
          ) : (
            <div>
              <DayPicker
                mode="single"
                onSelect={handleCustomSelect}
                defaultMonth={new Date()}
                disabled={{ before: new Date() }}
                showOutsideDays
                classNames={calendarClassNames}
              />
              <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-3 py-2">
                <button
                  type="button"
                  onClick={() => setShowCustom(false)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  ← Back
                </button>
                <div className="flex items-center gap-1.5">
                  <Clock size={12} className="text-[var(--text-muted)]" />
                  <input
                    ref={timeInputRef}
                    type="time"
                    value={customTime}
                    onChange={(e) => setCustomTime(e.target.value)}
                    className="text-xs bg-transparent border border-[var(--border-strong)] rounded px-1.5 py-0.5 text-[var(--text-secondary)] outline-none w-20"
                  />
                </div>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
