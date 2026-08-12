'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface FilterButtonProps {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
  color: string;
}

export function FilterButton({ active, onClick, icon, label, count, color }: FilterButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors duration-150',
        active
          ? 'bg-[var(--accent-900)]/40 text-[var(--accent-400)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]'
      )}
    >
      <span className={cn(active ? 'text-[var(--accent-400)]' : color)}>{icon}</span>
      <span className="font-medium">{label}</span>
      <span
        className={cn(
          'ml-auto text-[12px] font-medium tabular-nums',
          active ? 'text-[var(--accent-400)]' : 'text-[var(--text-tertiary)]'
        )}
      >
        {count}
      </span>
    </button>
  );
}
