import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompanionActionFeedPage,
  CompanionActionMutationReceipt,
  CompanionActionV1,
} from '@/lib/connectors/rymessage/action-contract';
import { companionTaskRelationIdV2 } from '@/lib/connectors/rymessage/action-contract-v2';
import { RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS } from '@/db/persistence/rymessage-actions';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `rymessage-companion-client-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-rymessage-action-repository'),
  import('@/lib/connectors/rymessage/companion-action-client'),
  import('@/lib/connectors/rymessage/companion-action-service'),
]).then(([database, adapter, client, service]) => ({
  database,
  repository: adapter.createSqliteRyMessageActionRepository(database.sqlite),
  client,
  service,
}));

const CONNECTOR_ID = 'rymessage-companion-client-test';
const NOW = '2026-09-29T21:00:00.000Z';
const FEED_ID = '00000000-0000-4000-8000-000000000101';
const RECOVERED_FEED_ID = '00000000-0000-4000-8000-000000000102';

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function emptyPage(overrides: Partial<CompanionActionFeedPage> = {}): CompanionActionFeedPage {
  return {
    schemaVersion: '1.0',
    feedId: FEED_ID,
    mode: 'full',
    producedAt: NOW,
    nextCursor: 'cursor-1',
    complete: true,
    items: [],
    ...overrides,
  };
}

function tombstones(count: number): CompanionActionFeedPage['items'] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: uuid(1_000 + index),
    operationId: uuid(2_000 + index),
    aggregateId: uuid(3_000 + index),
    aggregateVersion: 1,
    sourceId: `source-${index}`,
    occurredAt: NOW,
    kind: 'tombstone' as const,
  }));
}

function companionAction(value: number): CompanionActionV1 {
  return {
    contractVersion: 1,
    actionId: uuid(value),
    stableKey: `ak1:${String(value).padStart(64, '0')}`,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: { kind: 'provider_message', provider: 'microsoft', id: `message-${value}` },
      sourceKind: 'message',
    },
    content: { title: `Action ${value}`, actionType: 'follow-up' },
    classification: {
      derivationMethod: 'deterministic',
      inputFingerprint: String(value).padStart(64, 'a'),
    },
    lifecycle: { state: 'visible' },
    fieldRevisions: { title: 1, lifecycle: 1 },
    materializations: [],
  };
}

describe('Companion ActionV1 HTTP and reconciliation seam', () => {
  it('validates manager task URLs against the exact configured Mission Control origin', async () => {
    const { client } = await contextPromise;
    const actionId = uuid(900);
    const underlying = {
      providerId: 'github',
      providerAccountId: 'installation-1',
      providerTaskId: '1093',
    };
    const relationId = companionTaskRelationIdV2({ actionId, ...underlying });
    const api = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      trustedMissionControlOrigin: 'HTTPS://MISSION-CONTROL.EXAMPLE',
    });
    const request = {
      contractVersion: '2.0' as const,
      operationId: uuid(901),
      actionId,
      expectedRevision: 1,
      mutation: {
        kind: 'materialization.attach-manager' as const,
        relationId,
        underlying,
        snapshot: {
          providerLabel: 'GitHub',
          providerIconKey: 'github',
          title: 'Task',
          status: 'in-progress' as const,
          openUrl: 'https://github.com/rsocko/rymessage/issues/1093',
          observedAt: NOW,
          availability: 'live' as const,
        },
        managerTaskId: 'mc-task',
        managerCanonicalUrl: 'https://mission-control.example/tasks/mc-task',
      },
    };
    expect(api.validateMutationV2(request)).toBe(true);
    expect(api.validateMutationV2({
      ...request,
      mutation: {
        ...request.mutation,
        managerCanonicalUrl: 'https://attacker.example/tasks/mc-task',
      },
    })).toBe(false);
  });

  beforeEach(async () => {
    const { database } = await contextPromise;
    database.sqlite.exec(`
      DELETE FROM rymessage_action_outbound_mutations;
      DELETE FROM rymessage_action_receipts;
      DELETE FROM rymessage_action_materializations;
      DELETE FROM rymessage_action_projections;
      DELETE FROM rymessage_action_feed_state;
      DELETE FROM connector_configs;
    `);
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, capabilities, credentials, settings, created_at, updated_at
      ) VALUES (?, 'rymessage', 'RyMessage', 1, '{}', '{}', '{}', ?, ?)
    `).run(CONNECTOR_ID, NOW, NOW);
  });

  it('uses bearer principal scope, cursor paging, and the bounded feed request', async () => {
    const { client } = await contextPromise;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(emptyPage({
      mode: 'incremental',
      items: tombstones(20),
    })), { status: 200 }));
    const api = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test/',
      credential: 'principal-credential',
      fetchImpl: fetchMock,
    });

    await expect(api.fetchPage('opaque-cursor')).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ kind: 'tombstone' })]),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe('/v1/integrations/action-feed');
    expect(url.searchParams.get('cursor')).toBe('opaque-cursor');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('accountId')).toBe(false);
    expect(url.searchParams.has('providerAccountId')).toBe(false);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer principal-credential',
    );
  });

  it('rejects oversized pages and does not retry principal revocation', async () => {
    const { client } = await contextPromise;
    const oversizedFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(emptyPage({
      items: tombstones(21),
    })), { status: 200 }));
    const oversized = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      fetchImpl: oversizedFetch,
      maxRetries: 0,
    });
    await expect(oversized.fetchPage(null)).rejects.toMatchObject({
      status: 502,
      code: 'contract_invalid',
      retryable: false,
    });

    const revokedFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: 'integration_principal_revoked' },
    }), { status: 401 }));
    const revoked = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'revoked',
      fetchImpl: revokedFetch,
    });
    await expect(revoked.fetchPage(null)).rejects.toMatchObject({
      status: 401,
      code: 'integration_principal_revoked',
      retryable: false,
    });
    expect(revokedFetch).toHaveBeenCalledTimes(1);
  });

  it('retries bounded transient failures and accepts canonical conflict receipts', async () => {
    const { client } = await contextPromise;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'busy' },
      }), {
        status: 429,
        headers: { 'retry-after': '0' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage()), { status: 200 }));
    const api = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      fetchImpl: fetchMock,
      maxRetries: 1,
    });
    await expect(api.fetchPage(null)).resolves.toMatchObject({ complete: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const receipt: CompanionActionMutationReceipt = {
      operationId: uuid(500),
      actionId: uuid(501),
      outcome: 'conflict',
      revision: 4,
      conflictingFields: ['title'],
    };
    const mutationFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(receipt), {
      status: 409,
    }));
    const mutationApi = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      fetchImpl: mutationFetch,
      maxRetries: 0,
    });
    await expect(mutationApi.submitMutation({
      contractVersion: '1.0',
      operationId: receipt.operationId,
      actionId: receipt.actionId,
      baseRevision: 3,
      mutation: { kind: 'action.user-edit', patch: { title: 'Changed title' } },
    })).resolves.toEqual(receipt);
    const [, init] = mutationFetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('accountId');
  });

  it.each([200, 409])(
    'rejects unrelated mutation receipts returned with HTTP %s',
    async (status) => {
      const { client } = await contextPromise;
      const requestOperationId = uuid(510 + status);
      const requestActionId = uuid(520 + status);
      const api = client.createCompanionActionClient({
        baseUrl: 'https://companion.example.test',
        credential: 'principal-credential',
        fetchImpl: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
          operationId: uuid(530 + status),
          actionId: uuid(540 + status),
          outcome: status === 409 ? 'conflict' : 'applied',
          revision: 2,
        }), { status })),
        maxRetries: 0,
      });
      await expect(api.submitMutation({
        contractVersion: '1.0',
        operationId: requestOperationId,
        actionId: requestActionId,
        baseRevision: 1,
        mutation: { kind: 'action.user-edit', patch: { title: 'Changed title' } },
      })).rejects.toMatchObject({
        status: 502,
        code: 'receipt_identity_mismatch',
        retryable: false,
      });
    },
  );

  it('reports unavailable without fetching while revision recovery is quarantined', async () => {
    const {
      database,
      repository,
      service: { CompanionActionReconciliationService },
    } = await contextPromise;
    database.sqlite.prepare(`
      INSERT INTO rymessage_action_feed_state (
        connector_id, feed_id, cursor, recovery_generation, recovery_required,
        last_error, created_at, updated_at
      ) VALUES (?, ?, 'blocked-cursor', 0, 1, 'REVISION_CONFLICT:test', ?, ?)
    `).run(CONNECTOR_ID, FEED_ID, NOW, NOW);
    const client = {
      fetchPage: vi.fn(),
      fetchPageV2: vi.fn(),
      validateMutationV2: vi.fn(() => true),
      submitMutation: vi.fn(),
      submitMutationV2: vi.fn(),
    };
    const reconciliation = new CompanionActionReconciliationService(
      CONNECTOR_ID,
      client,
      async () => repository,
    );
    await expect(reconciliation.sync()).resolves.toMatchObject({
      status: 'unavailable',
      relations: { conflicts: 1 },
    });
    expect(client.fetchPage).not.toHaveBeenCalled();
  });

  it('invalidates expired cursor generations and restarts from a full snapshot once', async () => {
    const {
      client,
      repository,
      service: { CompanionActionReconciliationService },
    } = await contextPromise;
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: emptyPage({ nextCursor: 'expired-cursor' }),
      requestedCursor: null,
      receivedAt: NOW,
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'cursor_expired' },
      }), { status: 410 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage({
        feedId: RECOVERED_FEED_ID,
        nextCursor: 'recovered-cursor',
      })), { status: 200 }));
    const api = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      fetchImpl: fetchMock,
      maxRetries: 0,
    });
    const reconciliation = new CompanionActionReconciliationService(
      CONNECTOR_ID,
      api,
      async () => repository,
    );
    await expect(reconciliation.sync()).resolves.toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsRemoved: 0,
      status: 'fresh',
    });
    const state = await repository.readFeedState(CONNECTOR_ID);
    expect(state).toMatchObject({
      feedId: RECOVERED_FEED_ID,
      cursor: 'recovered-cursor',
      recoveryGeneration: 1,
      recoveryRequired: false,
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('cursor=expired-cursor');
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain('cursor=');
  });

  it('preserves receipted live actions through tombstone-retention recovery', async () => {
    const {
      database,
      repository,
      service: { CompanionActionReconciliationService },
    } = await contextPromise;
    const insert = database.sqlite.prepare(`
      INSERT INTO rymessage_action_projections (
        connector_id, action_id, source_id, revision, payload, payload_digest,
        last_event_id, last_operation_id, tombstoned_at, created_at, updated_at
      ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)
    `);
    database.sqlite.transaction(() => {
      for (
        let index = 0;
        index < RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS;
        index++
      ) {
        const id = `service-tombstone-${String(index).padStart(5, '0')}`;
        insert.run(
          CONNECTOR_ID,
          id,
          id,
          id,
          id,
          id,
          '2026-09-29T20:00:00.000Z',
          '2026-09-29T20:00:00.000Z',
          '2026-09-29T20:00:00.000Z',
        );
      }
    })();
    await repository.applyFeedPage({
      connectorId: CONNECTOR_ID,
      page: emptyPage({ nextCursor: 'cursor-before-overflow' }),
      requestedCursor: null,
      receivedAt: NOW,
    });

    const live = companionAction(7_001);
    const liveEvent = {
      eventId: uuid(7_101),
      operationId: uuid(7_201),
      aggregateId: live.actionId,
      aggregateVersion: live.revision,
      sourceId: 'rymessage:service-live',
      occurredAt: '2026-09-29T21:01:00.000Z',
      kind: 'upsert' as const,
      action: live,
    };
    const overflowTombstone = {
      eventId: uuid(7_102),
      operationId: uuid(7_202),
      aggregateId: uuid(7_002),
      aggregateVersion: 1,
      sourceId: 'rymessage:service-tombstone',
      occurredAt: '2026-09-29T21:01:00.000Z',
      kind: 'tombstone' as const,
    };
    const incremental = emptyPage({
      mode: 'incremental',
      nextCursor: 'cursor-overflow',
      items: [liveEvent, overflowTombstone],
    });
    const recovery = emptyPage({
      nextCursor: 'cursor-recovered',
      items: [liveEvent, overflowTombstone],
    });
    const client = {
      fetchPage: vi.fn(async (cursor: string | null) => (
        cursor === null ? recovery : incremental
      )),
      fetchPageV2: vi.fn(),
      validateMutationV2: vi.fn(() => true),
      submitMutation: vi.fn(),
      submitMutationV2: vi.fn(),
    };
    const reconciliation = new CompanionActionReconciliationService(
      CONNECTOR_ID,
      client,
      async () => repository,
    );

    await expect(reconciliation.sync()).resolves.toMatchObject({
      itemsAdded: 1,
      itemsRemoved: 1,
      status: 'fresh',
    });
    expect(client.fetchPage).toHaveBeenNthCalledWith(
      1,
      'cursor-before-overflow',
      undefined,
    );
    expect(client.fetchPage).toHaveBeenNthCalledWith(2, null, undefined);
    expect(await repository.getProjection(CONNECTOR_ID, live.actionId))
      .toMatchObject({ action: expect.objectContaining({ actionId: live.actionId }) });
    expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
      cursor: 'cursor-recovered',
      recoveryGeneration: 1,
      recoveryRequired: false,
    });
  });

  it('pages until the feed reports complete', async () => {
    const {
      client,
      repository,
      service: { CompanionActionReconciliationService },
    } = await contextPromise;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage({
        nextCursor: 'page-2',
        complete: false,
      })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage({
        nextCursor: 'caught-up',
        complete: true,
      })), { status: 200 }));
    const api = client.createCompanionActionClient({
      baseUrl: 'https://companion.example.test',
      credential: 'principal-credential',
      fetchImpl: fetchMock,
      maxRetries: 0,
    });
    const reconciliation = new CompanionActionReconciliationService(
      CONNECTOR_ID,
      api,
      async () => repository,
    );
    await expect(reconciliation.sync()).resolves.toMatchObject({
      itemsAdded: 0,
      itemsUpdated: 0,
      status: 'fresh',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('cursor=');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('cursor=page-2');
    expect((await repository.readFeedState(CONNECTOR_ID)).cursor).toBe('caught-up');
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
