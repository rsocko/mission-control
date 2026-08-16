'use client';

import { Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DuplicateTaskPreview } from './DuplicateTaskPreview';
import type { DuplicateCandidate } from './DuplicateTaskPreview';
import type { TaskDetailMode } from './task-detail-types';

export interface TaskDuplicatesSectionProps {
  mode: TaskDetailMode;
  /** Detected duplicate candidates; only the first three are shown. */
  duplicates: DuplicateCandidate[];
  canEditStatus: boolean;
  /** Closes this task as a duplicate of the surfaced candidate. */
  onCloseAsDuplicate: () => void;
  onDismiss: () => void;
}

/** Banner listing potential duplicates of an open task. */
export function TaskDuplicatesSection({
  mode,
  duplicates,
  canEditStatus,
  onCloseAsDuplicate,
  onDismiss,
}: TaskDuplicatesSectionProps) {
  if (duplicates.length === 0) return null;

  return (
    <section className={cn(
      'rounded-xl border border-purple-500/20 bg-purple-500/5 p-3',
      (mode === 'panel' || mode === 'mobile') && 'order-6',
      mode === 'dialog' && 'col-start-2 row-start-5',
      mode === 'workspace' && 'col-start-2 row-start-5',
    )}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-sm"><Copy size={14} /></span>
        <span className="text-xs font-semibold text-purple-400">
          {duplicates.length === 1 ? 'Potential duplicate detected' : `${duplicates.length} potential duplicates detected`}
        </span>
      </div>
      <div className="space-y-1.5">
        {duplicates.slice(0, 3).map((duplicate) => (
          <div key={duplicate.id} className="flex items-start gap-2">
            <DuplicateTaskPreview candidate={duplicate} />
            {canEditStatus && (
              <button
                onClick={onCloseAsDuplicate}
                className="flex-shrink-0 text-xs px-2 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
              >
                Close as dup
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        onClick={onDismiss}
        className="mt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        Dismiss
      </button>
    </section>
  );
}
