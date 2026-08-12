import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureScriptPath = path.resolve(process.cwd(), 'clients/browser-extension/content-scripts/capture.js');
const captureScript = fs.readFileSync(captureScriptPath, 'utf8');

function loadCaptureContext(html: string, url: string) {
  const window = new Window({ url });
  window.document.write(html);
  window.document.close();

  const chrome = { runtime: { onMessage: { addListener: vi.fn() } } };
  const context = vm.createContext({
    window,
    document: window.document,
    chrome,
    URL: window.URL,
    console,
    setTimeout,
    clearTimeout,
  });

  vm.runInContext(captureScript, context);
  return context as {
    extractPageMetadata: () => Record<string, unknown>;
  };
}

describe('browser extension content capture', () => {
  it('falls back to rich image capture for unfamiliar sites', () => {
    const context = loadCaptureContext(`
      <html>
        <head>
          <title>Unknown Site</title>
          <meta name="description" content="Fallback description" />
        </head>
        <body>
          <img src="/logo.png" width="48" height="48" alt="site logo" />
          <main>
            <img src="/hero.jpg" width="1200" height="800" alt="main hero" />
            <img src="/detail.jpg" width="900" height="700" alt="detail shot" />
          </main>
        </body>
      </html>
    `, 'https://example.com/articles/test');

    const metadata = context.extractPageMetadata();

    expect(metadata.detectedPlatform).toBeNull();
    expect(metadata.thumbnailUrl).toBe('https://example.com/hero.jpg');
    expect(metadata.platformMeta).toMatchObject({
      thumbnailUrl: 'https://example.com/hero.jpg',
      galleryUrls: [
        'https://example.com/hero.jpg',
        'https://example.com/detail.jpg',
      ],
    });
  });

  it('captures richer reddit metadata including media', () => {
    const context = loadCaptureContext(`
      <html>
        <head>
          <title>Reddit Post</title>
        </head>
        <body>
          <a data-testid="post_author_link" href="/user/tester/">u/tester</a>
          <div data-testid="vote-score">4.2k</div>
          <article>
            <img src="https://i.redd.it/post-image.jpg" width="1200" height="900" alt="post image" />
            <img src="https://i.redd.it/post-image-2.jpg" width="1000" height="800" alt="post image 2" />
          </article>
          <video src="https://v.redd.it/post-video.mp4"></video>
        </body>
      </html>
    `, 'https://www.reddit.com/r/functionalprint/comments/abc123/cool_post/');

    const metadata = context.extractPageMetadata();

    expect(metadata.detectedPlatform).toBe('reddit');
    expect(metadata.platformMeta).toMatchObject({
      subreddit: 'functionalprint',
      subredditNamePrefixed: 'r/functionalprint',
      author: 'tester',
      score: '4.2k',
      thumbnailUrl: 'https://i.redd.it/post-image.jpg',
      redditVideoUrl: 'https://v.redd.it/post-video.mp4',
    });
    expect((metadata.platformMeta as { galleryUrls?: string[] }).galleryUrls).toEqual([
      'https://i.redd.it/post-image.jpg',
      'https://i.redd.it/post-image-2.jpg',
    ]);
  });
});

const insertedRows: Record<string, unknown>[] = [];

const mockSelect = vi.fn();
const mockInsertValues = vi.fn(async (row: Record<string, unknown>) => {
  insertedRows.push(row);
});
const mockResolveEmbed = vi.fn(() => Promise.resolve({ success: false }));

vi.mock('@/db', () => ({
  default: {
    select: mockSelect,
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
  runTransaction: vi.fn(),
}));

vi.mock('@/db/schema', () => ({
  triageItems: { id: 'id', status: 'status', sourcePlatform: 'sourcePlatform', title: 'title', description: 'description', sourceUrl: 'sourceUrl', capturedAt: 'capturedAt', aiRelevanceScore: 'aiRelevanceScore', thumbnailUrl: 'thumbnailUrl', sourceOrder: 'sourceOrder' },
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    default: actual,
    randomUUID: vi.fn(() => 'test-capture-id'),
  };
});

vi.mock('drizzle-orm', () => {
  const sql = () => 'sql';
  return {
    and: vi.fn(),
    asc: vi.fn(),
    desc: vi.fn(),
    eq: vi.fn(() => 'eq'),
    inArray: vi.fn(),
    like: vi.fn(),
    or: vi.fn(),
    sql,
  };
});

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('@/lib/triage/embed-resolver', () => ({
  resolveEmbed: mockResolveEmbed,
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/parse-task-input', () => ({
  parseDateFromText: vi.fn(() => null),
}));

vi.mock('@/lib/triage/actions/karakeep', () => ({
  saveToKarakeep: vi.fn(),
}));

vi.mock('@/lib/triage/actions/ms-todo', () => ({
  createTodoTaskFromTriageItem: vi.fn(),
}));

vi.mock('@/lib/triage/actions/model-catalog', () => ({
  saveToModelCatalog: vi.fn(),
}));

vi.mock('@/lib/triage/actions/knowledge-base', () => ({
  saveToKnowledgeBase: vi.fn(),
  buildKnowledgeBaseActionRecord: vi.fn(),
}));

vi.mock('@/lib/triage/actions/document-intelligence', () => ({
  completeDocumentAction: vi.fn(),
  deferDocumentAction: vi.fn(),
}));

const mockEvaluateRules = vi.fn(() => ({
  summary: 'summary',
  categories: ['reddit'],
  score: 87,
  urgency: 'evergreen' as const,
  actions: [],
}));

vi.mock('@/lib/triage/suggestion-engine', () => ({
  evaluateRules: mockEvaluateRules,
}));

vi.mock('@/lib/triage/importers/youtube-importer', () => ({
  parseDescriptionLinks: vi.fn(() => []),
}));

vi.mock('@/lib/triage/content-type-registry', () => ({
  detectContentType: vi.fn(async () => 'link'),
}));

describe('createTriageCapture', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    mockInsertValues.mockClear();
    mockResolveEmbed.mockClear();
    mockEvaluateRules.mockClear();
    mockSelect.mockImplementation((fields?: unknown) => {
      if (fields) {
        return {
          from: vi.fn().mockResolvedValue([{ count: 1 }]),
        };
      }

      return {
        from: vi.fn(() => ({
          where: vi.fn().mockImplementation(async () => [insertedRows[0]]),
        })),
      };
    });
  });

  it('stores browser extension platform metadata in the same rawMetadata shape used by imports', async () => {
    const { createTriageCapture } = await import('@/lib/triage');

    await createTriageCapture({
      url: 'https://www.reddit.com/r/functionalprint/comments/abc123/cool_post/',
      title: 'Cool post',
      sourcePlatform: 'reddit',
      thumbnailUrl: 'https://i.redd.it/post-image.jpg',
      platformMeta: {
        subreddit: 'functionalprint',
        subredditNamePrefixed: 'r/functionalprint',
        author: 'tester',
        galleryUrls: [
          'https://i.redd.it/post-image.jpg',
          'https://i.redd.it/post-image-2.jpg',
        ],
        redditVideoUrl: 'https://v.redd.it/post-video.mp4',
      },
    });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].rawMetadata).toMatchObject({
      subreddit: 'functionalprint',
      subredditNamePrefixed: 'r/functionalprint',
      author: 'tester',
      galleryUrls: [
        'https://i.redd.it/post-image.jpg',
        'https://i.redd.it/post-image-2.jpg',
      ],
      redditVideoUrl: 'https://v.redd.it/post-video.mp4',
      captureSource: 'reddit',
      platformMeta: {
        subreddit: 'functionalprint',
        subredditNamePrefixed: 'r/functionalprint',
        author: 'tester',
        galleryUrls: [
          'https://i.redd.it/post-image.jpg',
          'https://i.redd.it/post-image-2.jpg',
        ],
        redditVideoUrl: 'https://v.redd.it/post-video.mp4',
      },
    });
    expect(mockEvaluateRules).toHaveBeenCalledWith(expect.objectContaining({
      rawMetadata: expect.objectContaining({
        subreddit: 'functionalprint',
        author: 'tester',
      }),
    }));
  });
});
