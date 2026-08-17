'use client';

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import { Calendar } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { calendarClassNames } from './calendar-classes';
import { parseNLPDateString } from '@/lib/date-parser';

export interface DatePickerProps {
  value: string | null;
  onChange: (date: string) => void;
  placeholder?: string;
  /** Compact inline trigger (icon + text) vs full-width input style */
  variant?: 'inline' | 'input';
  className?: string;
  'aria-label'?: string;
  disabled?: boolean;
  title?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Set date',
  variant = 'input',
  className,
  'aria-label': ariaLabel = 'Pick a date',
  disabled = false,
  title,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [nlpInput, setNlpInput] = React.useState('');
  const [nlpPreview, setNlpPreview] = React.useState<{ date: string; label: string } | null>(null);
  const nlpInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // Focus the NLP input when the popover opens
  React.useEffect(() => {
    if (open) {
      // Small delay to allow the popover to render
      const t = setTimeout(() => nlpInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    } else {
      setNlpInput('');
      setNlpPreview(null);
    }
  }, [open]);

  // Live NLP preview as user types
  React.useEffect(() => {
    if (!nlpInput.trim()) {
      setNlpPreview(null);
      return;
    }
    const result = parseNLPDateString(nlpInput);
    setNlpPreview(result);
  }, [nlpInput]);

  // Normalize: value may be "YYYY-MM-DD" or a full ISO datetime from connectors
  const dateOnly = value ? value.slice(0, 10) : null;
  const parsed = dateOnly ? new Date(dateOnly + 'T00:00:00') : undefined;
  const selected = parsed && !isNaN(parsed.getTime()) ? parsed : undefined;

  function handleSelect(day: Date | undefined) {
    if (day) {
      const yyyy = day.getFullYear();
      const mm = String(day.getMonth() + 1).padStart(2, '0');
      const dd = String(day.getDate()).padStart(2, '0');
      onChange(`${yyyy}-${mm}-${dd}`);
    }
    setOpen(false);
  }

  function handleClear() {
    onChange('');
    setOpen(false);
  }

  function handleNlpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nlpPreview) {
      onChange(nlpPreview.date);
      setOpen(false);
    }
  }

  function handleNlpKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && nlpPreview) {
      e.preventDefault();
      onChange(nlpPreview.date);
      setOpen(false);
    }
  }

  const displayText = selected
    ? format(selected, 'MMM d, yyyy')
    : placeholder;

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => {
      if (!disabled) {
        setOpen(nextOpen);
      }
    }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={title}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 transition-[background-color,border-color] duration-150 outline-none',
            variant === 'input' && [
              'w-full px-3 py-2 text-sm rounded-[var(--radius-md)]',
              'bg-[var(--surface-0)] border border-[var(--border-strong)]',
              'focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30',
            ],
            variant === 'inline' && [
              'px-2 py-1 text-xs rounded-md',
              'hover:bg-[var(--surface-2)] active:scale-[0.96]',
              'border border-transparent focus:border-[var(--accent-500)]',
            ],
            disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
            selected
              ? 'text-[var(--text-secondary)]'
              : 'text-[var(--text-muted)]',
            className,
          )}
        >
          <Calendar size={variant === 'inline' ? 12 : 14} className="shrink-0" />
          <span>{displayText}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className={cn(
            'z-[100] rounded-[var(--radius-lg)] border border-[var(--border-subtle)]',
            'bg-[var(--surface-1)] shadow-2xl',
            'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          {/* NLP date input */}
          <div className="px-3 pt-3 pb-1">
            <form onSubmit={handleNlpSubmit} className="relative">
              <input
                ref={nlpInputRef}
                type="text"
                value={nlpInput}
                onChange={e => setNlpInput(e.target.value)}
                onKeyDown={handleNlpKeyDown}
                placeholder='Type a date, e.g. "next friday"'
                aria-label="Type a natural language date"
                className={cn(
                  'w-full px-2.5 py-1.5 text-xs rounded-md',
                  'bg-[var(--surface-0)] border border-[var(--border-strong)]',
                  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                  'outline-none',
                )}
              />
              {nlpPreview && (
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-emerald-400">
                    <Calendar size={10} className="inline" /> {nlpPreview.label} ({nlpPreview.date})
                  </span>
                  <button
                    type="submit"
                    className="text-[10px] text-[var(--accent-400)] hover:text-[var(--accent-300)] font-medium"
                  >
                    Apply ↵
                  </button>
                </div>
              )}
              {nlpInput.trim() && !nlpPreview && (
                <div className="mt-1.5">
                  <span className="text-[10px] text-[var(--text-muted)]">No date recognised</span>
                </div>
              )}
            </form>
          </div>

          <DayPicker
            mode="single"
            selected={selected}
            onSelect={handleSelect}
            defaultMonth={selected || new Date()}
            showOutsideDays
            classNames={calendarClassNames}
          />

          {/* Footer: clear + today */}
          <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-3 py-2">
            <button
              type="button"
              onClick={handleClear}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => handleSelect(new Date())}
              className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors font-medium"
            >
              Today
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
