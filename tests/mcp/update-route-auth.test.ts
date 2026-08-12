import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateTask } = vi.hoisted(() => ({
  updateTask: vi.fn(),
}));

vi.mock('@/app/api/tasks/[id]/route', () => ({
  PATCH: updateTask,
}));

import { PATCH } from '@/app/api/mcp/tasks/[id]/route';

function request(headers: Record<string, string> = {}) {
  return new Request('https://mc.example/api/mcp/tasks/task-1', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ status: 'done' }),
  });
}

const context = { params: Promise.resolve({ id: 'task-1' }) };

describe('MCP task update route authorization', () => {
  beforeEach(() => {
    updateTask.mockReset();
    updateTask.mockResolvedValue(Response.json({ success: true }));
  });

  afterEach(() => {
    delete process.env.MC_API_KEY;
  });

  it('rejects missing credentials when an API key is configured', async () => {
    process.env.MC_API_KEY = 'trusted-key';

    const response = await PATCH(request(), context);

    expect(response.status).toBe(401);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('rejects an invalid API key', async () => {
    process.env.MC_API_KEY = 'trusted-key';

    const response = await PATCH(request({ 'X-MC-API-Key': 'wrong-key' }), context);

    expect(response.status).toBe(401);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('forwards an authorized API-key request to the task updater', async () => {
    process.env.MC_API_KEY = 'trusted-key';
    const authorizedRequest = request({ 'X-MC-API-Key': 'trusted-key' });

    const response = await PATCH(authorizedRequest, context);

    expect(response.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(authorizedRequest, context);
  });

  it('preserves documented open local mode when no API key is configured', async () => {
    const localRequest = request();

    const response = await PATCH(localRequest, context);

    expect(response.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(localRequest, context);
  });
});
