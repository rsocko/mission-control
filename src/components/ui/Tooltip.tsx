'use client';

import React, { type ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

/* ─── Types ──────────────────────────────────────────────────────────── */

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  /** Simple text label */
  content: ReactNode;
  /** Optional secondary line (rendered smaller, muted) */
  subtitle?: string;
  /** Optional keyboard shortcut badge */
  shortcut?: string;
  /** Preferred placement — auto-flips if off-screen */
  placement?: Placement;
  /** Delay before showing (ms). Default 200 — fast but avoids flicker */
  delay?: number;
  /** Extra className on the tooltip bubble */
  className?: string;
  children: ReactNode;
  /** Disable the tooltip (e.g. when a menu is open) */
  disabled?: boolean;
}

/* ─── Component ──────────────────────────────────────────────────────── */

export function Tooltip({
  content,
  subtitle,
  shortcut,
  placement = 'top',
  delay = 200,
  className = '',
  children,
  disabled = false,
}: TooltipProps) {
  if (disabled) {
    return <>{children}</>;
  }

  return (
    <RadixTooltip.Root delayDuration={delay}>
      <RadixTooltip.Trigger asChild>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={placement}
          sideOffset={6}
          className={`
            pointer-events-none select-none
            max-w-[280px] px-2.5 py-1.5
            bg-[var(--surface-3)] text-[var(--text-primary)]
            border border-[var(--border-strong)]
            rounded-[var(--radius-md)] shadow-[var(--shadow-lg)]
            text-xs leading-snug z-[9999]
            motion-tooltip animate-[tooltipIn_100ms_ease-out_both]
            ${className}
          `}
        >
          <div className="flex items-center gap-2">
            <span>{content}</span>
            {shortcut && (
              <kbd className="ml-auto text-xs font-mono text-[var(--text-muted)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-1 py-0.5 leading-none">
                {shortcut}
              </kbd>
            )}
          </div>
          {subtitle && (
            <div className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</div>
          )}
          <RadixTooltip.Arrow className="fill-[var(--surface-3)]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ─── Provider (wrap app root) ───────────────────────────────────────── */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={200} skipDelayDuration={100}>
      {children}
    </RadixTooltip.Provider>
  );
}
