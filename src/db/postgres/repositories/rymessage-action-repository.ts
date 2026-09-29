import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  companionActionDigest,
  sanitizeCompanionAction,
  stableCompanionOperationId,
  type CompanionActionMutation,
  type PortableCompanionAction,
} from '@/lib/connectors/rymessage/action-contract';
import {
  RYMESSAGE_ACTION_DEFAULT_LEASE_SECONDS,
  RYMESSAGE_ACTION_MAX_ATTEMPTS,
  RYMESSAGE_ACTION_MAX_LEASE_ITEMS,
  RYMESSAGE_ACTION_MAX_LEASE_SECONDS,
  RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS,
  RYMESSAGE_ACTION_MAX_OBSERVATIONS_PER_RECONCILE,
  RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE,
  RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS,
  RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS,
  RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS,
  RyMessageActionPersistenceError,
  assertCompanionMutationRevisionFence,
  type RyMessageActionPersistence,
  type RyMessageFeedState,
  type RyMessageLeasedMutation,
} from '@/db/persistence/rymessage-actions';

type Client = Pool | PoolClient;

interface FeedStateRow extends QueryResultRow {
  connectorId: string;
  feedId: string | null;
  cursor: string | null;
  recoveryGeneration: number;
  recoveryRequired: boolean;
  fullSyncGeneration: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface ProjectionRow extends QueryResultRow {
  connectorId: string;
  actionId: string;
  sourceId: string;
  revision: number;
  payload: PortableCompanionAction | null;
  payloadDigest: string;
  tombstonedAt: string | null;
}

async function rows<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function clampLeaseSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return RYMESSAGE_ACTION_DEFAULT_LEASE_SECONDS;
  return Math.min(
    Math.max(Math.trunc(value as number), 30),
    RYMESSAGE_ACTION_MAX_LEASE_SECONDS,
  );
}

function clampLeaseItems(value: number | undefined): number {
  if (!Number.isFinite(value)) return RYMESSAGE_ACTION_MAX_LEASE_ITEMS;
  return Math.min(Math.max(Math.trunc(value as number), 1), RYMESSAGE_ACTION_MAX_LEASE_ITEMS);
}

function retryAt(now: string, attemptCount: number): string {
  const delayMs = Math.min(3_600_000, 1_000 * (2 ** Math.min(attemptCount, 12)));
  return new Date(Date.parse(now) + delayMs).toISOString();
}

export function createPostgresRyMessageActionRepository(
  pool: Pool,
): RyMessageActionPersistence {
  async function assertConnector(client: Client, connectorId: string): Promise<void> {
    const [connector] = await rows<{
      type: string;
      enabled: boolean;
      deletedAt: string | null;
    } & QueryResultRow>(
      client,
      `SELECT type, enabled, deleted_at AS "deletedAt"
       FROM connector_configs WHERE id = $1`,
      [connectorId],
    );
    if (!connector || connector.deletedAt || connector.type !== 'rymessage') {
      throw new RyMessageActionPersistenceError(
        'CONNECTOR_NOT_FOUND',
        'RyMessage connector not found',
      );
    }
    if (!connector.enabled) {
      throw new RyMessageActionPersistenceError(
        'CONNECTOR_DISABLED',
        'RyMessage connector is disabled',
      );
    }
  }

  async function ensureFeedState(
    client: Client,
    connectorId: string,
    now: string,
    lock = false,
  ): Promise<FeedStateRow> {
    await client.query(
      `INSERT INTO rymessage_action_feed_state (
         connector_id, recovery_generation, recovery_required, created_at, updated_at
       ) VALUES ($1, 0, true, $2, $2)
       ON CONFLICT (connector_id) DO NOTHING`,
      [connectorId, now],
    );
    const [state] = await rows<FeedStateRow>(
      client,
      `SELECT connector_id AS "connectorId", feed_id AS "feedId", cursor,
              recovery_generation AS "recoveryGeneration",
              recovery_required AS "recoveryRequired",
              full_sync_generation AS "fullSyncGeneration",
              last_synced_at AS "lastSyncedAt", last_error AS "lastError"
       FROM rymessage_action_feed_state
       WHERE connector_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [connectorId],
    );
    if (!state) throw new Error('RyMessage action feed state was not created');
    return state;
  }

  async function readProjection(
    client: Client,
    connectorId: string,
    actionId: string,
  ): Promise<ProjectionRow | undefined> {
    return (await rows<ProjectionRow>(
      client,
      `SELECT connector_id AS "connectorId", action_id AS "actionId",
              source_id AS "sourceId", revision, payload,
              payload_digest AS "payloadDigest", tombstoned_at AS "tombstonedAt"
       FROM rymessage_action_projections
       WHERE connector_id = $1 AND action_id = $2`,
      [connectorId, actionId],
    ))[0];
  }

  async function enqueue(
    client: Client,
    input: {
      connectorId: string;
      actionId: string;
      operationId: string;
      baseRevision: number;
      expectedFieldRevisions: Readonly<Record<string, number>>;
      mutation: CompanionActionMutation;
      now: string;
    },
  ): Promise<'queued' | 'duplicate'> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${input.connectorId}:rymessage-action-mutations`],
    );
    const digest = companionActionDigest({
      actionId: input.actionId,
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    });
    const [existing] = await rows<{ mutationDigest: string } & QueryResultRow>(
      client,
      `SELECT mutation_digest AS "mutationDigest"
       FROM rymessage_action_outbound_mutations
       WHERE connector_id = $1 AND operation_id = $2`,
      [input.connectorId, input.operationId],
    );
    if (existing) {
      if (existing.mutationDigest !== digest) {
        throw new RyMessageActionPersistenceError(
          'IDEMPOTENCY_CONFLICT',
          'Mutation identity was reused with different content',
        );
      }
      return 'duplicate';
    }
    const [queued] = await rows<{ count: string } & QueryResultRow>(
      client,
      `SELECT COUNT(*)::text AS count
       FROM rymessage_action_outbound_mutations
       WHERE connector_id = $1 AND status IN ('pending', 'retry', 'leased')`,
      [input.connectorId],
    );
    if (Number(queued?.count ?? 0) >= RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE) {
      throw new RyMessageActionPersistenceError(
        'OUTBOUND_QUOTA_EXCEEDED',
        'RyMessage mutation queue quota exceeded',
      );
    }
    await client.query(
      `INSERT INTO rymessage_action_outbound_mutations (
         connector_id, operation_id, action_id, base_revision,
         expected_field_revisions, mutation, mutation_digest, status,
         available_at, attempt_count, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, 'pending', $8, 0, $8, $8)`,
      [
        input.connectorId,
        input.operationId,
        input.actionId,
        input.baseRevision,
        JSON.stringify(input.expectedFieldRevisions),
        JSON.stringify(input.mutation),
        digest,
        input.now,
      ],
    );
    return 'queued';
  }

  return {
    async readFeedState(connectorId) {
      return transaction(pool, async (client) => {
        await assertConnector(client, connectorId);
        return ensureFeedState(client, connectorId, new Date().toISOString());
      });
    },

    async applyFeedPage(command) {
      return transaction(pool, async (client) => {
        await assertConnector(client, command.connectorId);
        const state = await ensureFeedState(
          client,
          command.connectorId,
          command.receivedAt,
          true,
        );
        if (state.cursor !== command.requestedCursor) {
          throw new RyMessageActionPersistenceError(
            'CURSOR_RACE',
            'RyMessage feed cursor changed during page processing',
          );
        }
        if (
          state.recoveryRequired
          && state.cursor !== null
          && state.lastError?.startsWith('REVISION_CONFLICT:')
        ) {
          throw new RyMessageActionPersistenceError(
            'RECOVERY_CONFLICT',
            'Companion feed recovery is blocked by an unresolved revision conflict',
          );
        }
        if (state.feedId && state.feedId !== command.page.feedId) {
          throw new RyMessageActionPersistenceError(
            'FEED_IDENTITY_CHANGED',
            'Companion feed identity changed and requires recovery',
          );
        }
        if (command.requestedCursor === null && command.page.mode !== 'full') {
          throw new RyMessageActionPersistenceError(
            'FULL_SNAPSHOT_REQUIRED',
            'A fresh Companion reconciliation must begin with a full page',
          );
        }
        const authoritativeRecovery = command.requestedCursor === null
          && command.page.mode === 'full'
          && state.recoveryRequired;
        for (const item of command.page.items) {
          if (item.kind !== 'upsert') continue;
          const [receipt] = await rows<{ payloadDigest: string } & QueryResultRow>(
            client,
            `SELECT payload_digest AS "payloadDigest"
             FROM rymessage_action_receipts
             WHERE connector_id = $1 AND event_id = $2`,
            [command.connectorId, item.eventId],
          );
          if (receipt) continue;
          const existing = await readProjection(client, command.connectorId, item.aggregateId);
          if (
            existing
            && item.aggregateVersion === existing.revision
            && existing.payloadDigest !== companionActionDigest(sanitizeCompanionAction(item.action))
            && !authoritativeRecovery
          ) {
            const reason = [
              'REVISION_CONFLICT',
              item.aggregateId,
              String(item.aggregateVersion),
              item.eventId,
            ].join(':').slice(0, 300);
            await client.query(
              `UPDATE rymessage_action_feed_state
               SET recovery_required = true, last_error = $1, updated_at = $2
               WHERE connector_id = $3`,
              [reason, command.receivedAt, command.connectorId],
            );
            return {
              applied: 0,
              added: 0,
              updated: 0,
              ignored: 0,
              tombstoned: 0,
              conflicts: 1,
              recoveryCompleted: false,
              recoveryRequired: true,
            };
          }
        }

        const generation = command.page.mode === 'full'
          ? state.fullSyncGeneration ?? randomUUID()
          : state.fullSyncGeneration;
        let applied = 0;
        let added = 0;
        let updated = 0;
        let ignored = 0;
        let tombstoned = 0;
        let conflicts = 0;

        for (const item of command.page.items) {
          const digest = companionActionDigest(item);
          const [receipt] = await rows<{ payloadDigest: string } & QueryResultRow>(
            client,
            `SELECT payload_digest AS "payloadDigest"
             FROM rymessage_action_receipts
             WHERE connector_id = $1 AND event_id = $2`,
            [command.connectorId, item.eventId],
          );
          if (receipt) {
            if (receipt.payloadDigest !== digest) {
              throw new RyMessageActionPersistenceError(
                'EVENT_IDENTITY_CONFLICT',
                'Companion event identity was reused with different content',
              );
            }
            ignored++;
            continue;
          }
          const existing = await readProjection(client, command.connectorId, item.aggregateId);
          let outcome = 'ignored';
          if (item.kind === 'upsert') {
            const sanitized = sanitizeCompanionAction(item.action);
            const projectionDigest = companionActionDigest(sanitized);
            if (
              existing
              && item.aggregateVersion === existing.revision
              && existing.payloadDigest !== projectionDigest
              && !authoritativeRecovery
            ) {
              conflicts++;
              outcome = 'revision-conflict';
            } else if (
              existing
              && item.aggregateVersion <= existing.revision
              && !(authoritativeRecovery && item.aggregateVersion === existing.revision)
            ) {
              ignored++;
              outcome = 'stale';
            } else {
              if (!existing) {
                const [live] = await rows<{ count: string } & QueryResultRow>(
                  client,
                  `SELECT COUNT(*)::text AS count FROM rymessage_action_projections
                   WHERE connector_id = $1 AND tombstoned_at IS NULL`,
                  [command.connectorId],
                );
                if (Number(live?.count ?? 0) >= RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS) {
                  throw new RyMessageActionPersistenceError(
                    'PROJECTION_QUOTA_EXCEEDED',
                    'RyMessage action projection quota exceeded',
                  );
                }
              }
              await client.query(
                `INSERT INTO rymessage_action_projections (
                   connector_id, action_id, source_id, stable_key, revision, payload,
                   payload_digest, last_event_id, last_operation_id,
                   last_seen_generation, tombstoned_at, created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NULL, $11, $11)
                 ON CONFLICT (connector_id, action_id) DO UPDATE SET
                   source_id = EXCLUDED.source_id,
                   stable_key = EXCLUDED.stable_key,
                   revision = EXCLUDED.revision,
                   payload = EXCLUDED.payload,
                   payload_digest = EXCLUDED.payload_digest,
                   last_event_id = EXCLUDED.last_event_id,
                   last_operation_id = EXCLUDED.last_operation_id,
                   last_seen_generation = EXCLUDED.last_seen_generation,
                   tombstoned_at = NULL,
                   updated_at = EXCLUDED.updated_at`,
                [
                  command.connectorId,
                  item.action.actionId,
                  item.sourceId,
                  item.action.stableKey,
                  item.action.revision,
                  JSON.stringify(sanitized),
                  projectionDigest,
                  item.eventId,
                  item.operationId,
                  generation,
                  command.receivedAt,
                ],
              );
              const observed = new Set<string>();
              for (const relation of item.action.materializations) {
                observed.add(relation.materializationId);
                await client.query(
                  `INSERT INTO rymessage_action_materializations (
                     connector_id, materialization_id, action_id, action_revision,
                     revision, provider, provider_account_id, provider_list_id,
                     provider_task_id, state, provider_task_status_snapshot,
                     provider_version_snapshot, last_observed_at, local_task_id,
                     relation_state, conflict_code, created_at, updated_at
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                     NULL,
                     CASE WHEN $10 = 'deleted' THEN 'deleted'
                          WHEN $10 = 'link-broken' THEN 'link-broken'
                          ELSE 'pending-import' END,
                     NULL, $14, $14
                   )
                   ON CONFLICT (connector_id, materialization_id) DO UPDATE SET
                     action_id = EXCLUDED.action_id,
                     action_revision = EXCLUDED.action_revision,
                     revision = EXCLUDED.revision,
                     state = EXCLUDED.state,
                     provider_task_status_snapshot = EXCLUDED.provider_task_status_snapshot,
                     provider_version_snapshot = EXCLUDED.provider_version_snapshot,
                     last_observed_at = EXCLUDED.last_observed_at,
                     relation_state = CASE
                       WHEN EXCLUDED.state = 'deleted' THEN 'deleted'
                       WHEN EXCLUDED.state = 'link-broken' THEN 'link-broken'
                       ELSE rymessage_action_materializations.relation_state
                     END,
                     updated_at = EXCLUDED.updated_at`,
                  [
                    command.connectorId,
                    relation.materializationId,
                    item.action.actionId,
                    item.action.revision,
                    relation.revision,
                    relation.provider,
                    relation.providerAccountId,
                    relation.providerListId,
                    relation.providerTaskId,
                    relation.state,
                    relation.providerTaskStatusSnapshot ?? null,
                    relation.providerVersionSnapshot ?? null,
                    relation.lastObservedAt ?? null,
                    command.receivedAt,
                  ],
                );
              }
              const known = await rows<{ materializationId: string } & QueryResultRow>(
                client,
                `SELECT materialization_id AS "materializationId"
                 FROM rymessage_action_materializations
                 WHERE connector_id = $1 AND action_id = $2`,
                [command.connectorId, item.action.actionId],
              );
              for (const relation of known) {
                if (observed.has(relation.materializationId)) continue;
                await client.query(
                  `UPDATE rymessage_action_materializations
                   SET relation_state = 'link-broken', conflict_code = 'RELATION_REMOVED',
                       updated_at = $1
                   WHERE connector_id = $2 AND materialization_id = $3`,
                  [command.receivedAt, command.connectorId, relation.materializationId],
                );
              }
              applied++;
              if (existing) updated++;
              else added++;
              outcome = 'applied';
            }
          } else if (!existing || item.aggregateVersion >= existing.revision) {
            await client.query(
              `INSERT INTO rymessage_action_projections (
                 connector_id, action_id, source_id, revision, payload, payload_digest,
                 last_event_id, last_operation_id, last_seen_generation,
                 tombstoned_at, created_at, updated_at
               ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $10)
               ON CONFLICT (connector_id, action_id) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 payload = NULL,
                 payload_digest = EXCLUDED.payload_digest,
                 last_event_id = EXCLUDED.last_event_id,
                 last_operation_id = EXCLUDED.last_operation_id,
                 last_seen_generation = EXCLUDED.last_seen_generation,
                 tombstoned_at = EXCLUDED.tombstoned_at,
                 updated_at = EXCLUDED.updated_at`,
              [
                command.connectorId,
                item.aggregateId,
                item.sourceId,
                item.aggregateVersion,
                digest,
                item.eventId,
                item.operationId,
                generation,
                item.occurredAt,
                command.receivedAt,
              ],
            );
            await client.query(
              `UPDATE rymessage_action_materializations
               SET relation_state = 'deleted', conflict_code = 'ACTION_TOMBSTONED',
                   updated_at = $1
               WHERE connector_id = $2 AND action_id = $3`,
              [command.receivedAt, command.connectorId, item.aggregateId],
            );
            tombstoned++;
            outcome = 'tombstoned';
          } else {
            ignored++;
            outcome = 'stale';
          }
          await client.query(
            `INSERT INTO rymessage_action_receipts (
               connector_id, event_id, operation_id, action_id, aggregate_revision,
               payload_digest, outcome, received_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              command.connectorId,
              item.eventId,
              item.operationId,
              item.aggregateId,
              item.aggregateVersion,
              digest,
              outcome,
              command.receivedAt,
            ],
          );
        }

        let recoveryCompleted = false;
        if (command.page.mode === 'full' && command.page.complete && generation) {
          const missing = await rows<{ actionId: string } & QueryResultRow>(
            client,
            `UPDATE rymessage_action_projections
             SET payload = NULL, tombstoned_at = $1, updated_at = $1
             WHERE connector_id = $2 AND tombstoned_at IS NULL
               AND (last_seen_generation IS NULL OR last_seen_generation != $3)
             RETURNING action_id AS "actionId"`,
            [command.receivedAt, command.connectorId, generation],
          );
          if (missing.length > 0) {
            await client.query(
              `UPDATE rymessage_action_materializations
               SET relation_state = 'deleted', conflict_code = 'RECOVERY_OMISSION',
                   updated_at = $1
               WHERE connector_id = $2 AND action_id = ANY($3::text[])`,
              [command.receivedAt, command.connectorId, missing.map((row) => row.actionId)],
            );
          }
          tombstoned += missing.length;
          recoveryCompleted = true;
        }
        const [tombstones] = await rows<{ count: string } & QueryResultRow>(
          client,
          `SELECT COUNT(*)::text AS count
           FROM rymessage_action_projections
           WHERE connector_id = $1 AND tombstoned_at IS NOT NULL`,
          [command.connectorId],
        );
        const tombstoneOverflow = Number(tombstones?.count ?? 0)
          - RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS;
        const pruneTombstones = tombstoneOverflow > 0;
        const retentionRecoveryRequired = pruneTombstones
          && !(command.page.mode === 'full' && command.page.complete);
        if (pruneTombstones) {
          const deleted = await rows<{ actionId: string } & QueryResultRow>(
            client,
            `DELETE FROM rymessage_action_projections
             WHERE (connector_id, action_id) IN (
               SELECT connector_id, action_id
               FROM rymessage_action_projections
               WHERE connector_id = $1 AND tombstoned_at IS NOT NULL
               ORDER BY tombstoned_at, action_id
               LIMIT $2
             )
             RETURNING action_id AS "actionId"`,
            [command.connectorId, tombstoneOverflow],
          );
          if (deleted.length > 0) {
            await client.query(
              `DELETE FROM rymessage_action_materializations
               WHERE connector_id = $1 AND action_id = ANY($2::text[])`,
              [command.connectorId, deleted.map((row) => row.actionId)],
            );
          }
        }
        if (retentionRecoveryRequired) {
          await client.query(
            `UPDATE rymessage_action_feed_state
             SET feed_id = NULL, cursor = NULL,
                 recovery_generation = recovery_generation + 1,
                 recovery_required = true, full_sync_generation = NULL,
                 last_synced_at = $1, last_error = 'TOMBSTONE_RETENTION_RECOVERY',
                 updated_at = $1
             WHERE connector_id = $2`,
            [command.receivedAt, command.connectorId],
          );
        } else {
          await client.query(
            `UPDATE rymessage_action_feed_state
             SET feed_id = $1, cursor = $2, recovery_required = $3,
                 full_sync_generation = $4, last_synced_at = $5,
                 last_error = NULL, updated_at = $5
             WHERE connector_id = $6`,
            [
              command.page.feedId,
              command.page.nextCursor,
              recoveryCompleted ? false : state.recoveryRequired,
              recoveryCompleted ? null : generation,
              command.receivedAt,
              command.connectorId,
            ],
          );
        }
        await client.query(
          `DELETE FROM rymessage_action_receipts
           WHERE (connector_id, event_id) IN (
             SELECT connector_id, event_id
             FROM rymessage_action_receipts
             WHERE connector_id = $1
             ORDER BY received_at DESC, event_id DESC
             OFFSET $2
           )`,
          [command.connectorId, RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS],
        );
        return {
          applied,
          added,
          updated,
          ignored,
          tombstoned,
          conflicts,
          recoveryCompleted,
          recoveryRequired: retentionRecoveryRequired,
        };
      });
    },

    async invalidateRecovery(input) {
      await transaction(pool, async (client) => {
        await assertConnector(client, input.connectorId);
        await ensureFeedState(client, input.connectorId, input.now, true);
        await client.query(
          `UPDATE rymessage_action_feed_state
           SET feed_id = NULL, cursor = NULL, recovery_generation = recovery_generation + 1,
               recovery_required = true, full_sync_generation = NULL,
               last_error = $1, updated_at = $2
           WHERE connector_id = $3`,
          [input.reason.slice(0, 300), input.now, input.connectorId],
        );
      });
    },

    async reconcileMaterializations(input) {
      return transaction(pool, async (client) => {
        await assertConnector(client, input.connectorId);
        const relations = await rows<{
          materializationId: string;
          actionId: string;
          relationState: string;
          statusSnapshot: string | null;
          versionSnapshot: string | null;
          taskStatus: string | null;
          taskUpdatedAt: string | null;
          projectionPayload: PortableCompanionAction | null;
        } & QueryResultRow>(
          client,
          `WITH selected AS (
             SELECT materialization_id, action_id, state, local_task_id, relation_state,
                    provider_list_id, provider_task_id,
                    provider_task_status_snapshot, provider_version_snapshot
             FROM rymessage_action_materializations
             WHERE connector_id = $1
             ORDER BY updated_at, materialization_id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           ), matched AS (
             SELECT selected.*, task.match_count, task.task_id, task.task_status,
                    task.task_updated_at
             FROM selected
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS match_count,
                      MIN(candidate.id) AS task_id,
                      MIN(candidate.status) AS task_status,
                      MIN(candidate.updated_at) AS task_updated_at
               FROM (
                 SELECT id, status, updated_at
                 FROM tasks
                 WHERE connector_type = 'microsoft-todo'
                   AND source_id = selected.provider_list_id || ':' || selected.provider_task_id
                   AND is_checklist_item = false AND deleted_at IS NULL
                 ORDER BY connector_instance_id, id
                 LIMIT 2
               ) candidate
             ) task ON true
           ), classified AS (
             SELECT matched.*,
                    CASE
                      WHEN state = 'deleted' THEN 'deleted'
                      WHEN state = 'link-broken' THEN 'link-broken'
                      WHEN match_count > 1 THEN 'conflict'
                      WHEN match_count = 1 THEN 'linked'
                      WHEN local_task_id IS NOT NULL OR relation_state = 'link-broken'
                        THEN 'link-broken'
                      ELSE 'pending-import'
                    END AS next_relation_state,
                    CASE WHEN match_count = 1 THEN task_id ELSE NULL END AS next_local_task_id,
                    CASE
                      WHEN match_count > 1 THEN 'AMBIGUOUS_PROVIDER_IDENTITY'
                      WHEN match_count = 0
                        AND (local_task_id IS NOT NULL OR relation_state = 'link-broken')
                        THEN 'PROVIDER_TASK_MISSING'
                      ELSE NULL
                    END AS next_conflict_code
             FROM matched
           ), updated AS (
             UPDATE rymessage_action_materializations materialization
             SET local_task_id = classified.next_local_task_id,
                 relation_state = classified.next_relation_state,
                 conflict_code = classified.next_conflict_code,
                 updated_at = $3
             FROM classified
             WHERE materialization.connector_id = $1
               AND materialization.materialization_id = classified.materialization_id
             RETURNING materialization.materialization_id, materialization.action_id,
                       classified.next_relation_state,
                       classified.provider_task_status_snapshot,
                       classified.provider_version_snapshot,
                       CASE WHEN classified.task_status = 'done'
                         THEN 'completed' ELSE classified.task_status END AS task_status,
                       classified.task_updated_at
           )
           SELECT updated.materialization_id AS "materializationId",
                  updated.action_id AS "actionId",
                  updated.next_relation_state AS "relationState",
                  updated.provider_task_status_snapshot AS "statusSnapshot",
                  updated.provider_version_snapshot AS "versionSnapshot",
                  updated.task_status AS "taskStatus",
                  updated.task_updated_at AS "taskUpdatedAt",
                  projection.payload AS "projectionPayload"
           FROM updated
           LEFT JOIN rymessage_action_projections projection
             ON projection.connector_id = $1 AND projection.action_id = updated.action_id
           ORDER BY updated.materialization_id`,
          [input.connectorId, RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS, input.now],
        );
        const linked = relations.filter((row) => row.relationState === 'linked').length;
        const pendingImport = relations.filter(
          (row) => row.relationState === 'pending-import',
        ).length;
        const conflicts = relations.filter((row) => row.relationState === 'conflict').length;
        const broken = relations.filter((row) => row.relationState === 'link-broken').length;
        let observationsQueued = 0;
        let observationCandidates = 0;
        for (const relation of relations) {
          if (
            relation.relationState !== 'linked'
            || !relation.taskStatus
            || !relation.taskUpdatedAt
          ) continue;
          if (
            relation.statusSnapshot !== relation.taskStatus
            || relation.versionSnapshot !== relation.taskUpdatedAt
          ) {
            if (observationCandidates >= RYMESSAGE_ACTION_MAX_OBSERVATIONS_PER_RECONCILE) {
              continue;
            }
            observationCandidates++;
            if (relation.projectionPayload) {
              const operationId = stableCompanionOperationId(
                `${input.connectorId}:${relation.materializationId}:observe:${relation.taskStatus}:${relation.taskUpdatedAt}`,
              );
              const result = await enqueue(client, {
                connectorId: input.connectorId,
                actionId: relation.actionId,
                operationId,
                baseRevision: relation.projectionPayload.revision,
                expectedFieldRevisions: {
                  [`materialization:${relation.materializationId}`]:
                    relation.projectionPayload.fieldRevisions[
                      `materialization:${relation.materializationId}`
                    ] ?? 0,
                },
                mutation: {
                  kind: 'materialization.observe',
                  materializationId: relation.materializationId,
                  providerTaskStatusSnapshot: relation.taskStatus,
                  providerVersionSnapshot: relation.taskUpdatedAt,
                  observedAt: relation.taskUpdatedAt,
                },
                now: input.now,
              });
              if (result === 'queued') observationsQueued++;
            }
          }
        }
        return { linked, pendingImport, conflicts, broken, observationsQueued };
      });
    },

    async getProjection(connectorId, actionId) {
      const row = await readProjection(pool, connectorId, actionId);
      return row
        ? {
            connectorId: row.connectorId,
            actionId: row.actionId,
            sourceId: row.sourceId,
            revision: row.revision,
            action: row.payload,
            tombstonedAt: row.tombstonedAt,
          }
        : null;
    },

    async enqueueMutation(command) {
      return transaction(pool, async (client) => {
        await assertConnector(client, command.connectorId);
        const digest = companionActionDigest({
          actionId: command.actionId,
          baseRevision: command.baseRevision,
          mutation: command.mutation,
        });
        const [existingMutation] = await rows<{
          mutationDigest: string;
        } & QueryResultRow>(
          client,
          `SELECT mutation_digest AS "mutationDigest"
           FROM rymessage_action_outbound_mutations
           WHERE connector_id = $1 AND operation_id = $2`,
          [command.connectorId, command.operationId],
        );
        if (existingMutation) {
          if (existingMutation.mutationDigest !== digest) {
            throw new RyMessageActionPersistenceError(
              'IDEMPOTENCY_CONFLICT',
              'Mutation identity was reused with different content',
            );
          }
          return 'duplicate';
        }
        const projection = await readProjection(client, command.connectorId, command.actionId);
        if (!projection || projection.tombstonedAt) {
          throw new RyMessageActionPersistenceError(
            'ACTION_NOT_FOUND',
            'Canonical Companion action does not exist',
          );
        }
        if (!projection.payload) {
          throw new RyMessageActionPersistenceError(
            'ACTION_NOT_FOUND',
            'Canonical Companion action does not exist',
          );
        }
        assertCompanionMutationRevisionFence({
          action: projection.payload,
          baseRevision: command.baseRevision,
          expectedFieldRevisions: command.expectedFieldRevisions,
          mutation: command.mutation,
        });
        if (command.mutation.kind === 'materialization.observe') {
          const [relation] = await rows<QueryResultRow>(
            client,
            `SELECT 1 FROM rymessage_action_materializations
             WHERE connector_id = $1 AND action_id = $2 AND materialization_id = $3`,
            [
              command.connectorId,
              command.actionId,
              command.mutation.materializationId,
            ],
          );
          if (!relation) {
            throw new RyMessageActionPersistenceError(
              'MATERIALIZATION_NOT_FOUND',
              'Cannot observe an unknown materialization',
            );
          }
        }
        return enqueue(client, command);
      });
    },

    async leaseMutations(input) {
      return transaction(pool, async (client) => {
        await assertConnector(client, input.connectorId);
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(
          Date.parse(input.now) + clampLeaseSeconds(input.leaseSeconds) * 1_000,
        ).toISOString();
        await client.query(
          `UPDATE rymessage_action_outbound_mutations
           SET status = 'retry', lease_id = NULL, lease_expires_at = NULL,
               available_at = $1, updated_at = $1
           WHERE connector_id = $2 AND status = 'leased' AND lease_expires_at <= $1`,
          [input.now, input.connectorId],
        );
        const candidates = await rows<{
          operationId: string;
          actionId: string;
          baseRevision: number;
          expectedFieldRevisions: Record<string, number>;
          mutation: CompanionActionMutation;
          attemptCount: number;
        } & QueryResultRow>(
          client,
          `SELECT operation_id AS "operationId", action_id AS "actionId",
                  base_revision AS "baseRevision",
                  expected_field_revisions AS "expectedFieldRevisions",
                  mutation, attempt_count AS "attemptCount"
           FROM rymessage_action_outbound_mutations
           WHERE connector_id = $1 AND status IN ('pending', 'retry') AND available_at <= $2
           ORDER BY created_at, operation_id
           LIMIT $3
           FOR UPDATE SKIP LOCKED`,
          [input.connectorId, input.now, clampLeaseItems(input.limit)],
        );
        const items: RyMessageLeasedMutation[] = [];
        for (const candidate of candidates) {
          const projection = await readProjection(client, input.connectorId, candidate.actionId);
          if (!projection?.payload) {
            await client.query(
              `UPDATE rymessage_action_outbound_mutations
               SET status = 'conflict', last_error_code = 'ACTION_NOT_FOUND',
                   last_error = 'Canonical action is unavailable', updated_at = $1
               WHERE connector_id = $2 AND operation_id = $3`,
              [input.now, input.connectorId, candidate.operationId],
            );
            continue;
          }
          try {
            assertCompanionMutationRevisionFence({
              action: projection.payload,
              baseRevision: candidate.baseRevision,
              expectedFieldRevisions: candidate.expectedFieldRevisions,
              mutation: candidate.mutation,
            });
          } catch (error) {
            const persistenceError = error instanceof RyMessageActionPersistenceError
              ? error
              : null;
            await client.query(
              `UPDATE rymessage_action_outbound_mutations
               SET status = 'conflict', last_error_code = $1,
                   last_error = $2, updated_at = $3
               WHERE connector_id = $4 AND operation_id = $5`,
              [
                persistenceError?.code ?? 'REVISION_FENCE_INVALID',
                persistenceError?.message.slice(0, 300)
                  ?? 'Mutation revision fence is invalid',
                input.now,
                input.connectorId,
                candidate.operationId,
              ],
            );
            continue;
          }
          await client.query(
            `UPDATE rymessage_action_outbound_mutations
             SET status = 'leased', lease_id = $1, lease_expires_at = $2,
                 base_revision = $3, attempt_count = attempt_count + 1, updated_at = $4
             WHERE connector_id = $5 AND operation_id = $6`,
            [
              leaseId,
              leaseExpiresAt,
              projection.payload.revision,
              input.now,
              input.connectorId,
              candidate.operationId,
            ],
          );
          items.push({
            operationId: candidate.operationId,
            connectorId: input.connectorId,
            actionId: candidate.actionId,
            baseRevision: projection.payload.revision,
            expectedFieldRevisions: candidate.expectedFieldRevisions,
            mutation: candidate.mutation,
            attemptCount: candidate.attemptCount + 1,
          });
        }
        return { leaseId, leaseExpiresAt, items };
      });
    },

    async completeMutation(outcome) {
      await transaction(pool, async (client) => {
        const [row] = await rows<{
          attemptCount: number;
          actionId: string;
        } & QueryResultRow>(
          client,
          `SELECT attempt_count AS "attemptCount", action_id AS "actionId"
           FROM rymessage_action_outbound_mutations
           WHERE connector_id = $1 AND operation_id = $2
             AND status = 'leased' AND lease_id = $3
           FOR UPDATE`,
          [outcome.connectorId, outcome.operationId, outcome.leaseId],
        );
        if (!row) {
          throw new RyMessageActionPersistenceError(
            'LEASE_LOST',
            'RyMessage mutation lease is no longer current',
          );
        }
        if (outcome.receipt) {
          if (
            outcome.receipt.operationId !== outcome.operationId
            || outcome.receipt.actionId !== row.actionId
          ) {
            await client.query(
              `UPDATE rymessage_action_outbound_mutations
               SET status = 'conflict', receipt = NULL, lease_id = NULL,
                   lease_expires_at = NULL,
                   last_error_code = 'RECEIPT_IDENTITY_MISMATCH',
                   last_error = 'Companion receipt does not match the leased mutation',
                   updated_at = $1
               WHERE connector_id = $2 AND operation_id = $3 AND lease_id = $4`,
              [
                outcome.now,
                outcome.connectorId,
                outcome.operationId,
                outcome.leaseId,
              ],
            );
            return;
          }
          await client.query(
            `UPDATE rymessage_action_outbound_mutations
             SET status = $1, receipt = $2::jsonb, lease_id = NULL,
                 lease_expires_at = NULL, last_error_code = NULL,
                 last_error = NULL, updated_at = $3
             WHERE connector_id = $4 AND operation_id = $5 AND lease_id = $6`,
            [
              outcome.receipt.outcome === 'conflict' ? 'conflict' : 'succeeded',
              JSON.stringify(outcome.receipt),
              outcome.now,
              outcome.connectorId,
              outcome.operationId,
              outcome.leaseId,
            ],
          );
          return;
        }
        const status = outcome.retryable && row.attemptCount < RYMESSAGE_ACTION_MAX_ATTEMPTS
          ? 'retry'
          : 'dead-letter';
        await client.query(
          `UPDATE rymessage_action_outbound_mutations
           SET status = $1, lease_id = NULL, lease_expires_at = NULL,
               available_at = $2, last_error_code = $3, last_error = $4,
               updated_at = $5
           WHERE connector_id = $6 AND operation_id = $7 AND lease_id = $8`,
          [
            status,
            retryAt(outcome.now, row.attemptCount),
            outcome.errorCode?.slice(0, 100) ?? 'MUTATION_FAILED',
            outcome.errorMessage?.replace(/\s+/g, ' ').slice(0, 300) ?? 'Mutation failed',
            outcome.now,
            outcome.connectorId,
            outcome.operationId,
            outcome.leaseId,
          ],
        );
      });
    },

    async readStatus(connectorId) {
      return transaction(pool, async (client) => {
        await assertConnector(client, connectorId);
        const feed: RyMessageFeedState = await ensureFeedState(
          client,
          connectorId,
          new Date().toISOString(),
        );
        const [counts] = await rows<{
          projectionCount: string;
          linkedCount: string;
          pendingImportCount: string;
          conflictCount: string;
          mutationConflictCount: string;
          pendingWriteCount: string;
          deadLetterCount: string;
        } & QueryResultRow>(
          client,
          `SELECT
             (SELECT COUNT(*) FROM rymessage_action_projections
              WHERE connector_id = $1 AND tombstoned_at IS NULL)::text AS "projectionCount",
             (SELECT COUNT(*) FROM rymessage_action_materializations
              WHERE connector_id = $1 AND relation_state = 'linked')::text AS "linkedCount",
             (SELECT COUNT(*) FROM rymessage_action_materializations
              WHERE connector_id = $1 AND relation_state = 'pending-import')::text
                AS "pendingImportCount",
             (SELECT COUNT(*) FROM rymessage_action_materializations
              WHERE connector_id = $1 AND relation_state = 'conflict')::text AS "conflictCount",
             (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
               WHERE connector_id = $1 AND status = 'conflict')::text AS "mutationConflictCount",
             (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
              WHERE connector_id = $1 AND status IN ('pending', 'retry', 'leased'))::text
                AS "pendingWriteCount",
             (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
              WHERE connector_id = $1 AND status = 'dead-letter')::text AS "deadLetterCount"`,
          [connectorId],
        );
        return {
          feed,
          projectionCount: Number(counts?.projectionCount ?? 0),
          linkedCount: Number(counts?.linkedCount ?? 0),
          pendingImportCount: Number(counts?.pendingImportCount ?? 0),
          conflictCount: Number(counts?.conflictCount ?? 0),
          mutationConflictCount: Number(counts?.mutationConflictCount ?? 0),
          pendingWriteCount: Number(counts?.pendingWriteCount ?? 0),
          deadLetterCount: Number(counts?.deadLetterCount ?? 0),
        };
      });
    },
  };
}
