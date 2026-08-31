import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

vi.mock('@/lib/mode', () => ({ isDemoMode: () => false }));
vi.mock('@/lib/triage/embed-resolver', () => ({
  resolveEmbed: vi.fn(async () => ({ success: false })),
}));

let db: typeof import('@/db').default;
let sqlite: typeof import('@/db').sqlite;
let triageItems: typeof import('@/db/schema').triageItems;
let ingestTriageImports: typeof import('@/lib/triage').ingestTriageImports;

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
  ({ ingestTriageImports } = await import('@/lib/triage'));
}, 30_000);

describe('batched triage imports', () => {
  it('deduplicates existing and repeated canonical URLs within one batch', async () => {
    const results = await ingestTriageImports([
      {
        sourcePlatform: 'reddit',
        sourceId: 'reddit:first',
        sourceUrl: 'https://example.com/shared',
        title: 'First',
      },
      {
        sourcePlatform: 'facebook',
        sourceId: 'facebook:duplicate',
        sourceUrl: 'https://example.com/shared',
        title: 'Duplicate canonical URL',
      },
      {
        sourcePlatform: 'reddit',
        sourceId: 'reddit:unique',
        sourceUrl: 'https://example.com/unique',
        title: 'Unique',
      },
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'imported',
      'skipped',
      'imported',
    ]);
    expect(results[1]).toMatchObject({
      reason: 'Already ingested for canonical URL',
      item: { sourceId: 'reddit:first' },
    });
    expect(await db.select().from(triageItems)).toHaveLength(2);
  });

  it('returns existing items for source and canonical URL duplicates', async () => {
    const results = await ingestTriageImports([
      {
        sourcePlatform: 'reddit',
        sourceId: 'reddit:first',
        sourceUrl: 'https://example.com/different-url',
        title: 'Duplicate source',
      },
      {
        sourcePlatform: 'instagram',
        sourceId: 'instagram:new',
        sourceUrl: 'https://example.com/unique',
        title: 'Duplicate canonical URL',
      },
    ]);

    expect(results).toMatchObject([
      {
        status: 'skipped',
        reason: 'Already ingested for this source item',
        item: { sourceId: 'reddit:first' },
      },
      {
        status: 'skipped',
        reason: 'Already ingested for canonical URL',
        item: { sourceId: 'reddit:unique' },
      },
    ]);
    expect(await db.select().from(triageItems)).toHaveLength(2);
  });
});
