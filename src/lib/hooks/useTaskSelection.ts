'use client';

import { useCallback, useEffect, useRef } from 'react';

const DEFAULT_DOUBLE_CLICK_DELAY = 300;

interface UseTaskSelectionOptions {
  selectedTaskId: string | null;
  onSelectionChange: (taskId: string | null) => void;
  onDoubleClick?: (taskId: string) => void;
  doubleClickDelay?: number;
}

export function useTaskSelection({
  selectedTaskId,
  onSelectionChange,
  onDoubleClick,
  doubleClickDelay = DEFAULT_DOUBLE_CLICK_DELAY,
}: UseTaskSelectionOptions) {
  const selectedTaskIdRef = useRef(selectedTaskId);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onDoubleClickRef = useRef(onDoubleClick);
  const pendingDeselectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  selectedTaskIdRef.current = selectedTaskId;
  onSelectionChangeRef.current = onSelectionChange;
  onDoubleClickRef.current = onDoubleClick;

  const clearPendingDeselect = useCallback(() => {
    if (pendingDeselectRef.current !== null) {
      clearTimeout(pendingDeselectRef.current);
      pendingDeselectRef.current = null;
    }
  }, []);

  const applySelection = useCallback((taskId: string | null) => {
    selectedTaskIdRef.current = taskId;
    onSelectionChangeRef.current(taskId);
  }, []);

  const toggleTask = useCallback((taskId: string) => {
    clearPendingDeselect();
    applySelection(selectedTaskIdRef.current === taskId ? null : taskId);
  }, [applySelection, clearPendingDeselect]);

  const handleTaskClick = useCallback((taskId: string) => {
    clearPendingDeselect();

    if (selectedTaskIdRef.current !== taskId) {
      applySelection(taskId);
      return;
    }

    pendingDeselectRef.current = setTimeout(() => {
      pendingDeselectRef.current = null;
      if (selectedTaskIdRef.current === taskId) {
        applySelection(null);
      }
    }, doubleClickDelay);
  }, [applySelection, clearPendingDeselect, doubleClickDelay]);

  const handleTaskDoubleClick = useCallback((taskId: string) => {
    clearPendingDeselect();
    if (selectedTaskIdRef.current !== taskId) {
      applySelection(taskId);
    }
    onDoubleClickRef.current?.(taskId);
  }, [applySelection, clearPendingDeselect]);

  useEffect(() => clearPendingDeselect, [clearPendingDeselect]);

  return {
    toggleTask,
    handleTaskClick,
    handleTaskDoubleClick,
    cancelPendingDeselect: clearPendingDeselect,
  };
}
