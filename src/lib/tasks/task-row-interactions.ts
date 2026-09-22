import type { MouseEventHandler } from 'react';

interface TaskRowModifierEvent {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

interface TaskRowInteractionOptions {
  taskId: string;
  bulkMode?: boolean;
  onBeforeClick?: () => void;
  onSelect: (taskId: string) => void;
  onDoubleClick?: (taskId: string) => void;
  onModifierClick?: (taskId: string, event: TaskRowModifierEvent) => void;
  onBulkClick?: () => void;
}

interface TaskRowInteractionHandlers {
  onMouseDown: MouseEventHandler<HTMLElement>;
  onClick: MouseEventHandler<HTMLElement>;
  onDoubleClick: MouseEventHandler<HTMLElement>;
}

export function createTaskRowInteractionHandlers({
  taskId,
  bulkMode = false,
  onBeforeClick,
  onSelect,
  onDoubleClick,
  onModifierClick,
  onBulkClick,
}: TaskRowInteractionOptions): TaskRowInteractionHandlers {
  return {
    onMouseDown: (event) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    },
    onClick: (event) => {
      onBeforeClick?.();
      if ((event.shiftKey || event.ctrlKey || event.metaKey) && onModifierClick) {
        event.preventDefault();
        onModifierClick(taskId, event);
      } else if (bulkMode && onBulkClick) {
        onBulkClick();
      } else {
        onSelect(taskId);
      }
    },
    onDoubleClick: (event) => {
      if (bulkMode || !onDoubleClick) return;
      event.stopPropagation();
      onDoubleClick(taskId);
    },
  };
}
