/**
 * Tests for PR #290 — Scope sidebar tags by selected source generically
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared DB mock ─────────────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: vi.fn((fn: (tx: unknown) => unknown) => {
    const txProxy = new Proxy({}, {
      get() { return vi.fn(() => chainable([])); },
    });
    return fn(txProxy);
  }),
}));

vi.mock('@/db/schema', () => ({
  tags: { id: 'id', name: 'name', slug: 'slug', type: 'type', source: 'source', color: 'color', confirmed: 'confirmed', createdAt: 'created_at' },
  tasks: { id: 'id', connectorType: 'connector_type', connectorInstanceId: 'connector_instance_id', sourceListId: 'source_list_id' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    internal: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
    }),
    badRequest: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'BAD_REQUEST' }, { status: 400 });
    }),
    notFound: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'NOT_FOUND' }, { status: 404 });
    }),
    forbidden: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'FORBIDDEN' }, { status: 403 });
    }),
  },
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  mockDb.select.mockImplementation(() => chainable([]));
});

describe('GET /api/tags — source scoping (PR #290)', () => {
  it('should return tags without source filter (all tags)', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('tags');
    expect(data).toHaveProperty('sourceTagSlugs');
  });

  it('should include per-list usage metadata for exact list filtering', async () => {
    mockDb.select
      .mockImplementationOnce(() => chainable([{
        id: 'tag-bug',
        name: 'bug',
        slug: 'bug',
        type: 'source',
        source: 'github-issues',
        color: '#ff0000',
        confirmed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        unifiedInto: null,
        usageCount: 3,
        sources: 'github-issues',
        sourceNames: 'org/repo',
      }]))
      .mockImplementationOnce(() => chainable([{
        tagId: 'tag-bug',
        connectorType: 'github-issues',
        usageCount: 3,
      }]))
      .mockImplementationOnce(() => chainable([{
        tagId: 'tag-bug',
        connectorInstanceId: 'github-1',
        sourceListId: 'org/repo',
        usageCount: 3,
      }]))
      .mockImplementationOnce(() => chainable([{ slug: 'bug' }]));

    const { GET } = await import('@/app/api/tags/route');
    const response = await GET(new Request(`${BASE}/api/tags?includeListUsage=true`));
    const data = await response.json();

    expect(data.tags[0].listUsage).toEqual([{
      tagId: 'tag-bug',
      connectorInstanceId: 'github-1',
      sourceListId: 'org/repo',
      usageCount: 3,
    }]);
    expect(data.tags[0].sourceUsage).toEqual([{
      tagId: 'tag-bug',
      connectorType: 'github-issues',
      usageCount: 3,
    }]);
  });

  it('should accept source query param for filtering', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?source=github-issues`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept listId query param for per-list scoping', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?source=github-issues&listId=org/repo`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept type filter', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?type=hub`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should combine source and type filters', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?type=source&source=github-issues`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('sourceTagSlugs should always be returned regardless of filters', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?source=microsoft-todo`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('sourceTagSlugs');
    expect(Array.isArray(data.sourceTagSlugs)).toBe(true);
  });
});

describe('POST /api/tags — create hub tag', () => {
  it('should return 400 when name is missing', async () => {
    const { POST } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('name');
  });

  it('should create a tag and return 201', async () => {
    const { POST } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Urgent', color: '#ff0000' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.name).toBe('Urgent');
    expect(data.slug).toBe('urgent');
    expect(data.type).toBe('hub');
  });
});

describe('DELETE /api/tags — delete hub tag', () => {
  it('should return 400 when id is missing', async () => {
    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(400);
  });

  it('should return 404 when tag does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?id=nonexistent`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(404);
  });

  it('should refuse to delete source tags', async () => {
    mockDb.select.mockImplementation(() => chainable([{ id: 'tag-bug', type: 'source', slug: 'bug' }]));

    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?id=tag-bug`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('source');
  });
});
