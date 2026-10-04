import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionV2 } from '@/lib/connectors/rymessage/action-contract';
import type {
  CompanionActionFeedPageV2,
  CompanionActionMutationRequestV2,
} from '@/lib/connectors/rymessage/action-contract-v2';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(process.cwd(), 'data', `rymessage-v2-${randomUUID()}.db`);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-rymessage-action-repository'),
]).then(([database, adapter]) => ({
  database,
  repository: adapter.createSqliteRyMessageActionRepository(database.sqlite),
}));

const CONNECTOR_ID = 'rymessage-v2-test';
const NOW = '2026-09-29T20:00:00.000Z';
const FEED_ID = '00000000-0000-4000-8000-000000000001';
const ACTION_ID = '00000000-0000-5000-8000-000000000051';

function action(revision = 1): ActionV2 {
  return {
    contractVersion: 2,
    actionId: ACTION_ID,
    stableKey: `ak1:${'a'.repeat(64)}`,
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: { messageId: 'message-1' },
      sourceKind: 'message',
      sourceFamily: 'bluebubbles',
      senderDisplayName: 'Avery 👩🏽‍💻',
      conversationTitle: '週末の計画',
      messageExcerpt: '確認してください ✅',
    },
    content: {
      title: 'Répondre à Avery — مرحبًا',
      summary: 'Rich Unicode survives persistence',
      actionType: 'follow-up',
      category: 'follow-up',
      priority: 'high',
    },
    classification: {
      confidenceClass: 'high',
      confidenceScore: 0.94,
      reason: 'Direct request',
      derivationMethod: 'ai',
      inputFingerprint: 'b'.repeat(64),
    },
    lifecycle: { state: 'visible' },
    fieldRevisions: { title: revision, lifecycle: revision },
    materializations: [],
  };
}

function page(revision = 1): CompanionActionFeedPageV2 {
  const canonical = action(revision);
  return {
    schemaVersion: '2.0',
    feedId: FEED_ID,
    mode: 'full',
    producedAt: NOW,
    nextCursor: `incremental:${revision}`,
    complete: true,
    items: [{
      eventId: `00000000-0000-4000-8000-${String(revision).padStart(12, '0')}`,
      operationId: `00000000-0000-4000-8001-${String(revision).padStart(12, '0')}`,
      aggregateId: ACTION_ID,
      aggregateVersion: revision,
      sourceId: `rymessage:${FEED_ID}:action:${ACTION_ID}`,
      occurredAt: NOW,
      kind: 'upsert',
      projection: {
        action: canonical,
        taskMaterializations: [],
        creationIntents: [],
        managedTaskCommands: [],
        taskLifecycle: { state: 'none', provenance: 'none' },
      },
    }],
  };
}

describe('SQLite canonical RyMessage ActionV2 repository', () => {
  beforeEach(async () => {
    const { database } = await contextPromise;
    database.sqlite.exec(`
      DELETE FROM rymessage_action_v2_outbound_mutations;
      DELETE FROM rymessage_action_v2_receipts;
      DELETE FROM rymessage_action_v2_projections;
      DELETE FROM rymessage_action_v2_feed_state;
      DELETE FROM connector_configs;
    `);
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings, created_at, updated_at
      ) VALUES (?, 'rymessage', 'RyMessage', 1, '{}', '{}', '{}', ?, ?)
    `).run(CONNECTOR_ID, NOW, NOW);
  });

  it('persists Unicode projections and the terminal incremental cursor exactly', async () => {
    const { repository } = await contextPromise;
    await repository.readV2FeedState(CONNECTOR_ID);
    const canonicalPage = page();
    await expect(repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      page: canonicalPage,
      requestedCursor: null,
      receivedAt: NOW,
    })).resolves.toEqual({ applied: 1, replayed: 0 });

    expect((await repository.readV2FeedState(CONNECTOR_ID)).cursor)
      .toBe(canonicalPage.nextCursor);
    expect(await repository.getV2Projection(CONNECTOR_ID, ACTION_ID))
      .toMatchObject({
        revision: 1,
        item: {
          kind: 'upsert',
          projection: {
            action: {
              source: {
                senderDisplayName: 'Avery 👩🏽‍💻',
                conversationTitle: '週末の計画',
                messageExcerpt: '確認してください ✅',
              },
              content: { title: 'Répondre à Avery — مرحبًا' },
            },
          },
        },
      });
  });

  it('treats identical events as replay and rejects divergent event bytes', async () => {
    const { repository } = await contextPromise;
    await repository.readV2FeedState(CONNECTOR_ID);
    const first = page();
    await repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      page: first,
      requestedCursor: null,
      receivedAt: NOW,
    });
    await expect(repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      page: { ...first, mode: 'incremental', nextCursor: 'incremental:2' },
      requestedCursor: first.nextCursor,
      receivedAt: NOW,
    })).resolves.toEqual({ applied: 0, replayed: 1 });
    await expect(repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      page: {
        ...first,
        mode: 'incremental',
        nextCursor: 'incremental:3',
        items: [{ ...first.items[0]!, occurredAt: '2026-09-29T20:00:01.000Z' }],
      },
      requestedCursor: 'incremental:2',
      receivedAt: NOW,
    })).rejects.toMatchObject({ code: 'EVENT_DIGEST_CONFLICT' });
  });

  it('tombstones rows absent from a completed recovery snapshot', async () => {
    const { repository } = await contextPromise;
    await repository.readV2FeedState(CONNECTOR_ID);
    const first = page();
    await repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      page: first,
      requestedCursor: null,
      receivedAt: NOW,
    });
    await repository.invalidateV2Recovery({
      connectorId: CONNECTOR_ID,
      reason: 'cursor_expired',
      now: NOW,
    });
    await repository.applyV2FeedPage({
      connectorId: CONNECTOR_ID,
      requestedCursor: null,
      receivedAt: '2026-09-29T20:01:00.000Z',
      page: {
        ...first,
        nextCursor: 'incremental:recovered',
        producedAt: '2026-09-29T20:01:00.000Z',
        items: [],
      },
    });
    expect(await repository.getV2Projection(CONNECTOR_ID, ACTION_ID)).toMatchObject({
      item: null,
      tombstonedAt: '2026-09-29T20:01:00.000Z',
    });
    expect((await repository.readV2FeedState(CONNECTOR_ID)).cursor)
      .toBe('incremental:recovered');
  });

  it('enforces operation-id byte identity and resets recovery cursorlessly', async () => {
    const { repository } = await contextPromise;
    const request: CompanionActionMutationRequestV2 = {
      contractVersion: '2.0',
      operationId: '00000000-0000-4000-8000-000000000021',
      actionId: ACTION_ID,
      baseRevision: 1,
      mutation: { kind: 'action.lifecycle', state: 'handled' },
    };
    await expect(repository.enqueueV2Mutation({
      connectorId: CONNECTOR_ID,
      request,
      now: NOW,
    })).resolves.toBe('queued');
    await expect(repository.enqueueV2Mutation({
      connectorId: CONNECTOR_ID,
      request,
      now: NOW,
    })).resolves.toBe('duplicate');
    await expect(repository.enqueueV2Mutation({
      connectorId: CONNECTOR_ID,
      request: {
        ...request,
        mutation: { kind: 'action.lifecycle', state: 'dismissed' },
      },
      now: NOW,
    })).rejects.toMatchObject({ code: 'OPERATION_DIGEST_CONFLICT' });

    await repository.readV2FeedState(CONNECTOR_ID);
    await repository.invalidateV2Recovery({
      connectorId: CONNECTOR_ID,
      reason: 'cursor_expired',
      now: NOW,
    });
    expect(await repository.readV2FeedState(CONNECTOR_ID)).toMatchObject({
      cursor: null,
      recoveryRequired: true,
      recoveryGeneration: 1,
    });
  });
});

afterAll(async () => {
  const { database } = await contextPromise;
  database.sqlite.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (previousPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = previousPath;
});
