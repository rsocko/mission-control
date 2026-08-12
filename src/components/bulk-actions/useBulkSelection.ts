'use client';

import { useCallback, useRef, useState } from 'react';

export function resolveSelectionAnchorIndex(
  orderedIds: Array<string | null>,
  lastClickedIndex: number | null,
  selectedId: string | null,
) {
  if (
    lastClickedIndex !== null
    && lastClickedIndex >= 0
    && lastClickedIndex < orderedIds.length
    && orderedIds[lastClickedIndex] !== null
  ) {
    return lastClickedIndex;
  }

  if (selectedId) {
    const selectedIndex = orderedIds.indexOf(selectedId);
    if (selectedIndex >= 0) return selectedIndex;
  }

  return null;
}

/**
 * Hook for managing bulk selection state (checkboxes, shift-click ranges, ctrl-click toggles).
 * Shared across Dashboard, Today, Triage, and Kanban views.
 */
export function useBulkSelection() {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);

  const toggleItem = useCallback((id: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectRange = useCallback(
    (orderedIds: string[], fromIndex: number, toIndex: number) => {
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      setBulkSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          const id = orderedIds[i];
          if (id) next.add(id);
        }
        return next;
      });
    },
    [],
  );

  const clearSelection = useCallback(() => {
    setBulkSelected(new Set());
    setBulkMode(false);
    lastClickedIndexRef.current = null;
  }, []);

  const enterBulkMode = useCallback(() => {
    setBulkMode(true);
  }, []);

  return {
    bulkMode,
    setBulkMode,
    bulkSelected,
    setBulkSelected,
    lastClickedIndexRef,
    toggleItem,
    selectRange,
    clearSelection,
    enterBulkMode,
  };
}
