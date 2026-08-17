import { describe, expect, it, vi } from 'vitest';

const { listTriageItems } = vi.hoisted(() => ({
  listTriageItems: vi.fn(),
}));

vi.mock('@/lib/triage/query', () => ({ listTriageItems }));

import { triageTools } from '@/lib/ai/tools/triage-tools';
import { TRIAGE_SUMMARY_RESOURCE_URI } from '@/lib/triage/summary-contract';

describe('Houston searchTriage tool', () => {
  it('returns the same bounded, sanitized widget contract used by MCP', async () => {
    listTriageItems.mockResolvedValue({
      items: [{
        id: 'triage-1',
        sourcePlatform: 'web',
        sourceId: 'source-1',
        sourceUrl: 'javascript:alert(1)',
        title: 'Saved article',
        thumbnailUrl: 'data:text/html,unsafe',
        contentType: 'article',
        capturedAt: '2026-08-04T12:00:00.000Z',
        ingestedAt: '2026-08-04T12:00:00.000Z',
        status: 'pending',
        aiCategories: [],
        aiSuggestedActions: [],
        aiRelevanceScore: 75,
        aiUrgency: 'evergreen',
        rawMetadata: {},
        actionsTaken: [],
      }],
      totalFiltered: 1,
      hasMore: false,
    });
    const execute = triageTools.searchTriage.execute as unknown as (
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const result = await execute({
      query: 'saved',
      source: 'all',
      status: 'pending',
      sortBy: 'score',
      limit: 10,
    }, {});

    expect(listTriageItems).toHaveBeenCalledWith({
      q: 'saved',
      source: 'all',
      status: 'pending',
      sortBy: 'score',
      limit: 10,
    });
    expect(result).toMatchObject({
      resourceUri: TRIAGE_SUMMARY_RESOURCE_URI,
      total: 1,
      items: [{ title: 'Saved article' }],
    });
    const [item] = result.items as Array<Record<string, unknown>>;
    expect(item).not.toHaveProperty('url');
    expect(item).not.toHaveProperty('thumbnailUrl');
  });
});
