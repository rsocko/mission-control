import { afterEach, describe, expect, it, vi } from 'vitest';

describe('MCP API client authorization', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends the configured API key on task updates', async () => {
    vi.stubEnv('MC_BASE_URL', 'https://mc.example');
    vi.stubEnv('MC_API_KEY', 'secret-api-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { mcPatch } = await import('@/mcp/client');

    const result = await mcPatch('/api/tasks/task-1', { status: 'done' });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://mc.example/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-MC-API-Key': 'secret-api-key',
      }),
    }));
  });

  it('returns an explicit error for an unauthorized API response', async () => {
    vi.stubEnv('MC_BASE_URL', 'https://mc.example');
    vi.stubEnv('MC_API_KEY', 'wrong-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));
    const { mcPatch } = await import('@/mcp/client');

    const result = await mcPatch('/api/tasks/task-1', { status: 'done' });

    expect(result).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });
});
