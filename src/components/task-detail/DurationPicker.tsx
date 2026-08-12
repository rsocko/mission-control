'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const DURATION_PRESETS = [
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 240, label: '4h' },
  { minutes: 480, label: '1d' },
  { minutes: 2400, label: '1w' },
] as const;

export interface DurationPickerProps {
  /** Currently selected duration in minutes (null = none). */
  value: number | null | undefined;
  /** Called when a duration is selected or cleared (toggled off). */
  onChange: (minutes: number | null) => void;
  /** Whether the picker is editable. */
  disabled?: boolean;
  /** Extra className on the wrapper. */
  className?: string;
  /** When true, briefly pulse-highlight the active button to signal a linked change. */
  highlight?: boolean;
}

/**
 * Row of duration preset buttons (15m, 30m, 1h, 2h, 4h).
 * Clicking an active button clears the duration.
 *
 * @example
 * <DurationPicker value={task.estimatedDuration} onChange={handleDurationChange} />
 */
export function DurationPicker({
  value,
  onChange,
  disabled = false,
  className,
  highlight = false,
}: DurationPickerProps) {
  const [flash, setFlash] = useState(false);
  const prevValue = useRef(value);

  // Trigger flash animation when value changes from outside (linked sync)
  useEffect(() => {
    if (highlight && value !== prevValue.current && value != null) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(timer);
    }
    prevValue.current = value;
  }, [value, highlight]);

  // Update ref without triggering flash when highlight is off
  useEffect(() => {
    prevValue.current = value;
  }, [value]);

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {DURATION_PRESETS.map(({ minutes, label }) => {
        const isActive = value === minutes;
        return (
          <button
            key={minutes}
            type="button"
            disabled={disabled}
            onClick={() => onChange(isActive ? null : minutes)}
            className={cn(
              'px-2 py-0.5 rounded text-xs font-medium transition-all duration-150',
              isActive
                ? 'bg-[var(--accent-600)] text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]',
              isActive && flash && 'linked-field-feedback animate-[pulse-highlight_0.6s_ease-out] ring-2 ring-[var(--accent-600)]/50 scale-110',
              disabled && 'opacity-60 cursor-not-allowed',
            )}
          >
            {label}
          </button>
        );
      })}
      {value && !DURATION_PRESETS.some((p) => p.minutes === value) && (
        <span className={cn(
          'text-xs text-[var(--text-secondary)] ml-1 transition-all duration-150',
          flash && 'linked-field-feedback animate-[pulse-highlight_0.6s_ease-out] text-blue-400',
        )}>
          <Clock size={10} className="inline mr-0.5" />
          {value >= 60 ? `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}` : `${value}m`}
        </span>
      )}
    </div>
  );
}
