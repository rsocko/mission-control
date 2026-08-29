import { beforeEach, describe, expect, it, vi } from 'vitest';

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
};

vi.mock('@/db', () => ({ default: mockDb }));
vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'id',
    connectorType: 'connectorType',
    connectorInstanceId: 'connectorInstanceId',
    metadata: 'metadata',
  },
  connectorConfigs: {
    id: 'id',
    type: 'type',
    enabled: 'enabled',
    deletedAt: 'deletedAt',
    credentials: 'credentials',
    settings: 'settings',
  },
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  requestContext: { getStore: vi.fn(() => null) },
}));

describe('GET /api/tasks/[id]/document-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('proxies an OWL PDF with the connector API key', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{
        connectorType: 'document-intelligence',
        connectorInstanceId: 'owl-1',
        metadata: { documentId: 42 },
      }]))
      .mockReturnValueOnce(chainable([{
        type: 'document-intelligence',
        enabled: true,
        deletedAt: null,
        credentials: { apiKey: 'secret' },
        settings: { baseUrl: 'https://owl.example' },
      }]));
    const fetchMock = vi.fn().mockResolvedValue(new Response('%PDF-1.7', {
      headers: { 'Content-Type': 'application/pdf' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/tasks/[id]/document-preview/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/document-preview'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('inline;');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://owl.example/api/documents/42/download',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'X-API-Key': 'secret',
        }),
      }),
    );
  });

  it('rejects non-OWL tasks without contacting the upstream service', async () => {
    mockDb.select.mockReturnValueOnce(chainable([{
      connectorType: 'local',
      connectorInstanceId: 'local',
      metadata: { documentId: 42 },
    }]));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('@/app/api/tasks/[id]/document-preview/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/document-preview'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-PDF upstream responses', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{
        connectorType: 'document-intelligence',
        connectorInstanceId: 'owl-1',
        metadata: JSON.stringify({ documentId: '42' }),
      }]))
      .mockReturnValueOnce(chainable([{
        type: 'document-intelligence',
        enabled: true,
        deletedAt: null,
        credentials: {},
        settings: { baseUrl: 'https://owl.example' },
      }]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>', {
      headers: { 'Content-Type': 'text/html' },
    })));

    const { GET } = await import('@/app/api/tasks/[id]/document-preview/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/document-preview'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(502);
  });
});
