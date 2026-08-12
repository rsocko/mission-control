import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(async () => 'token'),
  getSubstrateToken: vi.fn(async () => 'token'),
  invalidateToken: vi.fn(async () => undefined),
}));

vi.mock('@/lib/logger', () => ({
  connectorLogger: {
    warn: vi.fn(),
  },
}));

import { createGraphClient } from '@/lib/connectors/microsoft-todo/graph-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Microsoft Graph retry safety', () => {
  it('does not retry a POST after a server error', async () => {
    const fetchMock = vi.fn(async () => new Response('uncertain', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createGraphClient('connector-1').graphFetch(
      '/me/todo/lists/list-1/tasks',
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry a POST after a network failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection lost');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createGraphClient('connector-1').graphFetch(
        '/me/todo/lists/list-1/tasks',
        { method: 'POST', body: '{}' },
      ),
    ).rejects.toThrow('connection lost');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
