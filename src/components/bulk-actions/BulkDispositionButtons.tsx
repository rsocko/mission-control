'use client';

import { Archive, CircleCheck } from 'lucide-react';
import type { LocalDisposition, TaskEditPolicy } from '@/types';
import { selectedTaskDispositionBlockedReason } from '@/lib/tasks/client-edit-policy';

interface BulkDispositionButtonsProps {
  tasks: ReadonlyArray<{
    editPolicy: TaskEditPolicy;
    localDisposition: LocalDisposition;
  }>;
  onSetDisposition: (disposition: Exclude<LocalDisposition, 'active'>) => Promise<void>;
}

const ACTIONS = [
  {
    disposition: 'handled',
    label: 'Handled here',
    detail: 'Hide selected tasks locally without completing them upstream.',
    icon: CircleCheck,
  },
  {
    disposition: 'dismissed',
    label: 'Dismiss here',
    detail: 'Hide selected tasks locally without deleting them upstream.',
    icon: Archive,
  },
] as const;

export function BulkDispositionButtons({
  tasks,
  onSetDisposition,
}: BulkDispositionButtonsProps) {
  return ACTIONS.map((action) => {
    const blockedReason = selectedTaskDispositionBlockedReason(tasks, action.disposition);
    const Icon = action.icon;
    return (
      <button
        key={action.disposition}
        type="button"
        disabled={Boolean(blockedReason)}
        title={blockedReason ?? `${action.detail} Mission Control only.`}
        aria-label={`${action.label}. ${blockedReason ?? `${action.detail} Mission Control only.`}`}
        onClick={() => { void onSetDisposition(action.disposition); }}
        className="inline-flex min-h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-emerald-800/40 bg-emerald-900/30 px-2 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-900/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon size={12} aria-hidden="true" />
        {action.label}
      </button>
    );
  });
}
