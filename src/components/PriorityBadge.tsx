'use client';

import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  getTaskPriorityVisual,
  TASK_PRIORITY_VISUALS,
} from '@/lib/constants/task-formatting';

/**
 * PriorityBadge — Displays P0–P3 priority labels with color coding.
 * Used across dashboard, kanban, and task detail views.
 */

interface PriorityBadgeProps {
  priority: string;
  showLabel?: boolean; // Show "P0 · Critical" vs just "P0"
  size?: 'sm' | 'md';
  onClick?: () => void;
}

export function PriorityBadge({ priority, showLabel = false, size = 'sm', onClick }: PriorityBadgeProps) {
  const visual = getTaskPriorityVisual(priority);
  const config = { pLevel: visual.shortLabel, label: visual.label, classes: visual.badgeClass };
  
  if (priority === 'none') return null;

  const sizeClasses = size === 'sm' 
    ? 'text-xs px-1.5 py-0.5' 
    : 'text-xs px-2 py-1';

  return (
    <span 
      className={`${sizeClasses} rounded border font-semibold ${config.classes} ${onClick ? 'cursor-pointer hover:opacity-80' : ''}`}
      onClick={onClick}
      title={`${config.pLevel} — ${config.label}`}
    >
      {config.pLevel}{showLabel ? ` · ${config.label}` : ''}
    </span>
  );
}

/**
 * PrioritySelect — Inline dropdown for changing priority
 */
interface PrioritySelectProps {
  priority: string;
  onChange: (newPriority: string) => void;
  disabled?: boolean;
  allowedPriorities?: readonly string[];
  includeNone?: boolean;
  ariaLabel?: string;
  title?: string;
  triggerClassName?: string;
  labelStyle?: 'full' | 'name';
}

export function PrioritySelect({
  priority,
  onChange,
  disabled,
  allowedPriorities,
  includeNone = true,
  ariaLabel = 'Task priority',
  title = 'Change priority',
  triggerClassName,
  labelStyle = 'full',
}: PrioritySelectProps) {
  const options = Object.entries(TASK_PRIORITY_VISUALS)
    .filter(([value]) => includeNone || value !== 'none')
    .filter(([value]) => !allowedPriorities || allowedPriorities.includes(value));

  return (
    <Select value={priority} onValueChange={(v) => onChange(v)} disabled={disabled}>
      <SelectTrigger
        aria-label={ariaLabel}
        variant="inline"
        className={cn(
          'w-auto',
          getTaskPriorityVisual(priority).textClass,
          triggerClassName,
        )}
        title={title}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([value, visual]) => (
          <SelectItem key={value} value={value} className={visual.textClass}>
            {labelStyle === 'full' ? `${visual.shortLabel} · ${visual.label}` : visual.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
