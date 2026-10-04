'use client';

import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openTaskDelegation } from './events';

export function TaskDelegationButton({
  taskIds,
  className,
  compact = false,
}: {
  taskIds: string[];
  className?: string;
  compact?: boolean;
}) {
  if (!taskIds.length) return null;
  return (
    <button
      type="button"
      onClick={() => openTaskDelegation(taskIds)}
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--accent-500)]/45 bg-[var(--accent-600)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50',
        compact && 'min-h-8 rounded-md px-2',
        className,
      )}
    >
      <Send size={13} aria-hidden="true" />
      Delegate{taskIds.length > 1 ? ` ${taskIds.length}` : ''}
    </button>
  );
}
