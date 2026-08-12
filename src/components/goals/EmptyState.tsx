'use client';

import { Target } from 'lucide-react';
import { GOAL_TYPE_CONFIG, type FilterType } from './types';

interface EmptyStateProps {
  filter: FilterType;
}

export function EmptyState({ filter }: EmptyStateProps) {
  const config = filter === 'all' ? null : GOAL_TYPE_CONFIG[filter];
  const Icon = config?.icon || Target;

  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-12 h-12 rounded-full bg-[var(--surface-2)] flex items-center justify-center">
        <Icon size={20} className="text-[var(--text-tertiary)]" />
      </div>
      <p className="text-sm text-[var(--text-secondary)]">
        {filter === 'all' ? 'This is where your big-picture thinking lives' : `No ${filter}s yet — ready when you are`}
      </p>
      <p className="text-xs text-[var(--text-tertiary)] max-w-xs text-center">
        Tag any task with <code className="text-[var(--accent-400)]">#goal</code>,{' '}
        <code className="text-[var(--accent-400)]">#idea</code>, or{' '}
        <code className="text-[var(--accent-400)]">#brainstorm</code> and it&apos;ll appear here.
      </p>
    </div>
  );
}
