import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TRIAGE_CAPTURE_BATCH_SIZE,
  type TriageContentTypeUpsertInput,
  type TriagePersistenceRepositories,
} from '@/db/persistence/triage-repositories';
import type { TriageItem } from '@/types';

export interface TriagePersistenceHarness {
  repositories: TriagePersistenceRepositories;
  seedGitHubConnector(input: {
    id?: string;
    token?: string;
    enabled?: boolean;
    deleted?: boolean;
    createdAt?: string;
  }): Promise<void> | void;
  close(): Promise<void> | void;
}

function triageItem(
  suffix: string,
  overrides: Partial<TriageItem> = {},
): TriageItem {
  return {
    id: `triage-${suffix}-${randomUUID()}`,
    sourcePlatform: 'github',
    sourceId: `source-${suffix}-${randomUUID()}`,
    sourceUrl: `https://source.invalid/${suffix}`,
    canonicalUrl: `https://canonical.invalid/${suffix}`,
    title: `Contract item ${suffix}`,
    description: `Description ${suffix}`,
    thumbnailUrl: `https://images.invalid/${suffix}.png`,
    contentType: 'repo',
    capturedAt: '2026-08-29T10:00:00.000Z',
    ingestedAt: '2026-08-29T10:01:00.000Z',
    status: 'snoozed',
    snoozedUntil: '2026-09-01T10:00:00.000Z',
    aiSummary: `Summary ${suffix}`,
    aiCategories: ['software-development', suffix],
    aiSuggestedActions: [{
      actionType: 'create_task_github',
      confidence: 0.9,
      reason: `Reason ${suffix}`,
      label: `Action ${suffix}`,
    }],
    aiRelevanceScore: 87,
    aiUrgency: 'trending',
    rawMetadata: {
      nested: { suffix },
      values: [1, true, null],
    },
    actionsTaken: [{
      id: `action-${suffix}`,
      actionType: 'snooze',
      appliedAt: '2026-08-29T10:02:00.000Z',
      note: `Note ${suffix}`,
      metadata: { duration: 3 },
    }],
    sourceOrder: 7,
    ...overrides,
  };
}

export function describeTriagePersistenceContract(
  name: string,
  createHarness: () => TriagePersistenceHarness | Promise<TriagePersistenceHarness>,
): void {
  describe(`${name} triage persistence contract`, () => {
    let harness: TriagePersistenceHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('returns complete ordered outcomes for imports and in-batch duplicates', async () => {
      const first = triageItem('first');
      const sourceReplay = triageItem('source-replay', {
        sourcePlatform: first.sourcePlatform,
        sourceId: first.sourceId,
      });
      const canonicalDuplicate = triageItem('canonical-duplicate', {
        canonicalUrl: first.canonicalUrl,
      });
      const final = triageItem('final');

      const outcomes = await harness.repositories.capture.captureBatch([
        first,
        sourceReplay,
        canonicalDuplicate,
        final,
      ]);

      expect(outcomes.map(({ status }) => status)).toEqual([
        'imported',
        'skipped',
        'skipped',
        'imported',
      ]);
      expect(outcomes[1]).toMatchObject({
        reason: 'source-replay',
        item: { id: first.id },
      });
      expect(outcomes[2]).toMatchObject({
        reason: 'canonical-duplicate',
        item: { id: first.id },
      });
      expect(outcomes[0]?.item).toEqual(first);
      expect(outcomes[3]?.item).toEqual(final);
    });

    it('deduplicates durable source identities across calls', async () => {
      const original = triageItem('durable');
      await harness.repositories.capture.captureBatch([original]);

      const replay = triageItem('later', {
        sourcePlatform: original.sourcePlatform,
        sourceId: original.sourceId,
      });
      const [outcome] = await harness.repositories.capture.captureBatch([replay]);

      expect(outcome).toEqual({
        status: 'skipped',
        reason: 'source-replay',
        item: original,
      });
    });

    it('enriches imported metadata without replacing an existing thumbnail', async () => {
      const original = triageItem('enrichment', {
        thumbnailUrl: 'https://images.invalid/original.png',
        rawMetadata: { original: true },
      });
      await harness.repositories.capture.captureBatch([original]);

      const enriched = await harness.repositories.capture.enrich(original.id, {
        thumbnailUrl: 'https://images.invalid/replacement.png',
        rawMetadata: { embed: { provider: 'synthetic' } },
      });

      expect(enriched).toMatchObject({
        thumbnailUrl: 'https://images.invalid/original.png',
        rawMetadata: {
          original: true,
          embed: { provider: 'synthetic' },
        },
      });
      await expect(
        harness.repositories.capture.enrich('missing-item', { rawMetadata: {} }),
      ).resolves.toBeNull();
    });

    it('rejects oversized batches before persistence', async () => {
      const items = Array.from(
        { length: MAX_TRIAGE_CAPTURE_BATCH_SIZE + 1 },
        (_, index) => triageItem(`oversized-${index}`),
      );
      await expect(
        harness.repositories.capture.captureBatch(items),
      ).rejects.toThrow(`${MAX_TRIAGE_CAPTURE_BATCH_SIZE}`);
    });

    it('rejects malformed capture and sync data before persistence', async () => {
      await expect(harness.repositories.capture.captureBatch([
        triageItem('malformed', { sourceId: '' }),
      ])).rejects.toThrow('index 0');
      await expect(harness.repositories.syncState.recordRun({
        sourceId: 'malformed-counts',
        expectedRevision: 0,
        cursor: { operation: 'preserve' },
        imported: -1,
        skipped: 0,
        errors: [],
        durationMs: 1,
        syncedAt: '2026-08-29T16:00:00.000Z',
      })).rejects.toThrow('non-negative');
    });

    it('throws database errors without exposing item secrets', async () => {
      const secret = 'synthetic-secret-never-log';
      const original = triageItem('database-error');
      await harness.repositories.capture.captureBatch([original]);
      const rolledBack = triageItem('rolled-back');
      const conflictingId = triageItem('conflicting-id', {
        id: original.id,
        title: secret,
      });

      let thrown: unknown;
      try {
        await harness.repositories.capture.captureBatch([
          rolledBack,
          conflictingId,
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(secret);
      expect(await harness.repositories.capture.captureBatch([rolledBack]))
        .toMatchObject([{ status: 'imported', item: { id: rolledBack.id } }]);
    });

    it('applies sync runs with cumulative counters and exact cursor operations', async () => {
      const sourceId = `sync-${randomUUID()}`;
      const opaqueCursor = 'opaque::cursor/with==padding';
      const missing = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 1,
        cursor: { operation: 'set', value: 'ignored' },
        imported: 1,
        skipped: 1,
        errors: [],
        durationMs: 10,
        syncedAt: '2026-08-29T11:00:00.000Z',
      });
      expect(missing).toEqual({
        status: 'stale',
        currentState: null,
        currentRevision: 0,
      });

      const first = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 0,
        cursor: { operation: 'set', value: opaqueCursor },
        imported: 2,
        skipped: 1,
        errors: ['first warning'],
        durationMs: 20,
        syncedAt: '2026-08-29T12:00:00.000Z',
      });
      expect(first).toMatchObject({
        status: 'applied',
        state: {
          revision: 1,
          lastCursor: opaqueCursor,
          totalImported: 2,
          totalSkipped: 1,
        },
      });

      const second = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 1,
        cursor: { operation: 'preserve' },
        imported: 3,
        skipped: 4,
        errors: ['replacement warning'],
        durationMs: 30,
        syncedAt: '2026-08-29T13:00:00.000Z',
      });
      expect(second).toEqual({
        status: 'applied',
        state: {
          id: sourceId,
          revision: 2,
          lastCursor: opaqueCursor,
          lastSyncedAt: '2026-08-29T13:00:00.000Z',
          totalImported: 5,
          totalSkipped: 5,
          lastRunImported: 3,
          lastRunSkipped: 4,
          lastRunErrors: ['replacement warning'],
          lastRunDurationMs: 30,
        },
      });

      const stale = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 1,
        cursor: { operation: 'set', value: 'must-not-overwrite' },
        imported: 100,
        skipped: 100,
        errors: [],
        durationMs: 40,
        syncedAt: '2026-08-29T14:00:00.000Z',
      });
      expect(stale).toMatchObject({
        status: 'stale',
        currentRevision: 2,
        currentState: {
          revision: 2,
          lastCursor: opaqueCursor,
          totalImported: 5,
          totalSkipped: 5,
        },
      });

      const cleared = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 2,
        cursor: { operation: 'set', value: null },
        imported: 0,
        skipped: 0,
        errors: [],
        durationMs: 50,
        syncedAt: '2026-08-29T15:00:00.000Z',
      });
      expect(cleared).toMatchObject({
        status: 'applied',
        state: {
          revision: 3,
          lastCursor: null,
          totalImported: 5,
          totalSkipped: 5,
        },
      });
      expect(await harness.repositories.syncState.get(sourceId))
        .toEqual(cleared.status === 'applied' ? cleared.state : null);
      expect(await harness.repositories.syncState.getAll())
        .toContainEqual(cleared.status === 'applied' ? cleared.state : null);
    });

    it('allows only one writer to apply a shared expected revision', async () => {
      const sourceId = `cas-${randomUUID()}`;
      const initial = await harness.repositories.syncState.recordRun({
        sourceId,
        expectedRevision: 0,
        cursor: { operation: 'preserve' },
        imported: 0,
        skipped: 0,
        errors: [],
        durationMs: 1,
        syncedAt: '2026-08-29T16:00:00.000Z',
      });
      expect(initial.status).toBe('applied');

      const attempts = await Promise.all([
        harness.repositories.syncState.recordRun({
          sourceId,
          expectedRevision: 1,
          cursor: { operation: 'preserve' },
          imported: 1,
          skipped: 0,
          errors: [],
          durationMs: 2,
          syncedAt: '2026-08-29T16:01:00.000Z',
        }),
        harness.repositories.syncState.recordRun({
          sourceId,
          expectedRevision: 1,
          cursor: { operation: 'preserve' },
          imported: 1,
          skipped: 0,
          errors: [],
          durationMs: 2,
          syncedAt: '2026-08-29T16:01:00.000Z',
        }),
      ]);
      expect(attempts.map(({ status }) => status).sort()).toEqual([
        'applied',
        'stale',
      ]);
      expect((await harness.repositories.syncState.get(sourceId))?.revision)
        .toBe(2);
    });

    it('returns null when no non-deleted GitHub connector has a token', async () => {
      await harness.seedGitHubConnector({
        enabled: false,
      });
      await harness.seedGitHubConnector({
        token: 'synthetic-deleted-token',
        deleted: true,
      });

      expect(
        await harness.repositories.githubCredentialFallback
          .findActiveGitHubToken(),
      ).toBeNull();
    });

    it('reads the first active GitHub connector token', async () => {
      await harness.seedGitHubConnector({
        id: 'second',
        token: 'synthetic-second-token',
        createdAt: '2026-08-29T12:00:00.000Z',
      });
      await harness.seedGitHubConnector({
        id: 'first',
        token: 'synthetic-first-token',
        createdAt: '2026-08-29T11:00:00.000Z',
      });

      expect(
        await harness.repositories.githubCredentialFallback
          .findActiveGitHubToken(),
      ).toBe('synthetic-first-token');
    });

    it('preserves credential fallback from a disabled non-deleted connector', async () => {
      await harness.seedGitHubConnector({
        token: 'synthetic-disabled-token',
        enabled: false,
      });

      expect(
        await harness.repositories.githubCredentialFallback
          .findActiveGitHubToken(),
      ).toBe('synthetic-disabled-token');
    });

    describe('queue item listing', () => {
      it('filters by status and source with cross-filter facets', async () => {
        const pendingGithub = triageItem('pending-github', { status: 'pending', sourcePlatform: 'github' });
        const pendingReddit = triageItem('pending-reddit', { status: 'pending', sourcePlatform: 'reddit' });
        const snoozedGithub = triageItem('snoozed-github', { status: 'snoozed', sourcePlatform: 'github' });
        const snoozedYoutube = triageItem('snoozed-youtube', { status: 'snoozed', sourcePlatform: 'youtube' });
        await harness.repositories.capture.captureBatch([
          pendingGithub, pendingReddit, snoozedGithub, snoozedYoutube,
        ]);

        const result = await harness.repositories.items.list({ status: 'pending' });

        expect(result.items.map((item) => item.id).sort()).toEqual(
          [pendingGithub.id, pendingReddit.id].sort(),
        );
        expect(result.totalFiltered).toBe(2);
        expect(result.hasMore).toBe(false);
        expect(result.stats.total).toBe(4);
        expect(result.stats.pending).toBe(2);
        expect(result.stats.snoozed).toBe(2);
        expect(result.stats.actioned).toBe(0);
        expect(result.stats.dismissed).toBe(0);
        expect(result.stats.sourceCounts).toEqual({ github: 1, reddit: 1 });
      });

      it('matches free-text search case-insensitively across title, description, and source URL', async () => {
        const titleMatch = triageItem('title-match', { title: 'Unique Marker ALPHA' });
        const descriptionMatch = triageItem('description-match', { description: 'contains marker beta text' });
        const urlMatch = triageItem('url-match', { sourceUrl: 'https://source.invalid/marker-gamma' });
        const noMatch = triageItem('no-match', {
          title: 'unrelated',
          description: 'unrelated',
          sourceUrl: 'https://source.invalid/unrelated',
        });
        await harness.repositories.capture.captureBatch([
          titleMatch, descriptionMatch, urlMatch, noMatch,
        ]);

        const alpha = await harness.repositories.items.list({ q: 'alpha' });
        expect(alpha.items.map((item) => item.id)).toEqual([titleMatch.id]);

        const beta = await harness.repositories.items.list({ q: 'MARKER BETA' });
        expect(beta.items.map((item) => item.id)).toEqual([descriptionMatch.id]);

        const gamma = await harness.repositories.items.list({ q: 'marker-gamma' });
        expect(gamma.items.map((item) => item.id)).toEqual([urlMatch.id]);
      });

      it('matches categories as case-insensitive substrings over the JSON category array', async () => {
        const softwareItem = triageItem('software', { aiCategories: ['Software-Development'] });
        const gamingItem = triageItem('gaming', { aiCategories: ['gaming'] });
        await harness.repositories.capture.captureBatch([softwareItem, gamingItem]);

        const result = await harness.repositories.items.list({ categories: ['SOFTWARE'] });
        expect(result.items.map((item) => item.id)).toEqual([softwareItem.id]);
      });

      it('sorts by newest and oldest using capturedAt alone', async () => {
        const older = triageItem('older', { capturedAt: '2026-01-01T00:00:00.000Z', status: 'dismissed' });
        const newer = triageItem('newer', { capturedAt: '2026-06-01T00:00:00.000Z', status: 'pending' });
        await harness.repositories.capture.captureBatch([older, newer]);

        const newest = await harness.repositories.items.list({ sortBy: 'newest' });
        expect(newest.items.map((item) => item.id)).toEqual([newer.id, older.id]);

        const oldest = await harness.repositories.items.list({ sortBy: 'oldest' });
        expect(oldest.items.map((item) => item.id)).toEqual([older.id, newer.id]);
      });

      it('sorts by score within status priority', async () => {
        const lowScore = triageItem('low-score', { status: 'pending', aiRelevanceScore: 10 });
        const highScore = triageItem('high-score', { status: 'pending', aiRelevanceScore: 90 });
        const dismissedHighScore = triageItem('dismissed-high', { status: 'dismissed', aiRelevanceScore: 99 });
        await harness.repositories.capture.captureBatch([lowScore, highScore, dismissedHighScore]);

        const result = await harness.repositories.items.list({ sortBy: 'score' });
        expect(result.items.map((item) => item.id)).toEqual([
          highScore.id,
          lowScore.id,
          dismissedHighScore.id,
        ]);
      });

      it('breaks relevance ties using source order with SQLite NULLS-FIRST semantics', async () => {
        const nullOrder = triageItem('null-order', {
          status: 'pending',
          aiRelevanceScore: 50,
          capturedAt: '2026-03-01T00:00:00.000Z',
          sourceOrder: undefined,
        });
        const withOrder = triageItem('with-order', {
          status: 'pending',
          aiRelevanceScore: 50,
          capturedAt: '2026-03-01T00:00:00.000Z',
          sourceOrder: 5,
        });
        await harness.repositories.capture.captureBatch([withOrder, nullOrder]);

        const result = await harness.repositories.items.list({ sortBy: 'relevance' });
        expect(result.items.map((item) => item.id)).toEqual([nullOrder.id, withOrder.id]);
      });

      it('paginates with limit/offset and reports hasMore', async () => {
        const items = Array.from({ length: 5 }, (_, index) => triageItem(`page-${index}`, {
          capturedAt: `2026-02-0${index + 1}T00:00:00.000Z`,
        }));
        await harness.repositories.capture.captureBatch(items);

        const firstPage = await harness.repositories.items.list({ sortBy: 'newest', limit: 2, offset: 0 });
        expect(firstPage.items.map((item) => item.id)).toEqual([items[4].id, items[3].id]);
        expect(firstPage.hasMore).toBe(true);

        const lastPage = await harness.repositories.items.list({ sortBy: 'newest', limit: 2, offset: 4 });
        expect(lastPage.items.map((item) => item.id)).toEqual([items[0].id]);
        expect(lastPage.hasMore).toBe(false);
      });
    });

    describe('get and seed-if-empty', () => {
      it('returns null for a missing item and the full item when present', async () => {
        expect(await harness.repositories.items.get('missing-item')).toBeNull();

        const captured = triageItem('get-existing');
        await harness.repositories.capture.captureBatch([captured]);
        expect(await harness.repositories.items.get(captured.id)).toEqual(captured);
      });

      it('seeds only when the table is empty, and an empty array never seeds', async () => {
        await harness.repositories.items.seedIfEmpty([]);
        expect((await harness.repositories.items.list({})).stats.total).toBe(0);

        const seedItem = triageItem('seed-first');
        await harness.repositories.items.seedIfEmpty([seedItem]);
        expect(await harness.repositories.items.get(seedItem.id)).toEqual(seedItem);

        const ignoredItem = triageItem('seed-second');
        await harness.repositories.items.seedIfEmpty([ignoredItem]);
        expect(await harness.repositories.items.get(ignoredItem.id)).toBeNull();
        expect((await harness.repositories.items.list({})).stats.total).toBe(1);
      });
    });

    describe('create', () => {
      it('performs a strict insert and reads the persisted item back', async () => {
        const item = triageItem('create-basic');
        const created = await harness.repositories.items.create(item);
        expect(created).toEqual(item);
        expect(await harness.repositories.items.get(item.id)).toEqual(item);
      });

      it('never silently dedupes a source-platform/source-id collision — it throws', async () => {
        const first = triageItem('create-dup-1', {
          sourcePlatform: 'github',
          sourceId: 'dup-source-id',
        });
        await harness.repositories.items.create(first);

        const second = triageItem('create-dup-2', {
          sourcePlatform: 'github',
          sourceId: 'dup-source-id',
        });
        await expect(harness.repositories.items.create(second)).rejects.toThrow();

        // The original row is untouched and the rejected duplicate never landed.
        expect(await harness.repositories.items.get(first.id)).toEqual(first);
        expect(await harness.repositories.items.get(second.id)).toBeNull();
      });
    });

    describe('merge metadata', () => {
      it('shallow-merges a patch into rawMetadata and preserves existing keys', async () => {
        const original = triageItem('merge-basic', {
          rawMetadata: { keep: 'me', nested: { a: 1 } },
        });
        await harness.repositories.capture.captureBatch([original]);

        const merged = await harness.repositories.items.mergeMetadata(original.id, {
          channelName: 'Example Channel',
        });

        expect(merged).toMatchObject({
          rawMetadata: {
            keep: 'me',
            nested: { a: 1 },
            channelName: 'Example Channel',
          },
        });
      });

      it('fills a null thumbnailUrl but never overwrites an existing one', async () => {
        const withoutThumbnail = triageItem('merge-fill-thumb', {
          thumbnailUrl: undefined,
          rawMetadata: {},
        });
        await harness.repositories.capture.captureBatch([withoutThumbnail]);

        const filled = await harness.repositories.items.mergeMetadata(
          withoutThumbnail.id,
          { embed: { provider: 'synthetic' } },
          { fillThumbnailUrl: 'https://images.invalid/filled.png' },
        );
        expect(filled).toMatchObject({ thumbnailUrl: 'https://images.invalid/filled.png' });

        const unchanged = await harness.repositories.items.mergeMetadata(
          withoutThumbnail.id,
          { embed: { provider: 'replacement' } },
          { fillThumbnailUrl: 'https://images.invalid/should-not-apply.png' },
        );
        expect(unchanged).toMatchObject({
          thumbnailUrl: 'https://images.invalid/filled.png',
          rawMetadata: { embed: { provider: 'replacement' } },
        });
      });

      it('skips the entire merge (patch and thumbnail fill) when skipWhenKeyPresent already holds a truthy value', async () => {
        const withChannel = triageItem('merge-skip-present', {
          thumbnailUrl: undefined,
          rawMetadata: { channelName: 'Original Channel', channelUrl: 'https://original.invalid' },
        });
        await harness.repositories.capture.captureBatch([withChannel]);

        const result = await harness.repositories.items.mergeMetadata(
          withChannel.id,
          { channelName: 'New Channel', channelUrl: 'https://new.invalid' },
          { skipWhenKeyPresent: 'channelName', fillThumbnailUrl: 'https://images.invalid/skip.png' },
        );

        expect(result?.thumbnailUrl).toBeUndefined();
        expect(result?.rawMetadata).toEqual({
          channelName: 'Original Channel',
          channelUrl: 'https://original.invalid',
        });
      });

      it('applies the merge normally when skipWhenKeyPresent is absent from rawMetadata', async () => {
        const withoutChannel = triageItem('merge-skip-absent', {
          rawMetadata: { other: true },
        });
        await harness.repositories.capture.captureBatch([withoutChannel]);

        const result = await harness.repositories.items.mergeMetadata(
          withoutChannel.id,
          { channelName: 'Backfilled Channel' },
          { skipWhenKeyPresent: 'channelName' },
        );

        expect(result).toMatchObject({
          rawMetadata: { other: true, channelName: 'Backfilled Channel' },
        });
      });

      it('serializes concurrent metadata merges without losing either patch', async () => {
        const original = triageItem('merge-concurrent', {
          rawMetadata: { original: true },
        });
        await harness.repositories.capture.captureBatch([original]);

        await Promise.all([
          harness.repositories.items.mergeMetadata(original.id, { first: true }),
          harness.repositories.items.mergeMetadata(original.id, { second: true }),
        ]);

        await expect(harness.repositories.items.get(original.id)).resolves.toMatchObject({
          rawMetadata: {
            original: true,
            first: true,
            second: true,
          },
        });
      });

      it('returns null for a missing item', async () => {
        await expect(
          harness.repositories.items.mergeMetadata('missing-item', { channelName: 'x' }),
        ).resolves.toBeNull();
      });
    });

    describe('content type registry', () => {
      function contentTypeUpsert(
        suffix: string,
        overrides: Partial<TriageContentTypeUpsertInput> = {},
      ): TriageContentTypeUpsertInput {
        return {
          id: `content-type-${suffix}-${randomUUID()}`,
          name: `Type ${suffix}`,
          icon: 'icon-name',
          color: '#112233',
          builtin: false,
          suppressed: false,
          priority: 1,
          urlPatterns: [`https://pattern.invalid/${suffix}`],
          keywordHints: [`hint-${suffix}`],
          description: `Description ${suffix}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          ...overrides,
        };
      }

      it('inserts on first upsert and preserves createdAt on subsequent updates', async () => {
        const record = contentTypeUpsert('preserve');
        await harness.repositories.contentTypes.upsert(record);

        const afterInsert = await harness.repositories.contentTypes.list();
        expect(afterInsert).toContainEqual(expect.objectContaining({
          id: record.id,
          name: record.name,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));

        await harness.repositories.contentTypes.upsert({
          ...record,
          name: 'Renamed type',
          createdAt: '2099-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        });

        const afterUpdate = await harness.repositories.contentTypes.list();
        expect(afterUpdate).toContainEqual(expect.objectContaining({
          id: record.id,
          name: 'Renamed type',
          createdAt: record.createdAt,
          updatedAt: '2026-02-01T00:00:00.000Z',
        }));
      });

      it('deletes a content type and reports whether a row was actually removed', async () => {
        const record = contentTypeUpsert('delete-me');
        await harness.repositories.contentTypes.upsert(record);

        expect(await harness.repositories.contentTypes.deleteCustom(record.id)).toBe(true);
        expect(await harness.repositories.contentTypes.deleteCustom(record.id)).toBe(false);
        expect(await harness.repositories.contentTypes.list()).not.toContainEqual(
          expect.objectContaining({ id: record.id }),
        );
      });

      it('suppresses an existing row without touching its other fields', async () => {
        const record = contentTypeUpsert('suppress-existing');
        await harness.repositories.contentTypes.upsert(record);

        await harness.repositories.contentTypes.setSuppressed({
          id: record.id,
          suppressed: true,
          updatedAt: '2026-03-01T00:00:00.000Z',
          builtin: null,
        });

        const rows = await harness.repositories.contentTypes.list();
        expect(rows).toContainEqual(expect.objectContaining({
          id: record.id,
          suppressed: true,
          updatedAt: '2026-03-01T00:00:00.000Z',
          name: record.name,
        }));
      });

      it('inserts a builtin row when suppressing a missing id with builtin defaults, and no-ops without them', async () => {
        const missingId = `content-type-missing-${randomUUID()}`;

        await harness.repositories.contentTypes.setSuppressed({
          id: missingId,
          suppressed: true,
          updatedAt: '2026-04-01T00:00:00.000Z',
          builtin: null,
        });
        expect(await harness.repositories.contentTypes.list()).not.toContainEqual(
          expect.objectContaining({ id: missingId }),
        );

        await harness.repositories.contentTypes.setSuppressed({
          id: missingId,
          suppressed: true,
          updatedAt: '2026-04-01T00:00:00.000Z',
          builtin: {
            name: 'Builtin type',
            icon: null,
            color: '#abcdef',
            priority: 2,
            urlPatterns: ['https://builtin.invalid'],
            keywordHints: ['builtin-hint'],
            description: null,
            createdAt: '2026-04-01T00:00:00.000Z',
          },
        });

        const rows = await harness.repositories.contentTypes.list();
        expect(rows).toContainEqual(expect.objectContaining({
          id: missingId,
          name: 'Builtin type',
          builtin: true,
          suppressed: true,
        }));
      });
    });

    describe('reclassification', () => {
      it('sets a single content type, returning null for a missing item', async () => {
        expect(await harness.repositories.items.setContentType('missing-item', 'video')).toBeNull();

        const item = triageItem('reclassify-single', { contentType: 'link' });
        await harness.repositories.capture.captureBatch([item]);

        const updated = await harness.repositories.items.setContentType(item.id, 'video');
        expect(updated).toMatchObject({ id: item.id, contentType: 'video' });
      });

      it('bulk-sets content types and counts only matched items', async () => {
        const first = triageItem('reclassify-bulk-1', { contentType: 'link' });
        const second = triageItem('reclassify-bulk-2', { contentType: 'link' });
        await harness.repositories.capture.captureBatch([first, second]);

        const count = await harness.repositories.items.setContentTypes(
          [first.id, second.id, 'missing-item'],
          'article',
        );
        expect(count).toBe(2);
        expect((await harness.repositories.items.get(first.id))?.contentType).toBe('article');
        expect((await harness.repositories.items.get(second.id))?.contentType).toBe('article');
      });

      it('lists items for reclassification, scoped by id or in full', async () => {
        const first = triageItem('reclassify-list-1');
        const second = triageItem('reclassify-list-2');
        await harness.repositories.capture.captureBatch([first, second]);

        const scoped = await harness.repositories.items.listForReclassification([first.id]);
        expect(scoped.map((item) => item.id)).toEqual([first.id]);

        const all = await harness.repositories.items.listForReclassification();
        expect(all.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());

        const allViaEmpty = await harness.repositories.items.listForReclassification([]);
        expect(allViaEmpty.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
      });
    });

    describe('source lookups', () => {
      it('finds items by exact source id and source url', async () => {
        const item = triageItem('source-lookup');
        await harness.repositories.capture.captureBatch([item]);

        expect(await harness.repositories.items.findBySourceId(item.sourceId))
          .toEqual(item);
        expect(await harness.repositories.items.findBySourceUrl(item.sourceUrl))
          .toEqual(item);
        expect(await harness.repositories.items.findBySourceId('missing-source-id'))
          .toBeNull();
        expect(await harness.repositories.items.findBySourceUrl('https://source.invalid/missing'))
          .toBeNull();
      });
    });

    describe('queue health snapshots', () => {
      it('returns a raw pending snapshot unfiltered by staleness', async () => {
        const pending = triageItem('health-pending', {
          status: 'pending',
          sourcePlatform: 'github',
          capturedAt: '2026-05-01T00:00:00.000Z',
        });
        const dismissed = triageItem('health-dismissed', { status: 'dismissed' });
        await harness.repositories.capture.captureBatch([pending, dismissed]);

        const snapshot = await harness.repositories.health.getPendingSnapshot();
        expect(snapshot).toEqual([{
          capturedAt: '2026-05-01T00:00:00.000Z',
          sourcePlatform: 'github',
        }]);
      });

      it('computes a digest snapshot for new/actioned counts, queue depth, staleness, and top pending', async () => {
        const staleBefore = '2026-06-01T00:00:00.000Z';
        const periodStart = '2026-06-05T00:00:00.000Z';

        const newGithub = triageItem('digest-new-github', {
          sourcePlatform: 'github',
          status: 'pending',
          ingestedAt: '2026-06-06T00:00:00.000Z',
          capturedAt: '2026-06-06T00:00:00.000Z',
        });
        const newReddit = triageItem('digest-new-reddit', {
          sourcePlatform: 'reddit',
          status: 'pending',
          ingestedAt: '2026-06-07T00:00:00.000Z',
          capturedAt: '2026-06-10T00:00:00.000Z',
        });
        const oldPending = triageItem('digest-old-pending', {
          sourcePlatform: 'reddit',
          status: 'pending',
          ingestedAt: '2026-05-01T00:00:00.000Z',
          capturedAt: '2026-05-01T00:00:00.000Z',
        });
        const actioned = triageItem('digest-actioned', {
          sourcePlatform: 'youtube',
          status: 'actioned',
          ingestedAt: '2026-06-08T00:00:00.000Z',
        });
        const dismissed = triageItem('digest-dismissed', {
          sourcePlatform: 'twitter',
          status: 'dismissed',
          ingestedAt: '2026-06-09T00:00:00.000Z',
        });
        const oldActioned = triageItem('digest-old-actioned', {
          sourcePlatform: 'github',
          status: 'actioned',
          ingestedAt: '2026-01-01T00:00:00.000Z',
        });
        await harness.repositories.capture.captureBatch([
          newGithub, newReddit, oldPending, actioned, dismissed, oldActioned,
        ]);

        const snapshot = await harness.repositories.health.getDigestSnapshot({
          periodStart,
          staleBeforeAt: staleBefore,
          topPendingLimit: 2,
        });

        expect(snapshot.newItemsBySource).toEqual({
          github: 1,
          reddit: 1,
          youtube: 1,
          twitter: 1,
        });
        expect(snapshot.actionedByStatus).toEqual({ actioned: 1, dismissed: 1 });
        expect(snapshot.queueDepth).toBe(3);
        expect(snapshot.staleCount).toBe(1);
        expect(snapshot.topPending.map((entry) => entry.id)).toEqual([
          oldPending.id,
          newGithub.id,
        ]);
        expect(snapshot.topPending[0]).toMatchObject({
          id: oldPending.id,
          title: oldPending.title,
          capturedAt: oldPending.capturedAt,
          aiSuggestedActions: oldPending.aiSuggestedActions,
        });
      });
    });

    describe('embed backfill candidates', () => {
      it('lists items missing an embed, ordered by id, honoring source and force filters plus cursor exclusivity', async () => {
        const runId = randomUUID();
        const withEmbed = triageItem('embed-has', {
          id: `embed-${runId}-2`,
          sourcePlatform: 'reddit',
          rawMetadata: { embed: { provider: 'synthetic' } },
        });
        const missingA = triageItem('embed-missing-a', {
          id: `embed-${runId}-1`,
          sourcePlatform: 'github',
          rawMetadata: {},
        });
        const missingB = triageItem('embed-missing-b', {
          id: `embed-${runId}-3`,
          sourcePlatform: 'github',
          rawMetadata: {},
        });
        await harness.repositories.capture.captureBatch([withEmbed, missingA, missingB]);

        const defaultPage = await harness.repositories.items.listEmbedBackfillCandidates({
          limit: 10,
        });
        expect(defaultPage.items.map((item) => item.id)).toEqual([
          missingA.id,
          missingB.id,
        ]);
        expect(defaultPage.nextCursor).toBeNull();

        const sourceScoped = await harness.repositories.items.listEmbedBackfillCandidates({
          source: 'github',
          limit: 10,
        });
        expect(sourceScoped.items.map((item) => item.id)).toEqual([missingA.id, missingB.id]);

        const forced = await harness.repositories.items.listEmbedBackfillCandidates({
          force: true,
          limit: 10,
        });
        expect(forced.items.map((item) => item.id)).toEqual([
          missingA.id,
          withEmbed.id,
          missingB.id,
        ]);

        const cursored = await harness.repositories.items.listEmbedBackfillCandidates({
          force: true,
          cursor: missingA.id,
          limit: 10,
        });
        expect(cursored.items.map((item) => item.id)).toEqual([withEmbed.id, missingB.id]);
      });

      it('reports nextCursor only when the returned page is exactly full', async () => {
        const runId = randomUUID();
        const first = triageItem('embed-page-1', { id: `embed-page-${runId}-1`, rawMetadata: {} });
        const second = triageItem('embed-page-2', { id: `embed-page-${runId}-2`, rawMetadata: {} });
        await harness.repositories.capture.captureBatch([first, second]);

        const page1 = await harness.repositories.items.listEmbedBackfillCandidates({ limit: 1 });
        expect(page1.items.map((item) => item.id)).toEqual([first.id]);
        expect(page1.nextCursor).toBe(first.id);

        const page2 = await harness.repositories.items.listEmbedBackfillCandidates({
          limit: 1,
          cursor: page1.nextCursor!,
        });
        expect(page2.items.map((item) => item.id)).toEqual([second.id]);
        expect(page2.nextCursor).toBe(second.id);

        const page3 = await harness.repositories.items.listEmbedBackfillCandidates({
          limit: 1,
          cursor: page2.nextCursor!,
        });
        expect(page3.items).toEqual([]);
        expect(page3.nextCursor).toBeNull();
      });
    });

    describe('missing thumbnail candidates and fill-if-null', () => {
      it('lists only items without a thumbnail, optionally scoped by source, and fills once via CAS', async () => {
        const missingGithub = triageItem('thumb-missing-github', {
          sourcePlatform: 'github',
          thumbnailUrl: undefined,
        });
        const missingReddit = triageItem('thumb-missing-reddit', {
          sourcePlatform: 'reddit',
          thumbnailUrl: undefined,
        });
        const hasThumbnail = triageItem('thumb-present', {
          thumbnailUrl: 'https://images.invalid/present.png',
        });
        await harness.repositories.capture.captureBatch([
          missingGithub, missingReddit, hasThumbnail,
        ]);

        const all = await harness.repositories.items.listMissingThumbnailCandidates();
        expect(all.map((candidate) => candidate.id).sort()).toEqual(
          [missingGithub.id, missingReddit.id].sort(),
        );

        const githubOnly = await harness.repositories.items.listMissingThumbnailCandidates({
          source: 'github',
        });
        expect(githubOnly.map((candidate) => candidate.id)).toEqual([missingGithub.id]);

        const filled = await harness.repositories.items.fillThumbnailIfNull(
          missingGithub.id,
          'https://images.invalid/filled.png',
        );
        expect(filled).toBe(true);
        expect((await harness.repositories.items.get(missingGithub.id))?.thumbnailUrl)
          .toBe('https://images.invalid/filled.png');

        const secondAttempt = await harness.repositories.items.fillThumbnailIfNull(
          missingGithub.id,
          'https://images.invalid/should-not-apply.png',
        );
        expect(secondAttempt).toBe(false);
        expect((await harness.repositories.items.get(missingGithub.id))?.thumbnailUrl)
          .toBe('https://images.invalid/filled.png');
      });
    });

    describe('set thumbnail (unconditional overwrite)', () => {
      it('unconditionally replaces an existing thumbnailUrl, unlike fill-only semantics', async () => {
        const item = triageItem('thumb-set-overwrite', {
          thumbnailUrl: 'https://images.invalid/original.png',
        });
        await harness.repositories.capture.captureBatch([item]);

        const applied = await harness.repositories.items.setThumbnail(
          item.id,
          'https://images.invalid/refreshed.png',
        );
        expect(applied).toBe(true);
        expect((await harness.repositories.items.get(item.id))?.thumbnailUrl)
          .toBe('https://images.invalid/refreshed.png');

        // A second call overwrites again — never fill-only, unlike fillThumbnailIfNull.
        const appliedAgain = await harness.repositories.items.setThumbnail(
          item.id,
          'https://images.invalid/refreshed-again.png',
        );
        expect(appliedAgain).toBe(true);
        expect((await harness.repositories.items.get(item.id))?.thumbnailUrl)
          .toBe('https://images.invalid/refreshed-again.png');
      });

      it('also replaces a null thumbnailUrl and returns false for a missing item', async () => {
        const withoutThumbnail = triageItem('thumb-set-from-null', { thumbnailUrl: undefined });
        await harness.repositories.capture.captureBatch([withoutThumbnail]);

        const applied = await harness.repositories.items.setThumbnail(
          withoutThumbnail.id,
          'https://images.invalid/from-null.png',
        );
        expect(applied).toBe(true);
        expect((await harness.repositories.items.get(withoutThumbnail.id))?.thumbnailUrl)
          .toBe('https://images.invalid/from-null.png');

        expect(
          await harness.repositories.items.setThumbnail('missing-item', 'https://images.invalid/x.png'),
        ).toBe(false);
      });
    });

    describe('maintenance and storage', () => {
      it('counts items by status and by source', async () => {
        const items = [
          triageItem('maint-status-1', { status: 'pending', sourcePlatform: 'github' }),
          triageItem('maint-status-2', { status: 'pending', sourcePlatform: 'reddit' }),
          triageItem('maint-status-3', { status: 'dismissed', sourcePlatform: 'github' }),
        ];
        await harness.repositories.capture.captureBatch(items);

        expect(await harness.repositories.maintenance.countByStatus()).toEqual({
          pending: 2,
          dismissed: 1,
        });
        expect(await harness.repositories.maintenance.countBySource()).toEqual({
          github: 2,
          reddit: 1,
        });
      });

      it('counts cached vs external thumbnails and lists cached filenames without duplicates', async () => {
        const cachedA = triageItem('maint-cached-a', {
          thumbnailUrl: '/api/assets/thumbnails/shared.png',
        });
        const cachedB = triageItem('maint-cached-b', {
          thumbnailUrl: '/api/assets/thumbnails/shared.png',
        });
        const captureImage = triageItem('maint-capture-image', {
          thumbnailUrl: '/api/triage/capture/image/capture-1.png',
        });
        const external = triageItem('maint-external', {
          thumbnailUrl: 'https://cdn.invalid/external.png',
        });
        await harness.repositories.capture.captureBatch([
          cachedA, cachedB, captureImage, external,
        ]);

        expect(await harness.repositories.maintenance.countCachedThumbnails()).toBe(2);
        expect(await harness.repositories.maintenance.countExternalThumbnails()).toBe(1);
        expect(await harness.repositories.maintenance.listCachedThumbnailFilenames())
          .toEqual(['shared.png']);
      });

      it('clears external thumbnails while excluding cached and managed capture images', async () => {
        const cached = triageItem('maint-clear-cached', {
          thumbnailUrl: '/api/assets/thumbnails/keep.png',
        });
        const captureImage = triageItem('maint-clear-capture', {
          thumbnailUrl: '/api/triage/capture/image/keep.png',
        });
        const external = triageItem('maint-clear-external', {
          thumbnailUrl: 'https://cdn.invalid/clear-me.png',
        });
        await harness.repositories.capture.captureBatch([cached, captureImage, external]);

        const cleared = await harness.repositories.maintenance.clearExternalThumbnails();
        expect(cleared).toBe(1);
        expect((await harness.repositories.items.get(cached.id))?.thumbnailUrl)
          .toBe('/api/assets/thumbnails/keep.png');
        expect((await harness.repositories.items.get(captureImage.id))?.thumbnailUrl)
          .toBe('/api/triage/capture/image/keep.png');
        expect((await harness.repositories.items.get(external.id))?.thumbnailUrl)
          .toBeUndefined();
      });

      it('counts and purges dismissed items strictly before a cutoff, returning their storage refs', async () => {
        const before = triageItem('maint-purge-before', {
          status: 'dismissed',
          ingestedAt: '2026-01-01T00:00:00.000Z',
          thumbnailUrl: 'https://cdn.invalid/before.png',
        });
        const atCutoff = triageItem('maint-purge-at-cutoff', {
          status: 'dismissed',
          ingestedAt: '2026-02-01T00:00:00.000Z',
        });
        const after = triageItem('maint-purge-after', {
          status: 'dismissed',
          ingestedAt: '2026-03-01T00:00:00.000Z',
        });
        const stillPending = triageItem('maint-purge-pending', {
          status: 'pending',
          ingestedAt: '2026-01-01T00:00:00.000Z',
        });
        await harness.repositories.capture.captureBatch([before, atCutoff, after, stillPending]);

        const cutoff = '2026-02-01T00:00:00.000Z';
        expect(await harness.repositories.maintenance.countDismissedBefore(cutoff)).toBe(1);

        const purged = await harness.repositories.maintenance.purgeDismissedBefore(cutoff);
        expect(purged).toEqual([{
          id: before.id,
          thumbnailUrl: before.thumbnailUrl,
          sourceUrl: before.sourceUrl,
        }]);
        expect(await harness.repositories.items.get(before.id)).toBeNull();
        expect(await harness.repositories.items.get(atCutoff.id)).not.toBeNull();
        expect(await harness.repositories.items.get(after.id)).not.toBeNull();
        expect(await harness.repositories.items.get(stillPending.id)).not.toBeNull();
      });

      it('deletes items by source, toggling whether actioned items are included', async () => {
        const pending = triageItem('maint-delete-pending', {
          status: 'pending',
          sourcePlatform: 'github',
        });
        const dismissed = triageItem('maint-delete-dismissed', {
          status: 'dismissed',
          sourcePlatform: 'github',
        });
        const actioned = triageItem('maint-delete-actioned', {
          status: 'actioned',
          sourcePlatform: 'github',
        });
        const otherSource = triageItem('maint-delete-other', {
          status: 'pending',
          sourcePlatform: 'reddit',
        });
        await harness.repositories.capture.captureBatch([
          pending, dismissed, actioned, otherSource,
        ]);

        const excludingActioned = await harness.repositories.maintenance.deleteBySource({
          source: 'github',
          includeActioned: false,
        });
        expect(excludingActioned.map((row) => row.id).sort()).toEqual(
          [pending.id, dismissed.id].sort(),
        );
        expect(await harness.repositories.items.get(actioned.id)).not.toBeNull();
        expect(await harness.repositories.items.get(otherSource.id)).not.toBeNull();

        const includingActioned = await harness.repositories.maintenance.deleteBySource({
          source: 'github',
          includeActioned: true,
        });
        expect(includingActioned.map((row) => row.id)).toEqual([actioned.id]);
        expect(await harness.repositories.items.get(actioned.id)).toBeNull();
      });

      it('deleteByIds atomically selects storage refs then deletes exactly those ids, and is a no-op for an empty array', async () => {
        expect(await harness.repositories.maintenance.deleteByIds([])).toEqual([]);

        const target1 = triageItem('maint-delete-ids-1');
        const target2 = triageItem('maint-delete-ids-2');
        const untouched = triageItem('maint-delete-ids-untouched');
        await harness.repositories.capture.captureBatch([target1, target2, untouched]);

        const deleted = await harness.repositories.maintenance.deleteByIds([target1.id, target2.id]);
        expect(deleted.map((row) => row.id).sort()).toEqual([target1.id, target2.id].sort());
        expect(deleted).toEqual(expect.arrayContaining([
          { id: target1.id, thumbnailUrl: target1.thumbnailUrl ?? null, sourceUrl: target1.sourceUrl },
          { id: target2.id, thumbnailUrl: target2.thumbnailUrl ?? null, sourceUrl: target2.sourceUrl },
        ]));

        expect(await harness.repositories.items.get(target1.id)).toBeNull();
        expect(await harness.repositories.items.get(target2.id)).toBeNull();
        expect(await harness.repositories.items.get(untouched.id)).not.toBeNull();

        // A second call with the now-deleted ids is a clean no-op — nothing left to select.
        expect(await harness.repositories.maintenance.deleteByIds([target1.id, target2.id])).toEqual([]);
      });
    });
  });
}
