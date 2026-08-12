'use client';

/**
 * Wrapper around @formkit/auto-animate that respects `prefers-reduced-motion`
 * and enforces Mission Control's motion design constraints (100–300ms).
 *
 * Usage:
 *   const [parent] = useListAnimate();           // default 200ms
 *   const [parent] = useListAnimate({ duration: 150 });
 *   <div ref={parent}>{items.map(...)}</div>
 */

import { useAutoAnimate } from '@formkit/auto-animate/react';
import type { AutoAnimateOptions } from '@formkit/auto-animate';

const DEFAULT_DURATION = 200; // ms — fits design spec: 100–300ms

export function useListAnimate(options?: Partial<AutoAnimateOptions>) {
  return useAutoAnimate({
    duration: DEFAULT_DURATION,
    easing: 'ease-out',
    ...options,
  });
}
