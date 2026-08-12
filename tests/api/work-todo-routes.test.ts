import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/connectors/work-todo/service', () => ({
  createWorkTodoPullRequest: vi.fn(() => ({ schemaVersion: '1.0' })),
  ingestWorkTodo: vi.fn(),
  leaseWorkTodoChanges: vi.fn(),
  acknowledgeWorkTodoChanges: vi.fn(),
  WorkTodoBridgeError: class WorkTodoBridgeError extends Error {},
}));

describe('Work To Do courier routes', () => {
  const originalApiKey = process.env.MC_API_KEY;

  beforeEach(() => {
    process.env.MC_API_KEY = 'bridge-secret';
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.MC_API_KEY;
    else process.env.MC_API_KEY = originalApiKey;
  });

  it('rejects an unauthenticated request', async () => {
    const { POST } = await import('@/app/api/work-todo/pull-request/route');
    const response = await POST(new Request('http://localhost/api/work-todo/pull-request', {
      method: 'POST',
      body: JSON.stringify({ connectorInstanceId: 'work-todo' }),
    }));

    expect(response.status).toBe(401);
  });

  it('accepts the configured API key', async () => {
    const { POST } = await import('@/app/api/work-todo/pull-request/route');
    const response = await POST(new Request('http://localhost/api/work-todo/pull-request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-API-Key': 'bridge-secret',
      },
      body: JSON.stringify({ connectorInstanceId: 'work-todo' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: '1.0' });
  });

  it('returns 400 for malformed JSON instead of throwing', async () => {
    const { POST } = await import('@/app/api/work-todo/ingest/route');
    const response = await POST(new Request('http://localhost/api/work-todo/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer bridge-secret',
      },
      body: '{',
    }));

    expect(response.status).toBe(400);
  });
});
