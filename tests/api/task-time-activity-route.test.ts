import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  getTaskActivity: vi.fn(),
  start: vi.fn(),
  transition: vi.fn(),
  hasDurableTimeActivity: vi.fn(),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({ timeActivities: repository }),
}));

import { GET, POST } from '@/app/api/tasks/[id]/time-activity/route';

const activity = {
  id: '00000000-0000-4000-8000-000000000001',
  taskId: 'task-a',
  mode: 'focus' as const,
  state: 'running' as const,
  targetSeconds: 60,
  elapsedSeconds: 0,
  activeStartedAt: '2026-09-18T12:00:00.000Z',
  startedAt: '2026-09-18T12:00:00.000Z',
  updatedAt: '2026-09-18T12:00:00.000Z',
  version: 0,
};
const context = { params: Promise.resolve({ id: 'task-a' }) };

describe('task time activity route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.hasDurableTimeActivity.mockResolvedValue(true);
  });

  it('reloads the task activity and durable predicate', async () => {
    repository.getTaskActivity.mockResolvedValue({ taskExists: true, activity });
    const response = await GET(new Request('http://localhost/api/tasks/task-a/time-activity'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activity,
      hasDurableTimeActivity: true,
    });
  });

  it('returns an exact start retry as a replay', async () => {
    repository.start.mockResolvedValue({ kind: 'replayed', activity });
    const response = await POST(new Request('http://localhost/api/tasks/task-a/time-activity', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        commandId: activity.id,
        mode: 'focus',
        targetSeconds: 60,
      }),
    }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activity, replayed: true });
    expect(repository.start).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-a',
      commandId: activity.id,
    }));
  });

  it('reports a competing start without replacing the active timer', async () => {
    repository.start.mockResolvedValue({
      kind: 'conflict',
      reason: 'active-timer',
      activeTaskId: 'task-b',
    });
    const response = await POST(new Request('http://localhost/api/tasks/task-a/time-activity', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        commandId: activity.id,
        mode: 'focus',
        targetSeconds: 60,
      }),
    }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Another task already has an active timer',
      code: 'ACTIVE_TIMER_CONFLICT',
      activeTaskId: 'task-b',
    });
  });

  it('derives deadline duration from server time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-18T12:00:00.000Z');
    repository.start.mockResolvedValue({ kind: 'committed', activity });
    const response = await POST(new Request('http://localhost/api/tasks/task-a/time-activity', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        commandId: activity.id,
        mode: 'deadline',
        targetSeconds: 1,
        deadline: '2026-09-19',
      }),
    }), context);
    expect(response.status).toBe(200);
    expect(repository.start).toHaveBeenCalledWith(expect.objectContaining({
      targetSeconds: 43_200,
      serverNow: '2026-09-18T12:00:00.000Z',
    }));
    vi.useRealTimers();
  });
});
