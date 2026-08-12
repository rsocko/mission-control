'use client';

import type { ReactNode } from 'react';

export function MetricChip({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-md bg-[var(--surface-0)] border border-[var(--border-subtle)] px-2 py-2">
      <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">{label}</div>
      <div className="text-sm font-medium text-[var(--text-primary)]">{String(value ?? 0)}</div>
    </div>
  );
}

export function SuggestionChip({ text, onClick, disabled }: { text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-xs px-3 py-1.5 border border-[var(--border)] rounded-full text-[var(--text-secondary)] hover:bg-blue-900/30 hover:border-blue-300 transition-colors disabled:opacity-50"
    >
      {text}
    </button>
  );
}

export function AgentButton({
  icon,
  label,
  desc,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  desc?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left border border-[var(--border)] rounded-lg p-2.5 hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/10 transition-colors group disabled:opacity-50"
    >
      <div className="flex items-center gap-2">
        <span className="text-[var(--text-tertiary)] group-hover:text-[var(--accent-400)]">{icon}</span>
        <div className="min-w-0">
          <span className="text-xs font-medium text-[var(--text-secondary)] group-hover:text-[var(--accent-400)]">{label}</span>
          {desc ? <p className="text-xs text-[var(--text-muted)] truncate">{desc}</p> : null}
        </div>
      </div>
    </button>
  );
}
