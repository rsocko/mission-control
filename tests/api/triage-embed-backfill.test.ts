import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const waitForSlot = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/triage', () => ({
  resolveAndStoreEmbed: vi.fn(),
}));
vi.mock('@/lib/triage/domain-rate-limiter', () => ({
  DomainRateLimiter: class {
    waitForSlot = waitForSlot;
  },
}));

describe('triage embed backfill', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let post: typeof import('@/app/api/triage/backfill-embeds/route').POST;
  let resolveAndStoreEmbed: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, routeModule, triageModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/triage/backfill-embeds/route'),
      import('@/lib/triage'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    post = routeModule.POST;
    resolveAndStoreEmbed = vi.mocked(triageModule.resolveAndStoreEmbed);
  }, 30_000);

  beforeEach(async () => {
    await db.delete(schema.triageItems);
    resolveAndStoreEmbed.mockReset().mockResolvedValue({ title: 'Resolved' });
    waitForSlot.mockClear();

    const now = '2026-08-08T12:00:00.000Z';
    await db.insert(schema.triageItems).values([
      item('a-embedded', 'github', now, { embed: { title: 'Existing' } }),
      item('b-missing', 'github', now, {}),
      item('c-other-source', 'reddit', now, {}),
      item('d-missing', 'github', now, {}),
      item('e-missing', 'github', now, {}),
    ]);
    sqlite.prepare('UPDATE triage_items SET raw_metadata = ? WHERE id = ?')
      .run('{malformed', 'd-missing');
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  it('applies eligibility, source filtering, ordering, and limit in SQL', async () => {
    const response = await post(request('?dryRun=true&source=github&limit=2'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dryRun: true,
      scanned: 2,
      selected: 2,
      nextCursor: 'd-missing',
      items: [
        { id: 'b-missing' },
        { id: 'd-missing' },
      ],
    });
  });

  it('supports deterministic force-mode resumption', async () => {
    const response = await post(request('?dryRun=true&force=true&source=github&limit=2&cursor=b-missing'));
    await expect(response.json()).resolves.toMatchObject({
      selected: 2,
      nextCursor: 'e-missing',
      items: [
        { id: 'd-missing' },
        { id: 'e-missing' },
      ],
    });
  });

  it('rejects overlapping remote backfills', async () => {
    let release: ((value: { title: string }) => void) | undefined;
    resolveAndStoreEmbed.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));

    const first = post(request('?limit=1&source=github'));
    await vi.waitFor(() => expect(resolveAndStoreEmbed).toHaveBeenCalledOnce());

    const overlap = await post(request('?limit=1&source=github'));
    expect(overlap.status).toBe(409);

    release?.({ title: 'Resolved' });
    expect((await first).status).toBe(200);
  });
});

function request(query: string): Request {
  return new Request(`http://localhost/api/triage/backfill-embeds${query}`, {
    method: 'POST',
  });
}

function item(
  id: string,
  sourcePlatform: string,
  now: string,
  rawMetadata: Record<string, unknown>,
) {
  return {
    id,
    sourcePlatform,
    sourceId: `source-${id}`,
    sourceUrl: `https://example.com/${id}`,
    title: id,
    capturedAt: now,
    ingestedAt: now,
    rawMetadata,
  };
}
