import { beforeEach, describe, expect, it, vi } from 'vitest';

function chainable<T>(terminal: T) {
  const chain: Record<PropertyKey, unknown> = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable({ changes: 1 })),
  delete: vi.fn(() => chainable({ changes: 1 })),
};

vi.mock('@/db', () => ({ default: mockDb }));
vi.mock('@/db/schema', () => ({
  notificationSavedViews: {
    id: 'id',
    name: 'name',
    query: 'query',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));
vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    badRequest: (message: string) => Response.json({ error: message }, { status: 400 }),
    notFound: (entity: string) => Response.json({ error: `${entity} not found` }, { status: 404 }),
    internal: (message: string) => Response.json({ error: message }, { status: 500 }),
  },
}));

describe('notification saved views API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns built-in GitHub defaults before custom views', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'custom-1',
      name: 'My queue',
      query: { state: 'unread' },
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    }]));
    const { GET } = await import('@/app/api/notifications/views/route');
    const response = await GET();
    const data = await response.json();

    expect(data.views).toHaveLength(8);
    expect(data.views[0]).toMatchObject({ name: 'Review requests', builtIn: true });
    expect(data.views[7]).toMatchObject({ name: 'My queue', builtIn: false });
  });

  it('canonicalizes filters when creating a named view', async () => {
    const { POST } = await import('@/app/api/notifications/views/route');
    const response = await POST(new Request('http://localhost/api/notifications/views', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Unread reviews',
        query: { state: 'unread', reason: 'review_requested', sort: 'invalid' },
      }),
    }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.view.query).toMatchObject({
      state: 'unread',
      reason: 'review_requested',
      sort: 'newest',
    });
    expect(mockDb.insert).toHaveBeenCalledOnce();
  });

  it('reports duplicate view names as a client error', async () => {
    mockDb.insert.mockImplementationOnce(() => {
      throw new Error('UNIQUE constraint failed: notification_saved_views.name');
    });
    const { POST } = await import('@/app/api/notifications/views/route');
    const response = await POST(new Request('http://localhost/api/notifications/views', {
      method: 'POST',
      body: JSON.stringify({ name: 'Reviews', query: { state: 'unread' } }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A notification view with that name already exists',
    });
  });

  it('protects built-in views from deletion', async () => {
    const { DELETE } = await import('@/app/api/notifications/views/[id]/route');
    const response = await DELETE(
      new Request('http://localhost/api/notifications/views/github-all', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'github-all' }) },
    );

    expect(response.status).toBe(400);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
