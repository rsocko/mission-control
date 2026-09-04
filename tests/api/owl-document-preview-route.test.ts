import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const getDocumentPreviewContext = vi.fn();

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  requestContext: { getStore: vi.fn(() => null) },
}));

describe('GET /api/tasks/[id]/document-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    getDocumentPreviewContext.mockResolvedValue({ task: null, connector: null });
    registerFakeTaskCorePersistence({
      taskReads: { getDocumentPreviewContext },
    });
  });

  it('proxies an OWL PDF with the connector API key', async () => {
    getDocumentPreviewContext.mockResolvedValue({
      task: {
        connectorType: 'document-intelligence',
        connectorInstanceId: 'owl-1',
        metadata: { documentId: 42 },
      },
      connector: {
        credentials: { apiKey: 'secret' },
        settings: { baseUrl: 'https://owl.example' },
      },
    });
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
    getDocumentPreviewContext.mockResolvedValue({
      task: {
        connectorType: 'local',
        connectorInstanceId: 'local',
        metadata: { documentId: 42 },
      },
      connector: null,
    });
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
    getDocumentPreviewContext.mockResolvedValue({
      task: {
        connectorType: 'document-intelligence',
        connectorInstanceId: 'owl-1',
        metadata: { documentId: '42' },
      },
      connector: {
        credentials: {},
        settings: { baseUrl: 'https://owl.example' },
      },
    });
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
