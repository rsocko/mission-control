import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompanionActionFeedPage,
  CompanionActionMaterialization,
  CompanionActionV1,
} from '@/lib/connectors/rymessage/action-contract';
import { RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS } from '@/db/persistence/rymessage-actions';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `rymessage-actions-${randomUUID()}.db`,
);
const backupPath = `${databasePath}.backup`;
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-rymessage-action-repository'),
]).then(([database, adapter]) => ({
  database,
  repository: adapter.createSqliteRyMessageActionRepository(database.sqlite),
}));

const CONNECTOR_ID = 'rymessage-actions-test';
const NOW = '2026-09-29T20:00:00.000Z';
const FEED_ID = '00000000-0000-4000-8000-000000000001';

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function materialization(
  value: number,
  providerListId: string,
  providerTaskId: string,
): CompanionActionMaterialization {
  return {
    materializationId: uuid(value),
    revision: 1,
    provider: 'microsoft-todo',
    providerAccountId: 'opaque-principal-account',
    providerListId,
    providerTaskId,
    state: 'materialized',
    updatedAt: NOW,
  };
}

function action(
  value: number,
  revision = 1,
  materializations: readonly CompanionActionMaterialization[] = [],
  fieldRevisions: Readonly<Record<string, number>> = { title: 1, lifecycle: 1 },
): CompanionActionV1 {
  return {
    contractVersion: 1,
    actionId: uuid(value),
    stableKey: `ak1:${String(value).padStart(64, '0')}`,
    revision,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: { messageId: 'raw-message-identity' },
      sourceKind: 'message',
      sourceFamily: 'm365',
      senderDisplayName: 'Private Sender',
      conversationTitle: 'Private Thread',
      messageExcerpt: 'Private message excerpt',
      sourceUrl: 'https://example.invalid/private-message',
    },
    content: {
      title: `Action ${value}`,
      summary: 'Portable summary',
      actionType: 'follow-up',
      priority: 'high',
    },
    classification: {
      confidenceClass: 'high',
      confidenceScore: 0.94,
      reason: 'Private model reasoning',
      derivationMethod: 'ai',
      model: 'private-model-name',
      derivationVersion: 'v1',
      inputFingerprint: String(value).padStart(64, 'a'),
      extractedPayload: { privateExtract: 'Private extracted payload' },
    },
    lifecycle: {
      state: 'visible',
      feedback: [{ body: 'Private feedback body' }],
    },
    fieldRevisions,
    materializations,
  };
}

function page(input: {
  action?: CompanionActionV1;
  event: number;
  cursor: string;
  mode?: 'full' | 'incremental';
  complete?: boolean;
  tombstoneActionId?: string;
  aggregateVersion?: number;
}): CompanionActionFeedPage {
  const aggregateId = input.action?.actionId ?? input.tombstoneActionId!;
  const aggregateVersion = input.aggregateVersion ?? input.action?.revision ?? 1;
  return {
    schemaVersion: '1.0',
    feedId: FEED_ID,
    mode: input.mode ?? 'full',
    producedAt: NOW,
    nextCursor: input.cursor,
    complete: input.complete ?? true,
    items: input.action
      ? [{
          eventId: uuid(10_000 + input.event),
          operationId: uuid(20_000 + input.event),
          aggregateId,
          aggregateVersion,
          sourceId: `source-${aggregateId}`,
          occurredAt: NOW,
          kind: 'upsert',
          action: input.action,
        }]
      : [{
          eventId: uuid(10_000 + input.event),
          operationId: uuid(20_000 + input.event),
          aggregateId,
          aggregateVersion,
          sourceId: `source-${aggregateId}`,
          occurredAt: NOW,
          kind: 'tombstone',
        }],
  };
}

describe('SQLite RyMessage action repository', () => {
  beforeEach(async () => {
    const { database } = await contextPromise;
    database.sqlite.exec(`
      DELETE FROM rymessage_action_outbound_mutations;
      DELETE FROM rymessage_action_receipts;
      DELETE FROM rymessage_action_materializations;
      DELETE FROM rymessage_action_projections;
      DELETE FROM rymessage_action_feed_state;
      DELETE FROM tasks;
      DELETE FROM connector_configs;
    `);
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings, created_at, updated_at
      ) VALUES (?, 'rymessage', 'RyMessage', 1, '{}', '{}', '{}', ?, ?)
    `).run(CONNECTOR_ID, NOW, NOW);
  });

  it('commits cursor pages atomically and tombstones omissions only after recovery completes', async () => {
    const { repository } = await contextPromise;
    const first = action(1);
    const initial = await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: first, event: 1, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    expect(initial).toMatchObject({ applied: 1, added: 1, updated: 0 });
    expect((await repository.getProjection(CONNECTOR_ID, first.actionId))?.action?.content.title)
      .toBe('Action 1');
    expect((await repository.readFeedState(CONNECTOR_ID)).cursor).toBe('cursor-1');

    await repository.invalidateRecovery({
      connectorId: CONNECTOR_ID,
      reason: 'cursor_expired',
      now: '2026-09-29T20:01:00.000Z',
    });
    const second = action(2);
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: second,
        event: 2,
        cursor: 'cursor-recovery-1',
        complete: false,
      }),
      requestedCursor: null,
      receivedAt: '2026-09-29T20:02:00.000Z',
    });
    expect((await repository.getProjection(CONNECTOR_ID, first.actionId))?.tombstonedAt)
      .toBeNull();

    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: {
        ...page({
          action: second,
          event: 3,
          cursor: 'cursor-recovery-2',
          complete: true,
        }),
        items: [],
      },
      requestedCursor: 'cursor-recovery-1',
      receivedAt: '2026-09-29T20:03:00.000Z',
    });
    expect((await repository.getProjection(CONNECTOR_ID, first.actionId))?.action).toBeNull();
    expect((await repository.getProjection(CONNECTOR_ID, first.actionId))?.tombstonedAt)
      .toBe('2026-09-29T20:03:00.000Z');
    expect((await repository.readFeedState(CONNECTOR_ID)).recoveryRequired).toBe(false);

    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        tombstoneActionId: second.actionId,
        aggregateVersion: 2,
        event: 11,
        cursor: 'cursor-delete',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-recovery-2',
      receivedAt: '2026-09-29T20:04:00.000Z',
    });
    expect((await repository.getProjection(CONNECTOR_ID, second.actionId))?.action).toBeNull();
  });

  it('accepts exact feed replays and rejects event identity reuse with changed content', async () => {
    const { repository } = await contextPromise;
    const original = page({ action: action(3), event: 4, cursor: 'cursor-1' });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: original,
      requestedCursor: null,
      receivedAt: NOW,
    });
    const replay = await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: { ...original, mode: 'incremental', nextCursor: 'cursor-2' },
      requestedCursor: 'cursor-1',
      receivedAt: '2026-09-29T20:01:00.000Z',
    });
    expect(replay).toMatchObject({ applied: 0, ignored: 1 });

    await expect(repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: {
        ...original,
        mode: 'incremental',
        nextCursor: 'cursor-3',
        items: [{
          ...original.items[0]!,
          sourceId: 'changed-source',
        }],
      },
      requestedCursor: 'cursor-2',
      receivedAt: '2026-09-29T20:02:00.000Z',
    })).rejects.toMatchObject({ code: 'EVENT_IDENTITY_CONFLICT' });
    expect((await repository.readFeedState(CONNECTOR_ID)).cursor).toBe('cursor-2');
  });

  it('quarantines same-revision divergent payloads without consuming the cursor', async () => {
    const { repository } = await contextPromise;
    const original = action(31, 1, [], { title: 1 });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: original, event: 31, cursor: 'cursor-safe' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const divergent = {
      ...original,
      content: { ...original.content, title: 'Divergent title' },
    };
    const result = await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: divergent,
        event: 32,
        cursor: 'cursor-must-not-commit',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-safe',
      receivedAt: '2026-09-29T20:01:00.000Z',
    });
    expect(result).toMatchObject({ conflicts: 1, recoveryRequired: true, applied: 0 });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: 'cursor-safe',
      recoveryRequired: true,
      lastError: expect.stringContaining('REVISION_CONFLICT'),
    });
    await expect(repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: action(32),
        event: 33,
        cursor: 'later-cursor',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-safe',
      receivedAt: '2026-09-29T20:02:00.000Z',
    })).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });

    await repository.invalidateRecovery({
      connectorId: CONNECTOR_ID,
      reason: 'operator-reset',
      now: '2026-09-29T20:03:00.000Z',
    });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: null,
      recoveryGeneration: 1,
      recoveryRequired: true,
    });
    await expect(repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: divergent,
        event: 32,
        cursor: 'cursor-resolved',
        mode: 'full',
      }),
      requestedCursor: null,
      receivedAt: '2026-09-29T20:04:00.000Z',
    })).resolves.toMatchObject({ applied: 1, recoveryCompleted: true });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: 'cursor-resolved',
      recoveryRequired: false,
      lastError: null,
    });
    expect((await repository.getProjection(CONNECTOR_ID, original.actionId))?.action?.content.title)
      .toBe('Divergent title');
  });

  it('keeps repeated tombstones bounded to one projection', async () => {
    const { database, repository } = await contextPromise;
    const actionId = uuid(340);
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        tombstoneActionId: actionId,
        aggregateVersion: 1,
        event: 34,
        cursor: 'cursor-1',
      }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        tombstoneActionId: actionId,
        aggregateVersion: 1,
        event: 35,
        cursor: 'cursor-2',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-1',
      receivedAt: '2026-09-29T20:01:00.000Z',
    });
    const count = database.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM rymessage_action_projections
      WHERE connector_id = ? AND action_id = ?
    `).get(CONNECTOR_ID, actionId) as { count: number };
    expect(count.count).toBe(1);
  });

  it('links only exact imported provider tasks and surfaces missing, ambiguous, and broken relations', async () => {
    const { database, repository } = await contextPromise;
    const exact = materialization(101, 'list-exact', 'task-exact');
    const missing = materialization(102, 'list-missing', 'task-missing');
    const ambiguous = materialization(103, 'list-ambiguous', 'task-ambiguous');
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: action(4, 1, [exact, missing, ambiguous]),
        event: 5,
        cursor: 'cursor-1',
      }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const insertTask = database.sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title,
        created_at, updated_at, last_synced_at
      ) VALUES (?, ?, 'microsoft-todo', ?, ?, ?, ?, ?)
    `);
    insertTask.run('local-exact', 'list-exact:task-exact', 'todo-a', 'Exact', NOW, NOW, NOW);
    insertTask.run(
      'local-ambiguous-a',
      'list-ambiguous:task-ambiguous',
      'todo-a',
      'Duplicate A',
      NOW,
      NOW,
      NOW,
    );
    insertTask.run(
      'local-ambiguous-b',
      'list-ambiguous:task-ambiguous',
      'todo-b',
      'Duplicate B',
      NOW,
      NOW,
      NOW,
    );

    const first = await repository.reconcileMaterializations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:01:00.000Z',
    });
    expect(first).toMatchObject({
      linked: 1,
      pendingImport: 1,
      conflicts: 1,
      observationsQueued: 1,
    });
    const taskCount = database.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM tasks',
    ).get() as { count: number };
    expect(taskCount.count).toBe(3);
    expect((await repository.readStatus(CONNECTOR_ID))).toMatchObject({
      linkedCount: 1,
      pendingImportCount: 1,
      conflictCount: 1,
    });

    database.sqlite.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?')
      .run('2026-09-29T20:02:00.000Z', 'local-exact');
    const second = await repository.reconcileMaterializations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:03:00.000Z',
    });
    expect(second.broken).toBe(1);
    expect((await repository.readStatus(CONNECTOR_ID)).feed.connectorId)
      .toBe(CONNECTOR_ID);
  });

  it('rebases non-overlapping edits and surfaces overlapping field conflicts', async () => {
    const { repository } = await contextPromise;
    const initial = action(5, 1, [], { title: 1, details: 1, lifecycle: 1 });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: initial, event: 6, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });

    const operationId = uuid(301);
    await repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: initial.actionId,
      operationId,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Local edit' } },
      now: NOW,
    });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: action(5, 2, [], { title: 1, details: 2, lifecycle: 1 }),
        event: 7,
        cursor: 'cursor-2',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-1',
      receivedAt: '2026-09-29T20:01:00.000Z',
    });
    const lease = await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:02:00.000Z',
    });
    expect(lease.items).toHaveLength(1);
    expect(lease.items[0]).toMatchObject({ operationId, baseRevision: 2 });

    await repository.completeMutation({
      connectorId: CONNECTOR_ID,
      operationId,
      leaseId: lease.leaseId,
      receipt: {
        operationId,
        actionId: initial.actionId,
        outcome: 'applied',
        revision: 3,
      },
      retryable: false,
      now: '2026-09-29T20:03:00.000Z',
    });

    const conflictingOperation = uuid(302);
    await repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: initial.actionId,
      operationId: conflictingOperation,
      baseRevision: 2,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Conflicting edit' } },
      now: '2026-09-29T20:04:00.000Z',
    });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        action: action(5, 3, [], { title: 2, details: 2, lifecycle: 1 }),
        event: 8,
        cursor: 'cursor-3',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-2',
      receivedAt: '2026-09-29T20:05:00.000Z',
    });
    const conflictedLease = await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:06:00.000Z',
    });
    expect(conflictedLease.items).toHaveLength(0);
    expect(await repository.readStatus(CONNECTOR_ID)).toMatchObject({
      conflictCount: 0,
      mutationConflictCount: 1,
    });
    const mutation = (await contextPromise).database.sqlite.prepare(`
      SELECT status, last_error_code AS errorCode
      FROM rymessage_action_outbound_mutations WHERE operation_id = ?
    `).get(conflictingOperation);
    expect(mutation).toEqual({
      status: 'conflict',
      errorCode: 'FIELD_REVISION_CONFLICT',
    });
    await expect(repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: initial.actionId,
      operationId,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Local edit' } },
      now: '2026-09-29T20:07:00.000Z',
    })).resolves.toBe('duplicate');
  });

  it('rejects future aggregate and field revisions while preserving stale non-overlap', async () => {
    const { repository } = await contextPromise;
    const current = action(51, 5, [], { title: 5, details: 2, lifecycle: 4 });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: current, event: 51, cursor: 'cursor-5' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    await expect(repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: current.actionId,
      operationId: uuid(511),
      baseRevision: 999,
      expectedFieldRevisions: { title: 5 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Future aggregate' } },
      now: NOW,
    })).rejects.toMatchObject({ code: 'FUTURE_BASE_REVISION' });
    await expect(repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: current.actionId,
      operationId: uuid(512),
      baseRevision: 5,
      expectedFieldRevisions: { title: 999 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Future field' } },
      now: NOW,
    })).rejects.toMatchObject({ code: 'FUTURE_FIELD_REVISION' });
    await expect(repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: current.actionId,
      operationId: uuid(513),
      baseRevision: 4,
      expectedFieldRevisions: { details: 2 },
      mutation: { kind: 'action.user-edit', patch: { details: 'Safe stale edit' } },
      now: NOW,
    })).resolves.toBe('queued');
  });

  it('defensively rejects a receipt that does not match the leased mutation', async () => {
    const { database, repository } = await contextPromise;
    const current = action(52);
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: current, event: 52, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const operationId = uuid(521);
    await repository.enqueueMutation({
      connectorId: CONNECTOR_ID,
      actionId: current.actionId,
      operationId,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed' } },
      now: NOW,
    });
    const lease = await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:01:00.000Z',
    });
    await repository.completeMutation({
      connectorId: CONNECTOR_ID,
      operationId,
      leaseId: lease.leaseId,
      receipt: {
        operationId: uuid(522),
        actionId: uuid(523),
        outcome: 'applied',
        revision: 2,
      },
      retryable: false,
      now: '2026-09-29T20:02:00.000Z',
    });
    expect(database.sqlite.prepare(`
      SELECT status, last_error_code AS errorCode, receipt
      FROM rymessage_action_outbound_mutations WHERE operation_id = ?
    `).get(operationId)).toEqual({
      status: 'conflict',
      errorCode: 'RECEIPT_IDENTITY_MISMATCH',
      receipt: null,
    });
  });

  it('bounds tombstone projections through explicit recovery without consuming live quota', async () => {
    const { database, repository } = await contextPromise;
    const insert = database.sqlite.prepare(`
      INSERT INTO rymessage_action_projections (
        connector_id, action_id, source_id, revision, payload, payload_digest,
        last_event_id, last_operation_id, tombstoned_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)
    `);
    database.sqlite.transaction(() => {
      for (let index = 0; index < RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS; index++) {
        const id = `retained-tombstone-${String(index).padStart(5, '0')}`;
        insert.run(CONNECTOR_ID, id, id, id, id, id, NOW, NOW, NOW);
      }
    })();

    const live = action(61);
    const liveResult = await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: live, event: 61, cursor: 'cursor-live' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    expect(liveResult).toMatchObject({ added: 1, recoveryRequired: false });

    const overflow = await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({
        tombstoneActionId: uuid(620),
        aggregateVersion: 1,
        event: 62,
        cursor: 'cursor-overflow',
        mode: 'incremental',
      }),
      requestedCursor: 'cursor-live',
      receivedAt: '2026-09-29T20:01:00.000Z',
    });
    expect(overflow).toMatchObject({ tombstoned: 1, recoveryRequired: true });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: null,
      recoveryGeneration: 1,
      lastError: 'TOMBSTONE_RETENTION_RECOVERY',
    });
    const count = database.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM rymessage_action_projections
      WHERE connector_id = ? AND tombstoned_at IS NOT NULL
    `).get(CONNECTOR_ID) as { count: number };
    expect(count.count).toBe(RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS);
    expect((await repository.getProjection(CONNECTOR_ID, live.actionId))?.action).not.toBeNull();

    const recoveryPage = page({
      action: live,
      event: 61,
      cursor: 'cursor-recovered',
    });
    recoveryPage.items.push(page({
      tombstoneActionId: uuid(620),
      aggregateVersion: 1,
      event: 62,
      cursor: 'unused',
    }).items[0]!);
    await expect(repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: recoveryPage,
      requestedCursor: null,
      receivedAt: '2026-09-29T20:02:00.000Z',
    })).resolves.toMatchObject({
      ignored: 2,
      recoveryCompleted: true,
      recoveryRequired: false,
    });
    expect(await repository.getProjection(CONNECTOR_ID, live.actionId))
      .toMatchObject({ action: expect.objectContaining({ actionId: live.actionId }) });
    expect(database.sqlite.prepare(`
      SELECT last_seen_generation AS generation
      FROM rymessage_action_projections
      WHERE connector_id = ? AND action_id = ?
    `).get(CONNECTOR_ID, live.actionId)).toMatchObject({
      generation: expect.any(String),
    });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: 'cursor-recovered',
      recoveryRequired: false,
    });
  });

  it('enforces outbound idempotency and rejects observations for unknown relations', async () => {
    const { repository } = await contextPromise;
    const source = action(8);
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: source, event: 12, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const operationId = uuid(303);
    const command = {
      connectorId: CONNECTOR_ID,
      actionId: source.actionId,
      operationId,
      baseRevision: 1,
      expectedFieldRevisions: { title: 1 },
      mutation: {
        kind: 'action.user-edit' as const,
        patch: { title: 'Stable retry' },
      },
      now: NOW,
    };
    await expect(repository.enqueueMutation(command)).resolves.toBe('queued');
    await expect(repository.enqueueMutation(command)).resolves.toBe('duplicate');
    await expect(repository.enqueueMutation({
      ...command,
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed reuse' } },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(repository.enqueueMutation({
      ...command,
      operationId: uuid(304),
      expectedFieldRevisions: { [`materialization:${uuid(999)}`]: 0 },
      mutation: {
        kind: 'materialization.observe',
        materializationId: uuid(999),
        observedAt: NOW,
      },
    })).rejects.toMatchObject({ code: 'MATERIALIZATION_NOT_FOUND' });
  });

  it('recovers expired leases, backs off retries, and deduplicates observations', async () => {
    const { database, repository } = await contextPromise;
    const relation = materialization(104, 'list-observe', 'task-observe');
    const source = action(6, 1, [relation], {
      lifecycle: 1,
      [`materialization:${relation.materializationId}`]: 0,
    });
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: source, event: 9, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    database.sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        created_at, updated_at, last_synced_at
      ) VALUES (?, ?, 'microsoft-todo', ?, ?, 'done', ?, ?, ?)
    `).run(
      'local-observe',
      'list-observe:task-observe',
      'todo-a',
      'Observed',
      NOW,
      '2026-09-29T20:01:00.000Z',
      NOW,
    );
    const first = await repository.reconcileMaterializations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:02:00.000Z',
    });
    const second = await repository.reconcileMaterializations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:02:01.000Z',
    });
    expect(first.observationsQueued).toBe(1);
    expect(second.observationsQueued).toBe(0);

    const lease = await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:03:00.000Z',
      leaseSeconds: 30,
    });
    expect(lease.items).toHaveLength(1);
    const recovered = await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:03:31.000Z',
    });
    expect(recovered.items[0]?.operationId).toBe(lease.items[0]?.operationId);
    expect(recovered.items[0]?.attemptCount).toBe(2);
    await repository.completeMutation({
      connectorId: CONNECTOR_ID,
      operationId: recovered.items[0]!.operationId,
      leaseId: recovered.leaseId,
      errorCode: 'temporary',
      errorMessage: 'temporary transport failure',
      retryable: true,
      now: '2026-09-29T20:04:00.000Z',
    });
    expect((await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:04:01.000Z',
    })).items).toHaveLength(0);
    expect((await repository.leaseMutations({
      connectorId: CONNECTOR_ID,
      now: '2026-09-29T20:04:04.000Z',
    })).items).toHaveLength(1);
  });

  it('persists only portable fields and erases reconciliation state with the connector', async () => {
    const { database, repository } = await contextPromise;
    const source = action(7);
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: page({ action: source, event: 10, cursor: 'cursor-1' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const payload = database.sqlite.prepare(`
      SELECT payload FROM rymessage_action_projections
      WHERE connector_id = ? AND action_id = ?
    `).get(CONNECTOR_ID, source.actionId) as { payload: string };
    for (const sensitive of [
      'raw-message-identity',
      'Private Sender',
      'Private Thread',
      'Private message excerpt',
      'private-message',
      'Private model reasoning',
      'private-model-name',
      'Private extracted payload',
      'Private feedback body',
    ]) {
      expect(payload.payload).not.toContain(sensitive);
    }

    await database.sqlite.backup(backupPath);
    const backup = new Database(backupPath, { readonly: true });
    const backedUp = backup.prepare(`
      SELECT payload FROM rymessage_action_projections
      WHERE connector_id = ? AND action_id = ?
    `).get(CONNECTOR_ID, source.actionId) as { payload: string };
    expect(backedUp.payload).toBe(payload.payload);
    backup.close();

    database.sqlite.prepare('DELETE FROM connector_configs WHERE id = ?').run(CONNECTOR_ID);
    for (const table of [
      'rymessage_action_feed_state',
      'rymessage_action_projections',
      'rymessage_action_materializations',
      'rymessage_action_receipts',
      'rymessage_action_outbound_mutations',
    ]) {
      const count = database.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE connector_id = ?`,
      ).get(CONNECTOR_ID) as { count: number };
      expect(count.count).toBe(0);
    }
  });
});

afterAll(async () => {
  const { database } = await contextPromise;
  database.sqlite.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(backupPath, { force: true });
  if (previousPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = previousPath;
});
