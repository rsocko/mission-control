/**
 * Tests for the triage classification domain module (`@/lib/triage/classification`).
 *
 * Covers:
 *  - reclassifyTriageItem: re-detects content type and reports whether it changed
 *  - setTriageItemContentType: manual single-item override
 *  - reclassifyTriageItems: batch re-detection with change summary
 *  - setTriageItemsContentType: bulk manual override
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

const detectContentType = vi.fn();

vi.mock('@/lib/triage/content-type-registry', () => ({
  detectContentType: (...args: unknown[]) => detectContentType(...args),
}));

let db: typeof import('@/db').default;
let triageItems: typeof import('@/db/schema').triageItems;
let reclassifyTriageItem: typeof import('@/lib/triage/classification').reclassifyTriageItem;
let setTriageItemContentType: typeof import('@/lib/triage/classification').setTriageItemContentType;
let reclassifyTriageItems: typeof import('@/lib/triage/classification').reclassifyTriageItems;
let setTriageItemsContentType: typeof import('@/lib/triage/classification').setTriageItemsContentType;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ triageItems } = await import('@/db/schema'));
  ({
    reclassifyTriageItem,
    setTriageItemContentType,
    reclassifyTriageItems,
    setTriageItemsContentType,
  } = await import('@/lib/triage/classification'));
});

function insertItem(id: string, contentType = 'article') {
  return db.insert(triageItems).values({
    id,
    sourcePlatform: 'reddit',
    sourceId: `reddit:${id}`,
    sourceUrl: `https://example.com/${id}`,
    title: `Item ${id}`,
    contentType,
    capturedAt: '2026-08-06T12:00:00.000Z',
    ingestedAt: '2026-08-06T12:00:00.000Z',
    status: 'pending',
    aiCategories: [],
    aiSuggestedActions: [],
    aiRelevanceScore: 50,
    aiUrgency: 'evergreen',
    rawMetadata: {},
    actionsTaken: [],
  });
}

describe('reclassifyTriageItem', () => {
  beforeEach(() => {
    detectContentType.mockReset();
  });

  it('updates the content type and reports changed=true when the registry disagrees', async () => {
    await insertItem('classify-changed', 'article');
    detectContentType.mockResolvedValue('video');

    const result = await reclassifyTriageItem('classify-changed');

    expect(result?.changed).toBe(true);
    expect(result?.item.contentType).toBe('video');
    const [row] = await db.select().from(triageItems).where(eq(triageItems.id, 'classify-changed'));
    expect(row.contentType).toBe('video');
  });

  it('leaves the content type untouched and reports changed=false when it matches', async () => {
    await insertItem('classify-unchanged', 'article');
    detectContentType.mockResolvedValue('article');

    const result = await reclassifyTriageItem('classify-unchanged');

    expect(result?.changed).toBe(false);
    expect(result?.item.contentType).toBe('article');
  });

  it('returns null for an unknown item', async () => {
    const result = await reclassifyTriageItem('does-not-exist');
    expect(result).toBeNull();
  });
});

describe('setTriageItemContentType', () => {
  it('applies a manual override', async () => {
    await insertItem('classify-manual', 'article');

    const result = await setTriageItemContentType('classify-manual', 'document');

    expect(result?.contentType).toBe('document');
  });

  it('returns null for an unknown item', async () => {
    const result = await setTriageItemContentType('does-not-exist', 'document');
    expect(result).toBeNull();
  });
});

describe('reclassifyTriageItems', () => {
  it('batches re-detection and only reports items whose type changed', async () => {
    await insertItem('classify-batch-1', 'article');
    await insertItem('classify-batch-2', 'article');
    detectContentType.mockReset();
    detectContentType
      .mockResolvedValueOnce('video')
      .mockResolvedValueOnce('article');

    const result = await reclassifyTriageItems(['classify-batch-1', 'classify-batch-2']);

    expect(result.total).toBe(2);
    expect(result.changed).toBe(1);
    expect(result.results).toEqual([
      expect.objectContaining({ id: 'classify-batch-1', oldType: 'article', newType: 'video' }),
    ]);
  });
});

describe('setTriageItemsContentType', () => {
  it('bulk-overrides content type for the given ids', async () => {
    await insertItem('classify-bulk-1', 'article');
    await insertItem('classify-bulk-2', 'article');

    const changes = await setTriageItemsContentType(['classify-bulk-1', 'classify-bulk-2'], 'document');

    expect(changes).toBe(2);
    const [row1] = await db.select().from(triageItems).where(eq(triageItems.id, 'classify-bulk-1'));
    const [row2] = await db.select().from(triageItems).where(eq(triageItems.id, 'classify-bulk-2'));
    expect(row1.contentType).toBe('document');
    expect(row2.contentType).toBe('document');
  });

  it('returns 0 without touching the database when given an empty id list', async () => {
    const changes = await setTriageItemsContentType([], 'document');
    expect(changes).toBe(0);
  });
});
