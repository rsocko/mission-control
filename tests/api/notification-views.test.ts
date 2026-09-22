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

const mockWebPersistence = {
  listSavedViews: vi.fn().mockResolvedValue([]),
  createSavedView: vi.fn().mockImplementation((input: Record<string, unknown>) => Promise.resolve({
    id: input.id,
    name: input.name,
    query: JSON.stringify(input.query),
    createdAt: input.now,
    updatedAt: input.now,
  })),
  deleteSavedView: vi.fn().mockResolvedValue(true),
};
vi.mock('@/lib/notifications/notification-web-service', () => ({
  getNotificationWebPersistence: vi.fn(() => Promise.resolve(mockWebPersistence)),
}));

describe('notification saved views API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns built-in GitHub and Homelab defaults before custom views', async () => {
    mockWebPersistence.listSavedViews.mockResolvedValueOnce([{
      id: 'custom-1',
      name: 'My queue',
      query: JSON.stringify({ state: 'unread' }),
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    }]);
    const { GET } = await import('@/app/api/notifications/views/route');
    const response = await GET();
    const data = await response.json();

    expect(data.views).toHaveLength(9);
    expect(data.views[0]).toMatchObject({ name: 'Review requests', builtIn: true });
    expect(data.views[7]).toMatchObject({
      id: 'homelab-all',
      name: 'Homelab',
      builtIn: true,
    });
    expect(data.views[8]).toMatchObject({ name: 'My queue', builtIn: false });
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
    expect(mockWebPersistence.createSavedView).toHaveBeenCalledOnce();
  });

  it('reports duplicate view names as a client error', async () => {
    mockWebPersistence.createSavedView.mockRejectedValueOnce(
      new Error('UNIQUE constraint failed: notification_saved_views.name'),
    );
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
    expect(mockWebPersistence.deleteSavedView).not.toHaveBeenCalled();
  });

  it('protects the built-in Homelab view from deletion', async () => {
    const { DELETE } = await import('@/app/api/notifications/views/[id]/route');
    const response = await DELETE(
      new Request('http://localhost/api/notifications/views/homelab-all', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'homelab-all' }) },
    );

    expect(response.status).toBe(400);
    expect(mockWebPersistence.deleteSavedView).not.toHaveBeenCalled();
  });
});
