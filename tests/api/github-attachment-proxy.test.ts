import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getConnector: vi.fn(),
  getTask: vi.fn(),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    ancillary: { getTask: mocks.getTask },
  }),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: async () => ({
    getConnector: mocks.getConnector,
  }),
}));

const ATTACHMENT_URL =
  'https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef';

function request(url = ATTACHMENT_URL) {
  return new Request(
    `http://localhost/api/tasks/task-1/github-attachment?url=${encodeURIComponent(url)}`,
    { headers: { 'Sec-Fetch-Site': 'same-origin' } },
  );
}

async function invoke(url = ATTACHMENT_URL) {
  const { GET } = await import('@/app/api/tasks/[id]/github-attachment/route');
  return GET(request(url), { params: Promise.resolve({ id: 'task-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.getTask.mockResolvedValue({
    id: 'task-1',
    connectorType: 'github-issues',
    connectorInstanceId: 'github-private',
  });
  mocks.getConnector.mockResolvedValue({
    id: 'github-private',
    type: 'github-issues',
    enabled: true,
    deletedAt: null,
    credentials: { token: 'secret-token' },
    settings: {},
  });
});

describe('GET /api/tasks/[id]/github-attachment', () => {
  it('streams an authenticated image with private response headers', async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3',
      },
    }));

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.fetch).toHaveBeenCalledWith(
      ATTACHMENT_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
        cache: 'no-store',
        redirect: 'manual',
      }),
    );
  });

  it('follows an allowlisted signed redirect without forwarding the connector token', async () => {
    const signedUrl =
      'https://private-user-images.githubusercontent.com/123/image.png?jwt=signed-value';
    mocks.fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: signedUrl },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'Content-Type': 'image/png' },
      }));

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      signedUrl,
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
        }),
      }),
    );
    expect([...response.headers.values()].join(' ')).not.toContain(signedUrl);
  });

  it('rejects redirects outside GitHub attachment storage', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'http://localhost/internal' },
    }));

    const response = await invoke();

    expect(response.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('reports an anonymous-style upstream 404 without leaking credentials', async () => {
    mocks.fetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const response = await invoke();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toContain('not found');
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('rejects requests without same-origin browser metadata before reading credentials', async () => {
    const { GET } = await import('@/app/api/tasks/[id]/github-attachment/route');
    const response = await GET(
      new Request(
        `http://localhost/api/tasks/task-1/github-attachment?url=${encodeURIComponent(ATTACHMENT_URL)}`,
        { headers: { 'Sec-Fetch-Site': 'cross-site' } },
      ),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.getTask).not.toHaveBeenCalled();
    expect(mocks.getConnector).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com/image.png',
    'http://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef',
    'https://github.com/user-attachments/assets/not-a-uuid',
    'https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef?next=http://localhost',
  ])('rejects unsupported URLs before making a request: %s', async (url) => {
    const response = await invoke(url);

    expect(response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects successful non-image responses', async () => {
    mocks.fetch.mockResolvedValue(new Response('<html>not an image</html>', {
      headers: { 'Content-Type': 'text/html' },
    }));

    const response = await invoke();

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: 'GitHub attachment response was not an image',
    });
  });

  it('uses only the task connector even when another connector is requested', async () => {
    mocks.getConnector.mockResolvedValue({
      id: 'github-private',
      type: 'github-issues',
      enabled: true,
      deletedAt: null,
      credentials: { pat: 'task-connector-token' },
      settings: {},
    });
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    const { GET } = await import('@/app/api/tasks/[id]/github-attachment/route');
    const response = await GET(
      new Request(
        `http://localhost/api/tasks/task-1/github-attachment`
        + `?connectorId=github-attacker&url=${encodeURIComponent(ATTACHMENT_URL)}`,
        { headers: { 'Sec-Fetch-Site': 'same-origin' } },
      ),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.getConnector).toHaveBeenCalledWith('github-private');
    expect(mocks.getConnector).not.toHaveBeenCalledWith('github-attacker');
    expect(mocks.fetch).toHaveBeenCalledWith(
      ATTACHMENT_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer task-connector-token',
        }),
      }),
    );
  });

  it('returns a clear error when connector credentials are missing', async () => {
    mocks.getConnector.mockResolvedValue({
      id: 'github-private',
      type: 'github-issues',
      enabled: true,
      deletedAt: null,
      credentials: {},
      settings: {},
    });

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'GitHub connector credentials are missing',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses the legacy settings token when canonical credential fields are empty', async () => {
    mocks.getConnector.mockResolvedValue({
      id: 'github-private',
      type: 'github-issues',
      enabled: true,
      deletedAt: null,
      credentials: { token: '  ', pat: '' },
      settings: { token: 'legacy-token' },
    });
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'Content-Type': 'image/png' },
    }));

    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      ATTACHMENT_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-token',
        }),
      }),
    );
  });

  it.each([
    { enabled: false, deletedAt: null },
    { enabled: true, deletedAt: '2026-09-12T12:00:00.000Z' },
  ])('rejects inactive connectors: %o', async ({ enabled, deletedAt }) => {
    mocks.getConnector.mockResolvedValue({
      id: 'github-private',
      type: 'github-issues',
      enabled,
      deletedAt,
      credentials: { token: 'secret-token' },
      settings: {},
    });

    const response = await invoke();

    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects an attachment whose declared size exceeds the limit', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': String(10 * 1024 * 1024 + 1),
      }),
      body: { cancel },
    });

    const response = await invoke();

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
