'use client';

import { CheckCircle2 } from 'lucide-react';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';

type ShowCompletedToggleProps =
  | {
      showCompleted: boolean;
      onShowCompletedChange: (showCompleted: boolean) => void;
    }
  | {
      showCompleted?: undefined;
      onShowCompletedChange?: undefined;
    };

export function ShowCompletedToggle({
  showCompleted: controlledShowCompleted,
  onShowCompletedChange,
}: ShowCompletedToggleProps = {}) {
  const statusFilter = useDashboardViewStore((s) => s.statusFilter);
  const setStatusFilter = useDashboardViewStore((s) => s.setStatusFilter);
  const showCompleted = controlledShowCompleted ?? statusFilter.includes('done');

  const toggle = () => {
    if (onShowCompletedChange) {
      onShowCompletedChange(!showCompleted);
      return;
    }
    if (showCompleted) {
      setStatusFilter(statusFilter.filter((s) => s !== 'done'));
    } else {
      setStatusFilter([...statusFilter, 'done']);
    }
  };

  return (
    <button
      onClick={toggle}
      aria-pressed={showCompleted}
      aria-label={showCompleted ? 'Hide completed tasks' : 'Show completed tasks'}
      className={`flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium border rounded-[var(--radius-md)] transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-0)] ${
        showCompleted
          ? 'text-[var(--success)] bg-emerald-900/20 border-emerald-800/40 hover:bg-emerald-900/30'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)] border-[var(--border)]'
      }`}
    >
      <CheckCircle2 size={13} />
      <span className="hidden lg:inline">Done</span>
    </button>
  );
}
