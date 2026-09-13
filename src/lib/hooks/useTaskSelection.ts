'use client';

import { useCallback, useEffect, useRef } from 'react';

interface UseTaskSelectionOptions {
  selectedTaskId: string | null;
  onSelectionChange: (taskId: string | null) => void;
  onDoubleClick?: (taskId: string) => void;
}

export function useTaskSelection({
  selectedTaskId,
  onSelectionChange,
  onDoubleClick,
}: UseTaskSelectionOptions) {
  const selectedTaskIdRef = useRef(selectedTaskId);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onDoubleClickRef = useRef(onDoubleClick);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
    onSelectionChangeRef.current = onSelectionChange;
    onDoubleClickRef.current = onDoubleClick;
  }, [onDoubleClick, onSelectionChange, selectedTaskId]);

  const applySelection = useCallback((taskId: string | null) => {
    selectedTaskIdRef.current = taskId;
    onSelectionChangeRef.current(taskId);
  }, []);

  const selectTask = useCallback((taskId: string) => {
    if (selectedTaskIdRef.current !== taskId) {
      applySelection(taskId);
    }
  }, [applySelection]);

  const handleTaskClick = useCallback((taskId: string) => {
    selectTask(taskId);
  }, [selectTask]);

  const handleTaskDoubleClick = useCallback((taskId: string) => {
    if (selectedTaskIdRef.current !== taskId) {
      applySelection(taskId);
    }
    onDoubleClickRef.current?.(taskId);
  }, [applySelection]);

  return {
    selectTask,
    handleTaskClick,
    handleTaskDoubleClick,
  };
}
