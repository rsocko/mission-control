'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SectionCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(
      'overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-1)]',
      className,
    )}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 mt-5 px-1 text-[0.625rem] font-semibold uppercase tracking-[0.2em] text-[var(--text-tertiary)]">
      {children}
    </p>
  );
}

export function Toggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
      className={cn(
        'relative inline-flex h-[28px] w-[50px] flex-shrink-0 items-center rounded-full transition-colors duration-200',
        enabled ? 'bg-[var(--accent-500)]' : 'bg-[var(--surface-3)]',
      )}
    >
      <span
        className={cn(
          'inline-block h-[22px] w-[22px] rounded-full bg-white shadow-sm transition-transform duration-200',
          enabled ? 'translate-x-[25px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}
