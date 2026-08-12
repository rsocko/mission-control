'use client';

import { useRef, useLayoutEffect } from 'react';

/**
 * FLIP animation hook for virtualized lists.
 *
 * Tracks the `translateY` offset of each item by key across renders.
 * When an item's position changes (reorder, sort), it animates
 * from its old position to its new one using a CSS transition on
 * `translate` — without conflicting with the virtualizer's inline
 * `transform: translateY(...)`.
 *
 * When a major data swap occurs (e.g. filter change causing a refetch),
 * the hook detects that most items are new, skips FLIP (which would cause
 * overlap), and instead applies a subtle fade-in to the container.
 */

interface VirtualFlipItem {
  key: string;
  start: number;
}

interface UseVirtualFlipOptions {
  /** Duration in ms for the reposition animation */
  duration?: number;
  /** Easing function */
  easing?: string;
  /** Container ref to query item elements */
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * Threshold: if fewer than this fraction of current items existed in the
 * previous render, treat it as a bulk data change (skip FLIP).
 */
const CONTINUITY_THRESHOLD = 0.5;

export function useVirtualFlip(
  items: VirtualFlipItem[],
  options: UseVirtualFlipOptions,
) {
  const { duration = 250, easing = 'cubic-bezier(0.25, 0.1, 0.25, 1)', containerRef } = options;

  // Map of key -> previous Y offset
  const prevPositions = useRef<Map<string, number>>(new Map());
  // Track which keys existed last render to detect new items
  const prevKeys = useRef<Set<string>>(new Set());
  // Flag to skip the first render (don't animate on mount)
  const isFirstRender = useRef(true);

  useLayoutEffect(() => {
    // Respect reduced motion preference
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (isFirstRender.current) {
      isFirstRender.current = false;
      // Snapshot initial positions
      const map = new Map<string, number>();
      for (const item of items) {
        map.set(item.key, item.start);
      }
      prevPositions.current = map;
      prevKeys.current = new Set(items.map((i) => i.key));
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const oldPositions = prevPositions.current;
    const oldKeys = prevKeys.current;
    const newPositions = new Map<string, number>();
    const newKeys = new Set<string>();

    for (const item of items) {
      newPositions.set(item.key, item.start);
      newKeys.add(item.key);
    }

    // Detect major data swap: if most items are new, skip per-item FLIP
    // and do a container-level fade instead.
    let survivorCount = 0;
    for (const item of items) {
      if (oldKeys.has(item.key)) survivorCount++;
    }
    const continuity = items.length > 0 ? survivorCount / items.length : 1;
    const isBulkChange = continuity < CONTINUITY_THRESHOLD;

    if (!prefersReduced) {
      if (isBulkChange) {
        // Bulk data swap (filter change): fade the container in smoothly
        container.style.transition = 'none';
        container.style.opacity = '0.4';
        void container.offsetHeight;
        container.style.transition = `opacity ${duration}ms ${easing}`;
        container.style.opacity = '1';
      } else {
        // Incremental change (sort, complete, small filter): per-item FLIP
        for (const item of items) {
          const el = container.querySelector(
            `[data-flip-key="${CSS.escape(item.key)}"]`,
          ) as HTMLElement | null;
          if (!el) continue;

          const oldY = oldPositions.get(item.key);

          if (oldY !== undefined && oldY !== item.start) {
            // FLIP: item moved — invert then play
            const deltaY = oldY - item.start;
            el.style.transition = 'none';
            el.style.translate = `0 ${deltaY}px`;
            el.style.opacity = '1';

            // Force reflow
            void el.offsetHeight;

            el.style.transition = `translate ${duration}ms ${easing}, opacity ${duration}ms ${easing}`;
            el.style.translate = '0 0';
          } else if (!oldKeys.has(item.key)) {
            // New item entering viewport — subtle fade + slide
            el.style.transition = 'none';
            el.style.opacity = '0';
            el.style.translate = '0 8px';

            void el.offsetHeight;

            el.style.transition = `opacity ${duration}ms ${easing}, translate ${duration}ms ${easing}`;
            el.style.opacity = '1';
            el.style.translate = '0 0';
          }
        }
      }
    }

    // Snapshot for next render
    prevPositions.current = newPositions;
    prevKeys.current = newKeys;
  });

  // Clean up transitions after they complete (avoid stale transition on scroll)
  const handleTransitionEnd = (e: React.TransitionEvent) => {
    const el = e.target as HTMLElement;
    if (el.dataset.flipKey) {
      el.style.transition = '';
      el.style.translate = '';
    }
    // Clean container opacity transition
    const container = containerRef.current;
    if (el === container) {
      el.style.transition = '';
      el.style.opacity = '';
    }
  };

  return { handleTransitionEnd };
}
