'use client';

import { useState } from 'react';
import { AttributionExceptionReview } from './AttributionExceptionReview';
import { ReceiptReconciliationReview } from './ReceiptReconciliationReview';
import { cn } from '@/lib/utils';

type FinanceReviewFilter = 'attribution' | 'receipt-reconciliation';

export function FinanceReview({
  initialFilter = 'attribution',
  initialReceiptId = null,
}: {
  initialFilter?: FinanceReviewFilter;
  initialReceiptId?: string | null;
}) {
  const [filter, setFilter] = useState<FinanceReviewFilter>(initialFilter);

  const selectFilter = (next: FinanceReviewFilter) => {
    setFilter(next);
    const url = new URL(window.location.href);
    if (next === 'receipt-reconciliation') url.searchParams.set('filter', next);
    else url.searchParams.delete('filter');
    url.searchParams.delete('review');
    window.history.replaceState(null, '', url);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      <nav
        aria-label="Finance review filter"
        className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 sm:px-6"
      >
        <div className="mx-auto flex max-w-7xl gap-1" role="tablist">
          {([
            ['attribution', 'Attribution exceptions'],
            ['receipt-reconciliation', 'Receipt reconciliation'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => selectFilter(value)}
              className={cn(
                'min-h-9 rounded-md px-3 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                filter === value
                  ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>
      <div className="min-h-0 flex-1" role="tabpanel">
        {filter === 'attribution'
          ? <AttributionExceptionReview />
          : <ReceiptReconciliationReview initialReviewId={initialReceiptId} />}
      </div>
    </div>
  );
}
