'use client';

import {
  OfflineActionBlockedError,
  queueAction,
  requestActionBackgroundSync,
  registerActionHandler,
  unregisterActionHandler,
} from '@/lib/offline-queue';
import type { TaskPatchInput } from '@/lib/tasks/task-patch';

const TASK_PATCH_ACTION = 'task.patch';

interface QueuedTaskPatch {
  id: string;
  patch: TaskPatchInput;
  expectedUpdatedAt?: string;
}

export async function persistTaskPatch(
  id: string,
  patch: TaskPatchInput,
  options: { expectedUpdatedAt?: string; allowOffline?: boolean } = {},
): Promise<{ queued: boolean }> {
  const queue = async () => {
    if (!options.allowOffline) {
      throw new Error('This source cannot be updated until Mission Control is reachable.');
    }
    await queueTaskPatch(id, patch, options.expectedUpdatedAt);
    return { queued: true };
  };

  if (!navigator.onLine) return queue();

  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(options.expectedUpdatedAt ? { 'X-Expected-Task-Updated-At': options.expectedUpdatedAt } : {}),
      },
      body: JSON.stringify(patch),
    });
    if (response.ok) return { queued: false };

    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Mission Control returned HTTP ${response.status}`);
  } catch (error) {
    if (error instanceof TypeError) return queue();
    throw error;
  }
}

export async function queueTaskPatch(
  id: string,
  patch: TaskPatchInput,
  expectedUpdatedAt?: string,
): Promise<void> {
  await queueAction({
    type: TASK_PATCH_ACTION,
    expectedUpdatedAt,
    payload: { id, patch, expectedUpdatedAt } satisfies QueuedTaskPatch,
  });
  await requestActionBackgroundSync();
}

export function registerOfflineTaskActionHandlers(): () => void {
  registerActionHandler(TASK_PATCH_ACTION, async (payload) => {
    const { id, patch, expectedUpdatedAt } = payload as unknown as QueuedTaskPatch;
    if (!id || !patch || typeof patch !== 'object') {
      throw new OfflineActionBlockedError('This queued task change is invalid and cannot be synced.');
    }

    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(expectedUpdatedAt ? { 'X-Expected-Task-Updated-At': expectedUpdatedAt } : {}),
      },
      body: JSON.stringify(patch),
    });
    if (response.ok) return;

    const body = await response.json().catch(() => null) as { error?: string } | null;
    const message = body?.error || `Mission Control returned HTTP ${response.status}`;
    if (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 409) {
      throw new OfflineActionBlockedError(message);
    }
    throw new Error(message);
  });

  return () => unregisterActionHandler(TASK_PATCH_ACTION);
}
