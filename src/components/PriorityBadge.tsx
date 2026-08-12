'use client';

import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';

/**
 * PriorityBadge — Displays P0–P3 priority labels with color coding.
 * Used across dashboard, kanban, and task detail views.
 */

const PRIORITY_CONFIG: Record<string, { pLevel: string; label: string; classes: string }> = {
  critical: { pLevel: 'P0', label: 'Critical', classes: 'text-rose-400 bg-rose-900/40 border-rose-700/50' },
  high:     { pLevel: 'P1', label: 'High',     classes: 'text-orange-400 bg-orange-900/30 border-orange-800/40' },
  medium:   { pLevel: 'P2', label: 'Medium',   classes: 'text-amber-300 bg-amber-900/25 border-amber-700/35' },
  low:      { pLevel: 'P3', label: 'Low',      classes: 'text-sky-400 bg-sky-900/25 border-sky-700/35' },
  none:     { pLevel: '—',  label: 'None',     classes: 'text-[var(--text-muted)] bg-[var(--surface-2)] border-[var(--border)]' },
};

interface PriorityBadgeProps {
  priority: string;
  showLabel?: boolean; // Show "P0 · Critical" vs just "P0"
  size?: 'sm' | 'md';
  onClick?: () => void;
}

export function PriorityBadge({ priority, showLabel = false, size = 'sm', onClick }: PriorityBadgeProps) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.none;
  
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
}

export function PrioritySelect({ priority, onChange, disabled }: PrioritySelectProps) {
  return (
    <Select value={priority} onValueChange={(v) => onChange(v)} disabled={disabled}>
      <SelectTrigger className="text-xs border border-[var(--border-strong)] rounded px-1.5 py-0.5 bg-[var(--surface-2)] text-[var(--text-primary)] w-auto" title="Change priority">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">— None</SelectItem>
        <SelectItem value="critical">P0 · Critical</SelectItem>
        <SelectItem value="high">P1 · High</SelectItem>
        <SelectItem value="medium">P2 · Medium</SelectItem>
        <SelectItem value="low">P3 · Low</SelectItem>
      </SelectContent>
    </Select>
  );
}

