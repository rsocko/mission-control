'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';
import { triggerHapticFeedback } from '@/lib/utils/haptics';

interface UsePullToRefreshOptions {
  /** Function to call on pull-to-refresh */
  onRefresh: () => Promise<void> | void;
  /** Minimum pull distance in px to trigger refresh (default: 80) */
  threshold?: number;
  /** Whether pull-to-refresh is enabled (default: true) */
  enabled?: boolean;
}

interface UsePullToRefreshReturn {
  /** Ref to attach to the scrollable container */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Whether a refresh is currently in progress */
  isRefreshing: boolean;
  /** Current pull distance (for showing indicator) */
  pullDistance: number;
  /** Props to spread on the container element */
  containerProps: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  /** Style to apply to the content wrapper so it translates down without layout shift */
  contentStyle: React.CSSProperties;
}

/**
 * Hook for pull-to-refresh on mobile.
 * Attach `containerRef` and spread `containerProps` on the scrollable element.
 */
export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  enabled = true,
}: UsePullToRefreshOptions): UsePullToRefreshReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startY = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isPulling = useRef(false);
  const thresholdHapticTriggered = useRef(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Reset pull distance when disabled
  useEffect(() => {
    if (!enabled) {
      setPullDistance(0);
      isPulling.current = false;
    }
  }, [enabled]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || isRefreshing) return;
      const container = containerRef.current;
      // Only allow pull when scrolled to top
      if (container && container.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        isPulling.current = true;
        thresholdHapticTriggered.current = false;
      }
    },
    [enabled, isRefreshing]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isPulling.current || !enabled || isRefreshing) return;
      const container = containerRef.current;
      if (!container || container.scrollTop > 0) {
        isPulling.current = false;
        setPullDistance(0);
        return;
      }
      const deltaY = e.touches[0].clientY - startY.current;
      if (deltaY > 0) {
        // Prevent native overscroll/pull-to-refresh from moving the header
        e.preventDefault();
        // Apply resistance — diminishing returns as you pull further
        const resistance = Math.min(deltaY * 0.4, 120);
        if (resistance >= threshold * 0.4 && !thresholdHapticTriggered.current) {
          thresholdHapticTriggered.current = true;
          triggerHapticFeedback('refreshThreshold');
        }
        setPullDistance(resistance);
      }
    },
    [enabled, isRefreshing, threshold]
  );

  const onTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;
    isPulling.current = false;
    thresholdHapticTriggered.current = false;

    if (pullDistance >= threshold * 0.4) {
      setIsRefreshing(true);
      setPullDistance(threshold * 0.4); // Hold at indicator height
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, threshold, onRefresh]);

  const transition = prefersReducedMotion ? 'none' : 'transform 0.2s ease-out';
  const contentStyle: React.CSSProperties = pullDistance > 0
    ? { transform: `translateY(${pullDistance}px)`, transition: isPulling.current ? 'none' : transition }
    : { transition };

  return {
    containerRef,
    isRefreshing,
    pullDistance,
    containerProps: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    contentStyle,
  };
}
