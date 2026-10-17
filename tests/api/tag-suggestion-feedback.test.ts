import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({
  aiLogger: { info },
}));

describe('POST /api/tag-suggestions/feedback', () => {
  beforeEach(() => {
    info.mockReset();
  });

  it('records bounded structured feedback', async () => {
    const { POST } = await import('@/app/api/tag-suggestions/feedback/route');
    const response = await POST(new Request('http://localhost/api/tag-suggestions/feedback', {
      method: 'POST',
      body: JSON.stringify({
        surface: 'quick-add',
        action: 'applied',
        taskId: 'task-1',
        suggestedTagIds: ['tag-launch', 'tag-release'],
        acceptedTagIds: ['tag-launch'],
        removedTagIds: ['tag-release'],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recorded: 1 });
    expect(info).toHaveBeenCalledWith({
      event: 'tag-recommendation-feedback',
      surface: 'quick-add',
      action: 'applied',
      taskId: 'task-1',
      suggestedTagIds: ['tag-launch', 'tag-release'],
      acceptedTagIds: ['tag-launch'],
      removedTagIds: ['tag-release'],
    }, 'Tag recommendation feedback');
  });

  it('records a bounded batch', async () => {
    const { POST } = await import('@/app/api/tag-suggestions/feedback/route');
    const feedback = {
      surface: 'ai-insights',
      action: 'shown',
      taskId: 'task-1',
      suggestedTagIds: ['tag-launch'],
      acceptedTagIds: [],
      removedTagIds: [],
    };
    const response = await POST(new Request('http://localhost/api/tag-suggestions/feedback', {
      method: 'POST',
      body: JSON.stringify([feedback, { ...feedback, taskId: 'task-2' }]),
    }));

    await expect(response.json()).resolves.toEqual({ recorded: 2 });
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed feedback', async () => {
    const { POST } = await import('@/app/api/tag-suggestions/feedback/route');
    const response = await POST(new Request('http://localhost/api/tag-suggestions/feedback', {
      method: 'POST',
      body: JSON.stringify({ surface: 'unknown' }),
    }));

    expect(response.status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });
});
