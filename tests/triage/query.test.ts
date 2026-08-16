/**
 * Tests for the triage query domain module (`@/lib/triage/query`).
 *
 * Covers:
 *  - isValidTriageStatus / isValidTriageSource pure validators
 *  - listTriageItems: filtering, pagination, and stat aggregation
 *  - getTriageItemById: found/not-found paths
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

let db: typeof import('@/db').default;
let triageItems: typeof import('@/db/schema').triageItems;
let listTriageItems: typeof import('@/lib/triage/query').listTriageItems;
let getTriageItemById: typeof import('@/lib/triage/query').getTriageItemById;
let isValidTriageStatus: typeof import('@/lib/triage/query').isValidTriageStatus;
let isValidTriageSource: typeof import('@/lib/triage/query').isValidTriageSource;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ triageItems } = await import('@/db/schema'));
  ({ listTriageItems, getTriageItemById, isValidTriageStatus, isValidTriageSource } = await import('@/lib/triage/query'));

  await db.insert(triageItems).values([
    {
      id: 'query-item-pending',
      sourcePlatform: 'reddit',
      sourceId: 'reddit:query-1',
      sourceUrl: 'https://example.com/query-pending',
      title: 'Pending article',
      contentType: 'article',
      capturedAt: '2026-08-05T12:00:00.000Z',
      ingestedAt: '2026-08-05T12:00:00.000Z',
      status: 'pending',
      aiCategories: ['software-development'],
      aiSuggestedActions: [],
      aiRelevanceScore: 80,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
    {
      id: 'query-item-dismissed',
      sourcePlatform: 'github',
      sourceId: 'github:query-2',
      sourceUrl: 'https://example.com/query-dismissed',
      title: 'Dismissed repo',
      contentType: 'article',
      capturedAt: '2026-08-05T11:00:00.000Z',
      ingestedAt: '2026-08-05T11:00:00.000Z',
      status: 'dismissed',
      aiCategories: [],
      aiSuggestedActions: [],
      aiRelevanceScore: 30,
      aiUrgency: 'evergreen',
      rawMetadata: {},
      actionsTaken: [],
    },
  ]);
});

describe('isValidTriageStatus', () => {
  it('accepts known statuses and "all"', () => {
    expect(isValidTriageStatus('pending')).toBe(true);
    expect(isValidTriageStatus('all')).toBe(true);
    expect(isValidTriageStatus('bogus')).toBe(false);
    expect(isValidTriageStatus(null)).toBe(false);
  });
});

describe('isValidTriageSource', () => {
  it('accepts known sources and rejects unknown ones', () => {
    expect(isValidTriageSource('reddit')).toBe(true);
    expect(isValidTriageSource('document-intelligence')).toBe(true);
    expect(isValidTriageSource('not-a-source')).toBe(false);
    expect(isValidTriageSource(null)).toBe(false);
  });
});

describe('listTriageItems', () => {
  it('filters by status and reports facet stats scoped to the other filters', async () => {
    const result = await listTriageItems({ status: 'pending' });

    expect(result.items.map((item) => item.id)).toContain('query-item-pending');
    expect(result.items.every((item) => item.status === 'pending')).toBe(true);
    expect(result.stats.pending).toBeGreaterThanOrEqual(1);
  });

  it('filters by category using case-insensitive substring match', async () => {
    const result = await listTriageItems({ categories: ['Software'] });

    expect(result.items.map((item) => item.id)).toContain('query-item-pending');
    expect(result.items.map((item) => item.id)).not.toContain('query-item-dismissed');
  });

  it('honors limit/offset for pagination', async () => {
    const result = await listTriageItems({ limit: 1, offset: 0 });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(result.totalFiltered > 1);
  });
});

describe('getTriageItemById', () => {
  it('returns the mapped item when found', async () => {
    const item = await getTriageItemById('query-item-pending');
    expect(item?.id).toBe('query-item-pending');
    expect(item?.title).toBe('Pending article');
  });

  it('returns null when the item does not exist', async () => {
    const item = await getTriageItemById('does-not-exist');
    expect(item).toBeNull();
  });
});
