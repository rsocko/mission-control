'use client';

import { useCallback } from 'react';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { buildTaskDeepLinkPath } from '@/lib/utils/deep-links';

export function TaskWindow({ taskId }: { taskId: string }) {
  const closeTaskWindow = useCallback(() => {
    window.close();

    window.setTimeout(() => {
      if (!window.closed) {
        window.location.assign(buildTaskDeepLinkPath(taskId));
      }
    }, 0);
  }, [taskId]);

  return (
    <main id="main-content" className="min-h-screen bg-[var(--background)]">
      <TaskDetailPanel
        taskId={taskId}
        mode="workspace"
        onClose={closeTaskWindow}
        allowPopout={false}
        focusPanelOnMount
      />
    </main>
  );
}
