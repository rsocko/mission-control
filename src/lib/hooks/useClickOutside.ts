'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Detects clicks outside a referenced element and invokes a callback.
 *
 * @param ref - React ref attached to the element to monitor
 * @param onClickOutside - callback fired on outside click
 * @param isActive - only listens when true (default: true)
 *
 * @example
 * const ref = useRef<HTMLDivElement>(null);
 * useClickOutside(ref, () => setOpen(false), isOpen);
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClickOutside: () => void,
  isActive: boolean = true,
) {
  useEffect(() => {
    if (!isActive) return;

    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClickOutside();
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClickOutside, isActive]);
}
