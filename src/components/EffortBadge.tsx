'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { EFFORT_BADGE_COLORS, getEffortLabel, getEffortOptions, DEFAULT_EFFORT_MEASURE } from '@/lib/constants/task-formatting';
import type { EffortMeasure } from '@/types';

/**
 * EffortBadge — Displays effort level (1–5) with color coding.
 * Renders using the user's chosen effort measure (t-shirt, simple, label, time).
 */

interface EffortBadgeProps {
  effort: number | null | undefined;
  measure?: EffortMeasure;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  onClick?: () => void;
}

export function EffortBadge({ effort, measure = DEFAULT_EFFORT_MEASURE, showLabel = false, size = 'sm', onClick }: EffortBadgeProps) {
  if (!effort || effort < 1 || effort > 5) return null;

  const label = getEffortLabel(effort, measure);
  const classes = EFFORT_BADGE_COLORS[effort] || '';

  const sizeClasses = size === 'sm'
    ? 'text-xs px-1.5 py-0.5'
    : 'text-xs px-2 py-1';

  return (
    <span
      className={`${sizeClasses} rounded border font-semibold ${classes} ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      onClick={onClick}
      title={`Effort: ${label}`}
    >
      {label}
    </span>
  );
}

/**
 * EffortSelect — Inline dropdown for changing effort level
 */
interface EffortSelectProps {
  effort: number | null | undefined;
  onChange: (newEffort: number | null) => void;
  measure?: EffortMeasure;
  disabled?: boolean;
  /** When true, briefly pulse-highlight the trigger to signal a linked change. */
  highlight?: boolean;
}

export function EffortSelect({ effort, onChange, measure = DEFAULT_EFFORT_MEASURE, disabled, highlight = false }: EffortSelectProps) {
  const options = getEffortOptions(measure);
  const value = String(effort || 0);
  const [flash, setFlash] = useState(false);
  const prevEffort = useRef(effort);

  // Trigger flash animation when value changes from outside (linked sync)
  useEffect(() => {
    if (highlight && effort !== prevEffort.current && effort != null) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(timer);
    }
    prevEffort.current = effort;
  }, [effort, highlight]);

  useEffect(() => {
    prevEffort.current = effort;
  }, [effort]);

  return (
    <Select value={value} onValueChange={(v) => onChange(parseInt(v, 10) || null)} disabled={disabled}>
      <SelectTrigger
        variant="inline"
        className={`w-auto ${flash ? 'linked-field-feedback animate-[pulse-highlight_0.6s_ease-out] ring-2 ring-[var(--accent-600)]/50 scale-110' : ''}`}
        title="Change effort"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={String(opt.value)}>
            {opt.dot && <span className={`inline-block w-2 h-2 rounded-full ${opt.dot} mr-1.5`} />}
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
