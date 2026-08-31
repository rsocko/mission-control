import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TRIAGE_CAPTURE_BATCH_SIZE,
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
  });
}
