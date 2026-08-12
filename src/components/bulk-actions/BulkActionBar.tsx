'use client';

import { type ReactNode } from 'react';

interface BulkActionBarProps {
  selectedCount: number;
  onCancel: () => void;
  children: ReactNode;
}

/**
 * Shared bulk-action toolbar shown when items are selected.
 * Renders a count badge, action buttons (via children), and a Cancel button.
 */
export function BulkActionBar({ selectedCount, onCancel, children }: BulkActionBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="px-4 py-2 border-b border-[var(--border-subtle)] bg-blue-900/20 flex items-center gap-2 flex-wrap"
    >
      <span className="text-xs font-medium text-blue-300">
        {selectedCount} selected
      </span>
      {selectedCount > 0 && children}
      <button
        onClick={onCancel}
        className="text-xs px-2 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors duration-100 ml-auto"
      >
        Cancel
      </button>
    </div>
  );
}
