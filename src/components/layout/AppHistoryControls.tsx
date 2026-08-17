'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useAppHistory } from '@/lib/hooks/useAppHistory';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';

interface HistoryButtonProps {
  direction: 'Back' | 'Forward';
  disabled: boolean;
  onClick: () => void;
}

function HistoryButton({ direction, disabled, onClick }: HistoryButtonProps) {
  const Icon = direction === 'Back' ? ArrowLeft : ArrowRight;
  const tooltip = disabled
    ? `No ${direction.toLowerCase()} destination in Mission Control`
    : direction;

  return (
    <Tooltip content={tooltip} placement="bottom">
      <span className="inline-flex">
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={direction}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
            disabled
              ? 'cursor-not-allowed text-[var(--text-muted)] opacity-40'
              : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
          )}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      </span>
    </Tooltip>
  );
}

export function AppHistoryControls() {
  const {
    back,
    forward,
    canGoBack,
    canGoForward,
  } = useAppHistory();

  return (
    <div
      className="flex shrink-0 items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5"
      role="group"
      aria-label="Navigation history"
    >
      <HistoryButton
        direction="Back"
        disabled={!canGoBack}
        onClick={back}
      />
      <HistoryButton
        direction="Forward"
        disabled={!canGoForward}
        onClick={forward}
      />
    </div>
  );
}
