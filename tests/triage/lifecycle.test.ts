/**
 * Tests for the triage lifecycle domain module (`@/lib/triage/lifecycle`).
 *
 * Covers:
 *  - hardDeleteTriageItem / hardDeleteTriageItems: deletion + storage cleanup
 *  - purgeDismissedItems: retention-based purge of stale dismissed items
 *  - clearTriageSampleData: removes demo sample rows and resets the seed guard
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

const cleanupTriageItemStorage = vi.fn(async (thumbnailUrl: string | null | undefined) => {
  void thumbnailUrl;
});

vi.mock('@/lib/triage/capture-image-lifecycle', () => ({
  cleanupTriageItemStorage: (thumbnailUrl: string | null | undefined) =>
    cleanupTriageItemStorage(thumbnailUrl),
}));

let db: typeof import('@/db').default;
let triageItems: typeof import('@/db/schema').triageItems;
let hardDeleteTriageItem: typeof import('@/lib/triage/lifecycle').hardDeleteTriageItem;
let hardDeleteTriageItems: typeof import('@/lib/triage/lifecycle').hardDeleteTriageItems;
let purgeDismissedItems: typeof import('@/lib/triage/lifecycle').purgeDismissedItems;
let clearTriageSampleData: typeof import('@/lib/triage/lifecycle').clearTriageSampleData;
let updateTriageItemThumbnail: typeof import('@/lib/triage/lifecycle').updateTriageItemThumbnail;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ triageItems } = await import('@/db/schema'));
  ({
    hardDeleteTriageItem,
    hardDeleteTriageItems,
    purgeDismissedItems,
    clearTriageSampleData,
    updateTriageItemThumbnail,
  } = await import('@/lib/triage/lifecycle'));
});

beforeEach(() => {
  cleanupTriageItemStorage.mockClear();
});

function insertItem(overrides: Partial<typeof triageItems.$inferInsert> & { id: string }) {
  return db.insert(triageItems).values({
    sourcePlatform: 'reddit',
    sourceId: `reddit:${overrides.id}`,
    sourceUrl: `https://example.com/${overrides.id}`,
    title: `Item ${overrides.id}`,
    contentType: 'article',
    capturedAt: '2026-08-07T12:00:00.000Z',
    ingestedAt: '2026-08-07T12:00:00.000Z',
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 50,
    aiUrgency: 'evergreen',
    rawMetadata: {},
    actionsTaken: [],
    ...overrides,
  });
}

describe('updateTriageItemThumbnail', () => {
  it('updates only the thumbnailUrl column', async () => {
    await insertItem({ id: 'lifecycle-thumb' });

    await updateTriageItemThumbnail('lifecycle-thumb', 'https://cdn.example.com/cached.png');

    const [row] = await db.select().from(triageItems).where(eq(triageItems.id, 'lifecycle-thumb'));
    expect(row.thumbnailUrl).toBe('https://cdn.example.com/cached.png');
  });
});

describe('hardDeleteTriageItem', () => {
  it('deletes the row and cleans up its cached storage', async () => {
    await insertItem({ id: 'lifecycle-delete-1', thumbnailUrl: 'https://cdn.example.com/1.png' });

    const deleted = await hardDeleteTriageItem('lifecycle-delete-1');

    expect(deleted).toBe(true);
    expect(cleanupTriageItemStorage).toHaveBeenCalledWith('https://cdn.example.com/1.png');
    const rows = await db.select().from(triageItems).where(eq(triageItems.id, 'lifecycle-delete-1'));
    expect(rows).toHaveLength(0);
  });

  it('returns false for an unknown item without touching storage cleanup', async () => {
    const deleted = await hardDeleteTriageItem('does-not-exist');
    expect(deleted).toBe(false);
    expect(cleanupTriageItemStorage).not.toHaveBeenCalled();
  });
});

describe('hardDeleteTriageItems', () => {
  it('bulk-deletes and cleans up storage for every id', async () => {
    await insertItem({ id: 'lifecycle-bulk-1' });
    await insertItem({ id: 'lifecycle-bulk-2' });

    const count = await hardDeleteTriageItems(['lifecycle-bulk-1', 'lifecycle-bulk-2']);

    expect(count).toBe(2);
    expect(cleanupTriageItemStorage).toHaveBeenCalledTimes(2);
  });

  it('returns 0 and skips work for an empty id list', async () => {
    const count = await hardDeleteTriageItems([]);
    expect(count).toBe(0);
    expect(cleanupTriageItemStorage).not.toHaveBeenCalled();
  });
});

describe('purgeDismissedItems', () => {
  it('only removes dismissed items older than the retention window', async () => {
    await insertItem({
      id: 'lifecycle-purge-stale',
      status: 'dismissed',
      ingestedAt: '2020-01-01T00:00:00.000Z',
    });
    await insertItem({
      id: 'lifecycle-purge-fresh',
      status: 'dismissed',
      ingestedAt: new Date().toISOString(),
    });
    await insertItem({
      id: 'lifecycle-purge-actioned',
      status: 'actioned',
      ingestedAt: '2020-01-01T00:00:00.000Z',
    });

    const purged = await purgeDismissedItems(30);

    expect(purged).toBe(1);
    const remainingIds = (await db.select({ id: triageItems.id }).from(triageItems)).map((r) => r.id);
    expect(remainingIds).toContain('lifecycle-purge-fresh');
    expect(remainingIds).toContain('lifecycle-purge-actioned');
    expect(remainingIds).not.toContain('lifecycle-purge-stale');
  });

  it('returns 0 when nothing is stale', async () => {
    const purged = await purgeDismissedItems(3650);
    expect(purged).toBe(0);
  });
});

describe('clearTriageSampleData', () => {
  it('removes rows matching sample data ids', async () => {
    const { SAMPLE_TRIAGE_ITEMS } = await import('@/lib/triage/seed-data');
    const sample = SAMPLE_TRIAGE_ITEMS[0];
    await insertItem({ id: sample.id });

    const removed = await clearTriageSampleData();

    expect(removed).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(triageItems).where(eq(triageItems.id, sample.id));
    expect(rows).toHaveLength(0);
  });
});
