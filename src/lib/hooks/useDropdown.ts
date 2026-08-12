'use client';

import { useCallback, useRef, useState } from 'react';
import { useClickOutside } from './useClickOutside';

/**
 * Manages dropdown open/close state with automatic click-outside dismissal.
 *
 * @param initialOpen - whether the dropdown starts open (default: false)
 *
 * @example
 * const dropdown = useDropdown();
 *
 * return (
 *   <div ref={dropdown.ref}>
 *     <button onClick={dropdown.toggle}>Menu</button>
 *     {dropdown.isOpen && <div className="dropdown-content">...</div>}
 *   </div>
 * );
 */
export function useDropdown(initialOpen: boolean = false) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  useClickOutside(ref, close, isOpen);

  return { isOpen, setIsOpen, toggle, close, open, ref } as const;
}
