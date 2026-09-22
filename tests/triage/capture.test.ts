/**
 * Tests for the triage capture domain module (`@/lib/triage/capture`).
 *
 * Covers:
 *  - detectSourcePlatform: pure URL → platform classification
 *  - createTriageCapture: single-URL capture insert + embed/enrichment fire-and-forget
 *  - createTriageTextCapture: iOS share-sheet text capture
 *  - ingestTriageImport: importer/bulk-ingest dedupe semantics
 *
 * Network-touching dependencies (`embed-resolver`, `content-type-registry`)
 * are mocked so tests stay hermetic; `suggestion-engine` (pure rules) and
 * `parse-task-input` run for real.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

const mockResolveEmbed = vi.fn().mockResolvedValue({ success: false });
vi.mock('@/lib/triage/embed-resolver', () => ({
  resolveEmbed: mockResolveEmbed,
}));

const mockDetectContentType = vi.fn().mockResolvedValue('article');
vi.mock('@/lib/triage/content-type-registry', () => ({
  detectContentType: mockDetectContentType,
  detectContentTypeSync: vi.fn(() => 'article'),
}));

let db: typeof import('@/db').default;
let sqlite: typeof import('@/db').sqlite;
let triageItems: typeof import('@/db/schema').triageItems;
let detectSourcePlatform: typeof import('@/lib/triage/capture').detectSourcePlatform;
let createTriageCapture: typeof import('@/lib/triage/capture').createTriageCapture;
let createTriageTextCapture: typeof import('@/lib/triage/capture').createTriageTextCapture;
let ingestTriageImport: typeof import('@/lib/triage/capture').ingestTriageImport;

beforeAll(async () => {
  ({ default: db, sqlite } = await import('@/db'));
  ({ triageItems } = await import('@/db/schema'));
  const { createSqliteTriagePersistenceRepositories } = await import(
    '@/db/persistence/sqlite-triage-repositories'
  );
  const { registerTriagePersistenceRepositories } = await import('@/lib/triage/persistence');
  registerTriagePersistenceRepositories(
    createSqliteTriagePersistenceRepositories(sqlite),
  );
  const { registerSemanticPublicationService } = await import(
    '@/lib/semantic-index/publication-service'
  );
  registerSemanticPublicationService({
    upsert: async () => undefined,
    delete: async () => undefined,
  });
  ({
    detectSourcePlatform,
    createTriageCapture,
    createTriageTextCapture,
    ingestTriageImport,
  } = await import('@/lib/triage/capture'));
});

describe('detectSourcePlatform', () => {
  it.each([
    ['https://www.reddit.com/r/foo/comments/1', 'reddit'],
    ['https://youtu.be/abc123', 'youtube'],
    ['https://www.youtube.com/watch?v=abc123', 'youtube'],
    ['https://www.instagram.com/p/xyz', 'instagram'],
    ['https://www.facebook.com/post/1', 'facebook'],
    ['https://fb.watch/abc', 'facebook'],
    ['https://github.com/owner/repo', 'github'],
    ['https://twitter.com/user/status/1', 'twitter'],
    ['https://x.com/user/status/1', 'twitter'],
    ['https://www.tiktok.com/@user/video/1', 'tiktok'],
    ['https://www.pinterest.com/pin/1', 'pinterest'],
    ['https://pin.it/abc', 'pinterest'],
    ['https://example.com/some-article', 'web'],
  ])('classifies %s as %s', (url, expected) => {
    expect(detectSourcePlatform(url)).toBe(expected);
  });
});

describe('createTriageCapture', () => {
  it('inserts a new triage item derived from the URL and detected platform', async () => {
    const item = await createTriageCapture({
      url: 'https://github.com/octocat/hello-world',
      title: 'Hello World',
      description: 'A demo repo',
    });

    expect(item.sourcePlatform).toBe('github');
    expect(item.title).toBe('Hello World');
    expect(item.status).toBe('pending');
    expect(mockDetectContentType).toHaveBeenCalled();

    const [row] = await db.select().from(triageItems).where(eq(triageItems.id, item.id));
    expect(row).toBeTruthy();
    expect(row.sourceUrl).toBe('https://github.com/octocat/hello-world');
  });

  it('rejects an invalid URL', async () => {
    await expect(createTriageCapture({ url: 'not-a-url' })).rejects.toThrow(/invalid url/i);
  });

  it('derives a fallback title from the hostname when none is provided', async () => {
    const item = await createTriageCapture({ url: 'https://www.example.com/path' });
    expect(item.title).toBe('example.com');
  });
});

describe('createTriageTextCapture', () => {
  it('creates a text_post item from ios_share input', async () => {
    const item = await createTriageTextCapture({
      requestId: 'req-1',
      text: 'Buy milk\nAnd eggs',
    });

    expect(item.sourcePlatform).toBe('ios_share');
    expect(item.contentType).toBe('text_post');
    expect(item.title).toBe('Buy milk');
    expect(item.description).toBe('Buy milk\nAnd eggs');
    expect(item.sourceUrl).toBe('mc://share/req-1');
  });

  it('rejects empty/whitespace-only text', async () => {
    await expect(createTriageTextCapture({ requestId: 'req-2', text: '   ' }))
      .rejects.toThrow(/text is required/i);
  });

  it('uses an explicit title over the derived first line when provided', async () => {
    const item = await createTriageTextCapture({
      requestId: 'req-3',
      text: 'first line\nsecond line',
      title: 'Custom Title',
    });
    expect(item.title).toBe('Custom Title');
  });
});

describe('ingestTriageImport', () => {
  it('imports a new item and reports status=imported', async () => {
    const result = await ingestTriageImport({
      sourcePlatform: 'github',
      sourceId: 'github:import-1',
      sourceUrl: 'https://github.com/octocat/import-1',
      title: 'Imported repo',
    });

    expect(result.status).toBe('imported');
    if (result.status === 'imported') {
      expect(result.item.sourcePlatform).toBe('github');
      expect(result.item.title).toBe('Imported repo');
    }
  });

  it('skips a duplicate sourcePlatform/sourceId pair', async () => {
    const input = {
      sourcePlatform: 'github' as const,
      sourceId: 'github:import-dup',
      sourceUrl: 'https://github.com/octocat/import-dup',
      title: 'Duplicate repo',
    };
    const first = await ingestTriageImport(input);
    const second = await ingestTriageImport(input);

    expect(first.status).toBe('imported');
    expect(second.status).toBe('skipped');
  });
});
