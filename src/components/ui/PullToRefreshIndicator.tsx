'use client';

import { Loader2 } from 'lucide-react';

interface PullToRefreshIndicatorProps {
  pullDistance: number;
  isRefreshing: boolean;
}

/**
 * Visual indicator for pull-to-refresh.
 * Uses absolute positioning so it does NOT push content/title bars down.
 * Render inside a container with `position: relative` and `overflow: hidden`.
 */
export function PullToRefreshIndicator({ pullDistance, isRefreshing }: PullToRefreshIndicatorProps) {
  if (pullDistance === 0 && !isRefreshing) return null;

  return (
    <div
      className="absolute left-0 right-0 top-0 z-50 flex items-center justify-center pointer-events-none"
      style={{ height: `${pullDistance}px` }}
    >
      <Loader2
        size={18}
        className={`text-[var(--accent-400)] ${isRefreshing ? 'animate-spin' : ''}`}
        style={{
          opacity: Math.min(pullDistance / 32, 1),
          transform: `rotate(${pullDistance * 3}deg)`,
        }}
      />
    </div>
  );
}
