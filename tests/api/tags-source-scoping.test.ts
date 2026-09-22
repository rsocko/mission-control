/**
 * Tests for PR #290 — Scope sidebar tags by selected source generically
 *
 * `/api/tags` no longer reaches for a SQLite handle: it reads the selected
 * task-core runtime's organization repository, so these tests drive the same
 * behaviors through that seam instead of a drizzle chain proxy.
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  TagCreateOutcome,
  TagDeleteOutcome,
  TagOverviewResult,
  TagOverviewRow,
} from '@/lib/tasks/core/contracts';

// ─── Selected task-core runtime double ──────────────────────────────────────

const organization = {
  readTagOverview: vi.fn(
    async (_input: {
      readonly type: string | null;
      readonly source: string | null;
      readonly listId: string | null;
      readonly includeUsageBreakdown: boolean;
    }): Promise<TagOverviewResult> => ({ tags: [], sourceTagSlugs: [] }),
  ),
  createHubTag: vi.fn(
    async (input: {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly color: string;
      readonly createdAt: string;
    }): Promise<TagCreateOutcome> => ({
      kind: 'created',
      tag: {
        id: input.id,
        name: input.name,
        slug: input.slug,
        type: 'hub',
        color: input.color,
      },
    }),
  ),
  deleteHubTag: vi.fn(
    async (_tagId: string): Promise<TagDeleteOutcome> => ({ kind: 'missing' }),
  ),
};

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({ organization }),
}));

vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityUpsert: vi.fn(async () => {}),
  publishSemanticEntityDelete: vi.fn(async () => {}),
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

function overviewRow(overrides: Partial<TagOverviewRow> = {}): TagOverviewRow {
  return {
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
    sources: ['github-issues'],
    sourceNames: ['org/repo'],
    listUsage: [],
    sourceUsage: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  organization.readTagOverview.mockResolvedValue({ tags: [], sourceTagSlugs: [] });
  organization.deleteHubTag.mockResolvedValue({ kind: 'missing' });
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
    expect(organization.readTagOverview).toHaveBeenCalledWith({
      type: null,
      source: null,
      listId: null,
      includeUsageBreakdown: false,
    });
  });

  it('should include per-list usage metadata for exact list filtering', async () => {
    organization.readTagOverview.mockResolvedValue({
      tags: [overviewRow({
        sourceUsage: [{
          tagId: 'tag-bug',
          connectorType: 'github-issues',
          usageCount: 3,
        }],
        listUsage: [{
          tagId: 'tag-bug',
          connectorInstanceId: 'github-1',
          sourceListId: 'org/repo',
          usageCount: 3,
        }],
      })],
      sourceTagSlugs: ['bug'],
    });

    const { GET } = await import('@/app/api/tags/route');
    const response = await GET(new Request(`${BASE}/api/tags?includeListUsage=true`));
    const data = await response.json();

    expect(organization.readTagOverview).toHaveBeenCalledWith(
      expect.objectContaining({ includeUsageBreakdown: true }),
    );
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
    expect(organization.readTagOverview).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'github-issues' }),
    );
  });

  it('should accept listId query param for per-list scoping', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?source=github-issues&listId=org/repo`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(organization.readTagOverview).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'github-issues', listId: 'org/repo' }),
    );
  });

  it('should accept type filter', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?type=hub`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(organization.readTagOverview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hub' }),
    );
  });

  it('should combine source and type filters', async () => {
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?type=source&source=github-issues`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(organization.readTagOverview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'source', source: 'github-issues' }),
    );
  });

  it('sourceTagSlugs should always be returned regardless of filters', async () => {
    organization.readTagOverview.mockResolvedValue({
      tags: [],
      sourceTagSlugs: ['bug', 'chore'],
    });
    const { GET } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?source=microsoft-todo`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('sourceTagSlugs');
    expect(Array.isArray(data.sourceTagSlugs)).toBe(true);
    expect(data.sourceTagSlugs).toEqual(['bug', 'chore']);
  });

  it('should surface a repository failure as 500 rather than an empty list', async () => {
    organization.readTagOverview.mockRejectedValue(new Error('backend down'));
    const { GET } = await import('@/app/api/tags/route');
    const response = await GET(new Request(`${BASE}/api/tags`));
    expect(response.status).toBe(500);
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
    expect(organization.createHubTag).not.toHaveBeenCalled();
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

  it('should resolve a concurrent duplicate to the existing tag with 200', async () => {
    organization.createHubTag.mockResolvedValueOnce({
      kind: 'existing',
      tag: {
        id: 'tag-urgent',
        name: 'Urgent',
        slug: 'urgent',
        type: 'hub',
        color: '#6b7280',
      },
    });
    const { POST } = await import('@/app/api/tags/route');
    const response = await POST(new Request(`${BASE}/api/tags`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Urgent' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'tag-urgent',
      name: 'Urgent',
      slug: 'urgent',
      type: 'hub',
      color: '#6b7280',
    });
  });
});

describe('DELETE /api/tags — delete hub tag', () => {
  it('should return 400 when id is missing', async () => {
    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(400);
    expect(organization.deleteHubTag).not.toHaveBeenCalled();
  });

  it('should return 404 when tag does not exist', async () => {
    organization.deleteHubTag.mockResolvedValue({ kind: 'missing' });

    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?id=nonexistent`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(404);
  });

  it('should refuse to delete source tags', async () => {
    organization.deleteHubTag.mockResolvedValue({ kind: 'source-managed' });

    const { DELETE } = await import('@/app/api/tags/route');
    const request = new Request(`${BASE}/api/tags?id=tag-bug`, { method: 'DELETE' });
    const response = await DELETE(request);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('source');
  });

  it('should delete a hub tag and return success', async () => {
    organization.deleteHubTag.mockResolvedValue({
      kind: 'deleted',
      affectedTaskIds: ['task-1'],
    });

    const { DELETE } = await import('@/app/api/tags/route');
    const response = await DELETE(
      new Request(`${BASE}/api/tags?id=tag-urgent`, { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(organization.deleteHubTag).toHaveBeenCalledWith('tag-urgent');
  });
});
