/**
 * X/Twitter Archive Importer Tests
 *
 * Covers:
 *  - parseArchiveJsFile: stripping the `window.YTD.*` assignment prefix
 *  - identifyArchiveFile: matching data/*.js entry paths
 *  - parseArchiveDate: converting archive timestamps to ISO
 *  - extractArchiveUsername: pulling the handle out of data/account.js
 *  - importTwitterArchive: mapping tweet/like entries and ingesting them
 *  - importAllTwitterArchive: sync-state upsert
 *  - API route handler: mode dispatch and error handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRun = vi.fn();

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(),
    })),
    run: mockRun,
  },
}));

vi.mock('@/db/schema', () => ({
  triageSyncState: { id: 'id' },
  triageItems: {
    id: 'id',
    sourcePlatform: 'source_platform',
    sourceId: 'source_id',
    sourceUrl: 'source_url',
    canonicalUrl: 'canonical_url',
  },
}));

vi.mock('@/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

const mockIngest = vi.fn();
vi.mock('@/lib/triage', () => ({
  ingestTriageImport: mockIngest,
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function tweetJsFile(tweets: Array<Record<string, unknown>>) {
  const body = tweets.map((tweet) => ({ tweet }));
  return `window.YTD.tweets.part0 = ${JSON.stringify(body)}`;
}

function likeJsFile(likes: Array<Record<string, unknown>>) {
  const body = likes.map((like) => ({ like }));
  return `window.YTD.like.part0 = ${JSON.stringify(body)}`;
}

function accountJsFile(username: string) {
  return `window.YTD.account.part0 = ${JSON.stringify([{ account: { username } }])}`;
}

// ─── parseArchiveJsFile / identifyArchiveFile / parseArchiveDate ───────────

describe('parseArchiveJsFile', () => {
  let parseArchiveJsFile: typeof import('@/lib/triage/importers/twitter-archive-importer').parseArchiveJsFile;

  beforeEach(async () => {
    const mod = await import('@/lib/triage/importers/twitter-archive-importer');
    parseArchiveJsFile = mod.parseArchiveJsFile;
  });

  it('strips the window.YTD.* assignment prefix and parses JSON', () => {
    const entries = parseArchiveJsFile(likeJsFile([{ tweetId: '1', fullText: 'hi' }]));
    expect(entries).toHaveLength(1);
    expect((entries[0] as { like: { tweetId: string } }).like.tweetId).toBe('1');
  });

  it('returns an empty array for malformed JSON', () => {
    expect(parseArchiveJsFile('window.YTD.like.part0 = { not valid')).toEqual([]);
  });

  it('handles plain JSON without the assignment prefix', () => {
    expect(parseArchiveJsFile('[]')).toEqual([]);
  });
});

describe('identifyArchiveFile', () => {
  let identifyArchiveFile: typeof import('@/lib/triage/importers/twitter-archive-importer').identifyArchiveFile;

  beforeEach(async () => {
    const mod = await import('@/lib/triage/importers/twitter-archive-importer');
    identifyArchiveFile = mod.identifyArchiveFile;
  });

  it('identifies known archive files', () => {
    expect(identifyArchiveFile('data/tweet.js')).toBe('tweet');
    expect(identifyArchiveFile('data/tweets.js')).toBe('tweet');
    expect(identifyArchiveFile('archive/data/like.js')).toBe('like');
    expect(identifyArchiveFile('data/account.js')).toBe('account');
    expect(identifyArchiveFile('data/like-part1.js')).toBe('like');
  });

  it('returns null for unrelated files', () => {
    expect(identifyArchiveFile('data/direct-message.js')).toBeNull();
    expect(identifyArchiveFile('assets/tweet_media/foo.jpg')).toBeNull();
  });
});

describe('parseArchiveDate', () => {
  let parseArchiveDate: typeof import('@/lib/triage/importers/twitter-archive-importer').parseArchiveDate;

  beforeEach(async () => {
    const mod = await import('@/lib/triage/importers/twitter-archive-importer');
    parseArchiveDate = mod.parseArchiveDate;
  });

  it('parses a valid timestamp to ISO', () => {
    expect(parseArchiveDate('2021-01-15T14:35:59.000Z')).toBe('2021-01-15T14:35:59.000Z');
  });

  it('returns undefined for missing or invalid input', () => {
    expect(parseArchiveDate(undefined)).toBeUndefined();
    expect(parseArchiveDate('not a date')).toBeUndefined();
  });
});

// ─── importTwitterArchive ───────────────────────────────────────────────────

describe('importTwitterArchive', () => {
  let importTwitterArchive: typeof import('@/lib/triage/importers/twitter-archive-importer').importTwitterArchive;

  beforeEach(async () => {
    vi.resetModules();
    mockIngest.mockReset();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));

    const mod = await import('@/lib/triage/importers/twitter-archive-importer');
    importTwitterArchive = mod.importTwitterArchive;
  });

  it('imports tweets and likes from archive files', async () => {
    mockIngest.mockResolvedValue({ status: 'imported' });

    const files = [
      { path: 'data/account.js', contents: accountJsFile('octouser') },
      {
        path: 'data/tweet.js',
        contents: tweetJsFile([
          { id_str: '111', full_text: 'Hello world', created_at: '2021-01-15T14:35:59.000Z' },
        ]),
      },
      {
        path: 'data/like.js',
        contents: likeJsFile([
          { tweetId: '222', fullText: 'A tweet I liked', expandedUrl: 'https://twitter.com/other/status/222' },
        ]),
      },
    ];

    const summary = await importTwitterArchive({ files });

    expect(summary.imported).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toHaveLength(0);

    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePlatform: 'twitter',
        sourceId: 'twitter:tweet:111',
        sourceUrl: 'https://twitter.com/octouser/status/111',
        title: 'Hello world',
      }),
    );
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePlatform: 'twitter',
        sourceId: 'twitter:like:222',
        sourceUrl: 'https://twitter.com/other/status/222',
      }),
    );
  });

  it('reports an error when no tweet.js or like.js entries are present', async () => {
    const summary = await importTwitterArchive({ files: [{ path: 'data/account.js', contents: accountJsFile('a') }] });

    expect(summary.errors).toContain('No tweet.js or like.js entries found in archive');
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips tweet/like entries missing required fields', async () => {
    const files = [
      { path: 'data/tweet.js', contents: tweetJsFile([{ id_str: '1' }]) }, // missing full_text
      { path: 'data/like.js', contents: likeJsFile([{ fullText: 'no id' }]) }, // missing tweetId
    ];

    const summary = await importTwitterArchive({ files });

    expect(summary.skipped).toBe(2);
    expect(summary.imported).toBe(0);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('counts ingest results already skipped as duplicates', async () => {
    mockIngest.mockResolvedValue({ status: 'skipped', reason: 'Already ingested' });

    const files = [
      { path: 'data/like.js', contents: likeJsFile([{ tweetId: '5', fullText: 'dup' }]) },
    ];

    const summary = await importTwitterArchive({ files });

    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('records a parse error for malformed archive files', async () => {
    const files = [{ path: 'data/tweet.js', contents: 'window.YTD.tweets.part0 = { broken' }];

    const summary = await importTwitterArchive({ files });

    expect(summary.errors).toContain('Failed to parse archive file: data/tweet.js');
  });

  it('stops between records when the import is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));

    await expect(importTwitterArchive({
      files: [{ path: 'data/like.js', contents: likeJsFile([{ tweetId: '5' }]) }],
      signal: controller.signal,
    })).rejects.toThrow('shutdown');
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

// ─── importAllTwitterArchive ────────────────────────────────────────────────

describe('importAllTwitterArchive', () => {
  let importAllTwitterArchive: typeof import('@/lib/triage/importers/twitter-archive-importer').importAllTwitterArchive;

  beforeEach(async () => {
    vi.resetModules();
    mockIngest.mockReset();
    mockRun.mockReset();
    vi.doMock('@/lib/triage', () => ({ ingestTriageImport: mockIngest }));

    const mod = await import('@/lib/triage/importers/twitter-archive-importer');
    importAllTwitterArchive = mod.importAllTwitterArchive;
  });

  it('upserts sync state after completion', async () => {
    mockIngest.mockResolvedValue({ status: 'imported' });
    const files = [{ path: 'data/like.js', contents: likeJsFile([{ tweetId: '1', fullText: 'hi' }]) }];

    const result = await importAllTwitterArchive({ files });

    expect(result.imported).toBe(1);
    expect(result.pagesProcessed).toBe(1);
    expect(mockRun).toHaveBeenCalled();
  });
});

// ─── API Route ──────────────────────────────────────────────────────────────

describe('POST /api/triage/import/twitter-archive', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return 400 when no file is uploaded', async () => {
    vi.doMock('@/lib/triage/importers', () => ({
      importTwitterArchive: vi.fn(),
      importAllTwitterArchive: vi.fn(),
    }));

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');

    const form = new FormData();
    const req = new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain('Upload a Twitter/X archive ZIP');
  });

  it('rejects an oversized request before parsing multipart data', async () => {
    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
    const req = {
      url: 'http://localhost/api/triage/import/twitter-archive',
      headers: new Headers({
        'content-length': String(130 * 1024 * 1024),
        'content-type': 'multipart/form-data; boundary=test',
      }),
      body: null,
    } as Request;

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'Archive exceeds the 128MB upload limit',
    });
  });

  it('enforces the actual body size when Content-Length is absent or inaccurate', async () => {
    const previous = process.env.MC_TWITTER_ARCHIVE_MAX_REQUEST_BYTES;
    process.env.MC_TWITTER_ARCHIVE_MAX_REQUEST_BYTES = '64';
    try {
      const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(128)]), 'archive.zip');
      const req = new Request('http://localhost/api/triage/import/twitter-archive', {
        method: 'POST',
        headers: { 'content-length': '1' },
        body: form,
      });

      const res = await POST(req);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: 'Archive exceeds the 128MB upload limit',
      });
    } finally {
      if (previous === undefined) delete process.env.MC_TWITTER_ARCHIVE_MAX_REQUEST_BYTES;
      else process.env.MC_TWITTER_ARCHIVE_MAX_REQUEST_BYTES = previous;
    }
  });

  it('should return 400 when the archive has no relevant entries', async () => {
    vi.doMock('@/lib/triage/importers', () => ({
      importTwitterArchive: vi.fn(),
      importAllTwitterArchive: vi.fn(),
    }));

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('data/direct-message.js', Buffer.from('window.YTD.direct_message.part0 = []'));
    const zipBuffer = zip.toBuffer();

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zipBuffer)]), 'archive.zip');
    const req = new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain('No data/tweet.js');
  });

  it('rejects traversal paths before extracting any entry', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    const traversalEntry = zip.addFile('data/like.js', Buffer.from('window.YTD.like.part0 = []'));
    traversalEntry.entryName = '../data/like.js';

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
    const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Archive contains an unsafe entry path' });
  });

  it('rejects an archive entry count above the configured budget', async () => {
    const previous = process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_COUNT;
    process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_COUNT = '1';
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('data/like.js', Buffer.from('window.YTD.like.part0 = []'));
      zip.addFile('data/account.js', Buffer.from('window.YTD.account.part0 = []'));

      const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
      const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
        method: 'POST',
        body: form,
      }));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Archive contains too many entries' });
    } finally {
      if (previous === undefined) delete process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_COUNT;
      else process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_COUNT = previous;
    }
  });

  it('rejects declared expanded sizes before decompression', async () => {
    const previous = process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES;
    process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES = '1';
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('data/like.js', Buffer.from('[]'));

      const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
      const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
        method: 'POST',
        body: form,
      }));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Archive entry exceeds the expanded size limit' });
    } finally {
      if (previous === undefined) delete process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES;
      else process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES = previous;
    }
  });

  it('rejects cumulative expanded data above the configured budget', async () => {
    const previous = process.env.MC_TWITTER_ARCHIVE_MAX_TOTAL_EXPANDED_BYTES;
    process.env.MC_TWITTER_ARCHIVE_MAX_TOTAL_EXPANDED_BYTES = '3';
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('data/like.js', Buffer.from('[]'));
      zip.addFile('data/account.js', Buffer.from('[]'));

      const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
      const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
        method: 'POST',
        body: form,
      }));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Archive expanded data exceeds the total size limit' });
    } finally {
      if (previous === undefined) delete process.env.MC_TWITTER_ARCHIVE_MAX_TOTAL_EXPANDED_BYTES;
      else process.env.MC_TWITTER_ARCHIVE_MAX_TOTAL_EXPANDED_BYTES = previous;
    }
  });

  it('rejects encrypted entries before extraction', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    const entry = zip.addFile('data/like.js', Buffer.from('[]'));
    entry.header.flags |= 0x1;

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
    const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Archive contains an unsupported entry' });
  });

  it('rejects inconsistent stored-entry sizes before extraction', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('data/like.js', Buffer.from('[]'));
    const zipBuffer = zip.toBuffer();
    const centralHeaderOffset = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zipBuffer.writeUInt16LE(0, centralHeaderOffset + 10);
    zipBuffer.writeUInt32LE(1, centralHeaderOffset + 24);

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zipBuffer)]), 'archive.zip');
    const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Archive contains invalid entry metadata' });
  });

  it('rejects highly compressed entries using declared size without inflating them', async () => {
    const previous = process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES;
    process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES = String(1024 * 1024);
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('data/like.js', Buffer.alloc(2 * 1024 * 1024, 0x41));

      const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(zip.toBuffer())]), 'archive.zip');
      const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
        method: 'POST',
        body: form,
      }));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Archive entry exceeds the expanded size limit' });
    } finally {
      if (previous === undefined) delete process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES;
      else process.env.MC_TWITTER_ARCHIVE_MAX_ENTRY_EXPANDED_BYTES = previous;
    }
  });

  it('rejects malformed ZIP data with a stable validation error', async () => {
    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');
    const form = new FormData();
    form.set('file', new Blob([new TextEncoder().encode('not a zip')]), 'archive.zip');
    const res = await POST(new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Uploaded archive is not a valid ZIP file' });
  });

  it('should call importAllTwitterArchive for full mode', async () => {
    const mockFullImport = vi.fn().mockResolvedValue({
      imported: 3,
      skipped: 1,
      pagesProcessed: 1,
      durationMs: 42,
      errors: [],
      lastCursor: null,
    });

    vi.doMock('@/lib/triage/importers', () => ({
      importTwitterArchive: vi.fn(),
      importAllTwitterArchive: mockFullImport,
    }));

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('data/like.js', Buffer.from('window.YTD.like.part0 = []'));
    const zipBuffer = zip.toBuffer();

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zipBuffer)]), 'archive.zip');
    form.set('mode', 'full');
    const req = new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.result.imported).toBe(3);
    expect(data.mode).toBe('full');
    expect(mockFullImport).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: 'data/like.js' })]),
      }),
    );
  });

  it('should call importTwitterArchive for single mode', async () => {
    const mockSingleImport = vi.fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [] });

    vi.doMock('@/lib/triage/importers', () => ({
      importTwitterArchive: mockSingleImport,
      importAllTwitterArchive: vi.fn(),
    }));

    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('data/tweet.js', Buffer.from('window.YTD.tweets.part0 = []'));
    const zipBuffer = zip.toBuffer();

    const { POST } = await import('@/app/api/triage/import/twitter-archive/route');

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(zipBuffer)]), 'archive.zip');
    const req = new Request('http://localhost/api/triage/import/twitter-archive', {
      method: 'POST',
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.summary.imported).toBe(1);
  });
});
