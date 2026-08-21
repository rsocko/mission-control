'use client';

import { ArrowDownAZ, ArrowUpAZ, Dice5, ListOrdered, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { QuickSortOrder } from '@/lib/hooks/useQuickSortData';

const OPTIONS: Array<{
  id: QuickSortOrder;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { id: 'smart', label: 'Smart', icon: Sparkles },
  { id: 'priority', label: 'Priority', icon: ListOrdered },
  { id: 'oldest', label: 'Oldest first', icon: ArrowUpAZ },
  { id: 'newest', label: 'Newest first', icon: ArrowDownAZ },
  { id: 'random', label: 'Random', icon: Dice5 },
];

interface OrderSelectorProps {
  value: QuickSortOrder;
  onChange: (order: QuickSortOrder) => void;
}

export default function OrderSelector({ value, onChange }: OrderSelectorProps) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-2)] p-0.5">
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            title={opt.label}
            aria-pressed={active}
            className={cn(
              'flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-100',
              active
                ? 'bg-[var(--surface-3)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            )}
          >
            <Icon size={13} />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
