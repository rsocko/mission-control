'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseResizablePanelOptions {
  /** localStorage key the resolved width is persisted under. */
  storageKey: string;
  /** Smallest width the panel may be dragged to. */
  minWidth: number;
  /** Largest width the panel may be dragged to. */
  maxWidth?: number;
  /** Width used when nothing valid is stored. */
  defaultWidth?: number;
  /** Element measured when a drag starts, so a constrained host wins over stored width. */
  elementRef?: React.RefObject<HTMLElement | null>;
}

export interface UseResizablePanelResult {
  /** Current width in pixels. */
  width: number;
  /** Begin a drag from the resize handle. */
  handleResizeStart: (event: { clientX: number; preventDefault: () => void }) => void;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.max(minWidth, Math.min(maxWidth, width));
}

/** Read a persisted width, falling back to a clamped default. */
export function readStoredPanelWidth(options: {
  storageKey: string;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
}): number {
  const fallback = Math.max(options.minWidth, options.defaultWidth);
  if (typeof window === 'undefined') return fallback;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(options.storageKey);
  } catch {
    return fallback;
  }
  const storedWidth = stored ? Number.parseInt(stored, 10) : Number.NaN;
  return Number.isFinite(storedWidth)
    ? clampWidth(storedWidth, options.minWidth, options.maxWidth)
    : fallback;
}

/**
 * Generic horizontal resize behavior for a side panel: loads a persisted width,
 * clamps every value to the allowed range, tracks a pointer drag, and persists
 * the final width. Drag listeners are always removed, including on unmount.
 */
export function useResizablePanel({
  storageKey,
  minWidth,
  maxWidth = 600,
  defaultWidth = 430,
  elementRef,
}: UseResizablePanelOptions): UseResizablePanelResult {
  const [width, setWidth] = useState(() => readStoredPanelWidth({
    storageKey,
    minWidth,
    maxWidth,
    defaultWidth,
  }));
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const dragRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  // Never leave document-level drag listeners behind when the panel unmounts mid-drag.
  useEffect(() => () => {
    teardownRef.current?.();
    teardownRef.current = null;
    dragRef.current = null;
  }, []);

  const handleResizeStart = useCallback((event: { clientX: number; preventDefault: () => void }) => {
    event.preventDefault();
    teardownRef.current?.();
    const renderedWidth = elementRef?.current?.getBoundingClientRect().width || widthRef.current;
    dragRef.current = { startX: event.clientX, startWidth: renderedWidth, currentWidth: renderedWidth };

    const handleMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - moveEvent.clientX;
      const nextWidth = clampWidth(dragRef.current.startWidth + delta, minWidth, maxWidth);
      dragRef.current.currentWidth = nextWidth;
      setWidth(nextWidth);
    };
    const removeListeners = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      teardownRef.current = null;
    };
    function handleUp() {
      removeListeners();
      if (dragRef.current) {
        try {
          window.localStorage.setItem(storageKey, String(dragRef.current.currentWidth));
        } catch { /* storage unavailable — keep the in-memory width */ }
      }
      dragRef.current = null;
    }

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    teardownRef.current = removeListeners;
  }, [elementRef, maxWidth, minWidth, storageKey]);

  return { width, handleResizeStart };
}
