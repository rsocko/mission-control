import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  companionActionV2Digest,
  type CompanionActionFeedItemV2,
  type CompanionActionMutationRequestV2,
} from '@/lib/connectors/rymessage/action-contract-v2';
import {
  RYMESSAGE_ACTION_DEFAULT_LEASE_SECONDS,
  RYMESSAGE_ACTION_MAX_ATTEMPTS,
  RYMESSAGE_ACTION_MAX_LEASE_ITEMS,
  RYMESSAGE_ACTION_MAX_LEASE_SECONDS,
  RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS,
  RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE,
  RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS,
  RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS,
  RyMessageActionPersistenceError,
  type RyMessageActionPersistence,
} from '@/db/persistence/rymessage-actions';

type Client = Pool | PoolClient;

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

  return {
    async readV2FeedState(connectorId) {
      return transaction(pool, async client => {
        await assertConnector(client, connectorId);
        const now = new Date().toISOString();
        await client.query(
          `INSERT INTO rymessage_action_v2_feed_state (
             connector_id, recovery_generation, recovery_required, created_at, updated_at
           ) VALUES ($1, 0, true, $2, $2)
           ON CONFLICT (connector_id) DO NOTHING`,
          [connectorId, now],
        );
        const [state] = await rows<{
          connectorId: string; feedId: string | null; cursor: string | null;
          recoveryGeneration: number; recoveryRequired: boolean;
          fullSyncGeneration: string | null;
          lastSyncedAt: string | null; lastError: string | null;
        } & QueryResultRow>(
          client,
          `SELECT connector_id AS "connectorId", feed_id AS "feedId", cursor,
                  recovery_generation AS "recoveryGeneration",
                  recovery_required AS "recoveryRequired",
                  full_sync_generation AS "fullSyncGeneration",
                  last_synced_at AS "lastSyncedAt", last_error AS "lastError"
           FROM rymessage_action_v2_feed_state WHERE connector_id = $1`,
          [connectorId],
        );
        if (!state) throw new Error('ActionV2 feed state was not created');
        return state;
      });
    },

    async applyV2FeedPage(command) {
      return transaction(pool, async client => {
        await assertConnector(client, command.connectorId);
        const [state] = await rows<{
          feedId: string | null; cursor: string | null;
          recoveryRequired: boolean; fullSyncGeneration: string | null;
        } & QueryResultRow>(
          client,
          `SELECT feed_id AS "feedId", cursor,
                  recovery_required AS "recoveryRequired",
                  full_sync_generation AS "fullSyncGeneration"
           FROM rymessage_action_v2_feed_state
           WHERE connector_id = $1 FOR UPDATE`,
          [command.connectorId],
        );
        if (!state || state.cursor !== command.requestedCursor) {
          throw new RyMessageActionPersistenceError('CURSOR_RACE', 'ActionV2 cursor changed');
        }
        if (state.feedId && state.feedId !== command.page.feedId) {
          throw new RyMessageActionPersistenceError(
            'FEED_IDENTITY_CHANGED',
            'ActionV2 feed identity changed',
          );
        }
        if (state.recoveryRequired && command.page.mode !== 'full') {
          throw new RyMessageActionPersistenceError(
            'RECOVERY_REQUIRED',
            'ActionV2 recovery must begin with a full page',
          );
        }
        const fullSyncGeneration = command.page.mode === 'full'
          ? state.fullSyncGeneration ?? randomUUID()
          : null;
        let applied = 0;
        let replayed = 0;
        for (const item of command.page.items) {
          const digest = companionActionV2Digest(item);
          const [receipt] = await rows<{ payloadDigest: string } & QueryResultRow>(
            client,
            `SELECT payload_digest AS "payloadDigest"
             FROM rymessage_action_v2_receipts
             WHERE connector_id = $1 AND event_id = $2`,
            [command.connectorId, item.eventId],
          );
          if (receipt) {
            if (receipt.payloadDigest !== digest) {
              throw new RyMessageActionPersistenceError(
                'EVENT_DIGEST_CONFLICT',
                'ActionV2 event identity was reused with different content',
              );
            }
            replayed++;
            continue;
          }
          const [existing] = await rows<{
            revision: number; payloadDigest: string;
          } & QueryResultRow>(
            client,
            `SELECT revision, payload_digest AS "payloadDigest"
             FROM rymessage_action_v2_projections
             WHERE connector_id = $1 AND action_id = $2`,
            [command.connectorId, item.aggregateId],
          );
          if (
            existing
            && existing.revision === item.aggregateVersion
            && existing.payloadDigest !== digest
            && !(
              command.page.mode === 'full'
              && (state.recoveryRequired || state.fullSyncGeneration !== null)
            )
          ) {
            throw new RyMessageActionPersistenceError(
              'REVISION_CONFLICT',
              `ActionV2 revision conflict for ${item.aggregateId}`,
            );
          }
          const outcome = existing && existing.revision > item.aggregateVersion
            ? 'stale-noop'
            : 'applied';
          if (outcome === 'applied') {
            await client.query(
              `INSERT INTO rymessage_action_v2_projections (
                 connector_id, action_id, source_id, revision, payload, payload_digest,
                 last_event_id, last_operation_id, tombstoned_at, created_at, updated_at
                 , last_seen_generation
               ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $10, $11)
               ON CONFLICT (connector_id, action_id) DO UPDATE SET
                 source_id = EXCLUDED.source_id,
                 revision = EXCLUDED.revision,
                 payload = EXCLUDED.payload,
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
                item.kind === 'upsert' ? JSON.stringify(item) : null,
                digest,
                item.eventId,
                item.operationId,
                item.kind === 'tombstone' ? item.occurredAt : null,
                command.receivedAt,
                fullSyncGeneration,
              ],
            );
            applied++;
          }
          await client.query(
            `INSERT INTO rymessage_action_v2_receipts (
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
        if (command.page.mode === 'full' && command.page.complete) {
          await client.query(
            `UPDATE rymessage_action_v2_projections
             SET payload = NULL, tombstoned_at = $1, updated_at = $1
             WHERE connector_id = $2
               AND tombstoned_at IS NULL
               AND last_seen_generation IS DISTINCT FROM $3`,
            [command.receivedAt, command.connectorId, fullSyncGeneration],
          );
        }
        const [liveCount] = await rows<{ count: string } & QueryResultRow>(
          client,
          `SELECT COUNT(*)::text AS count
           FROM rymessage_action_v2_projections
           WHERE connector_id = $1 AND tombstoned_at IS NULL`,
          [command.connectorId],
        );
        if (Number(liveCount?.count ?? 0) > RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS) {
          throw new RyMessageActionPersistenceError(
            'LIVE_QUOTA_EXCEEDED',
            'ActionV2 live projection quota exceeded',
          );
        }
        await client.query(
          `DELETE FROM rymessage_action_v2_projections
           WHERE connector_id = $1 AND action_id IN (
             SELECT action_id
             FROM rymessage_action_v2_projections
             WHERE connector_id = $1 AND tombstoned_at IS NOT NULL
             ORDER BY tombstoned_at DESC, action_id DESC
             OFFSET $2
           )`,
          [command.connectorId, RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS],
        );
        await client.query(
          `DELETE FROM rymessage_action_v2_receipts
           WHERE connector_id = $1 AND event_id IN (
             SELECT event_id
             FROM rymessage_action_v2_receipts
             WHERE connector_id = $1
             ORDER BY received_at DESC, event_id DESC
             OFFSET $2
           )`,
          [command.connectorId, RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS],
        );
        await client.query(
          `UPDATE rymessage_action_v2_feed_state
           SET feed_id = $1, cursor = $2, recovery_required = $3,
               full_sync_generation = $4,
               last_synced_at = $5, last_error = NULL, updated_at = $5
           WHERE connector_id = $6`,
          [
            command.page.feedId,
            command.page.nextCursor,
            command.page.mode === 'full' && !command.page.complete,
            command.page.mode === 'full' && !command.page.complete
              ? fullSyncGeneration
              : null,
            command.receivedAt,
            command.connectorId,
          ],
        );
        return { applied, replayed };
      });
    },

    async listV2Projections(connectorId) {
      await assertConnector(pool, connectorId);
      const projections = await rows<{
        connectorId: string; actionId: string; sourceId: string; revision: number;
        item: CompanionActionFeedItemV2 | null; tombstonedAt: string | null;
      } & QueryResultRow>(
        pool,
        `SELECT connector_id AS "connectorId", action_id AS "actionId",
                source_id AS "sourceId", revision, payload AS item,
                tombstoned_at AS "tombstonedAt"
         FROM rymessage_action_v2_projections
         WHERE connector_id = $1 ORDER BY action_id`,
        [connectorId],
      );
      return projections;
    },

    async getV2Projection(connectorId, actionId) {
      await assertConnector(pool, connectorId);
      const [projection] = await rows<{
        connectorId: string; actionId: string; sourceId: string; revision: number;
        item: CompanionActionFeedItemV2 | null; tombstonedAt: string | null;
      } & QueryResultRow>(
        pool,
        `SELECT connector_id AS "connectorId", action_id AS "actionId",
                source_id AS "sourceId", revision, payload AS item,
                tombstoned_at AS "tombstonedAt"
         FROM rymessage_action_v2_projections
         WHERE connector_id = $1 AND action_id = $2`,
        [connectorId, actionId],
      );
      return projection ?? null;
    },

    async enqueueV2Mutation(input) {
      return transaction(pool, async client => {
        await assertConnector(client, input.connectorId);
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${input.connectorId}:rymessage-action-v2-mutations`],
        );
        const digest = companionActionV2Digest(input.request);
        const [existing] = await rows<{ digest: string } & QueryResultRow>(
          client,
          `SELECT mutation_digest AS digest
           FROM rymessage_action_v2_outbound_mutations
           WHERE connector_id = $1 AND operation_id = $2`,
          [input.connectorId, input.request.operationId],
        );
        if (existing) {
          if (existing.digest !== digest) {
            throw new RyMessageActionPersistenceError(
              'OPERATION_DIGEST_CONFLICT',
              'ActionV2 operation identity was reused with different content',
            );
          }
          return 'duplicate' as const;
        }
        const [queued] = await rows<{ count: string } & QueryResultRow>(
          client,
          `SELECT COUNT(*)::text AS count
           FROM rymessage_action_v2_outbound_mutations
           WHERE connector_id = $1 AND status IN ('pending', 'retry', 'leased')`,
          [input.connectorId],
        );
        if (Number(queued?.count ?? 0) >= RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE) {
          throw new RyMessageActionPersistenceError(
            'OUTBOUND_QUOTA_EXCEEDED',
            'ActionV2 mutation queue quota exceeded',
          );
        }
        await client.query(
          `INSERT INTO rymessage_action_v2_outbound_mutations (
             connector_id, operation_id, action_id, mutation, mutation_digest,
             status, available_at, attempt_count, created_at, updated_at
           ) VALUES ($1, $2, $3, $4::jsonb, $5, 'pending', $6, 0, $6, $6)`,
          [
            input.connectorId,
            input.request.operationId,
            input.request.actionId,
            JSON.stringify(input.request),
            digest,
            input.now,
          ],
        );
        return 'queued' as const;
      });
    },

    async leaseV2Mutations(input) {
      return transaction(pool, async client => {
        await assertConnector(client, input.connectorId);
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(
          Date.parse(input.now) + clampLeaseSeconds(input.leaseSeconds) * 1_000,
        ).toISOString();
        const leased = await rows<{
          connectorId: string; operationId: string; actionId: string;
          request: CompanionActionMutationRequestV2; mutationDigest: string;
          attemptCount: number;
        } & QueryResultRow>(
          client,
          `WITH candidates AS (
             SELECT connector_id, operation_id
             FROM rymessage_action_v2_outbound_mutations
             WHERE connector_id = $1
               AND status IN ('pending', 'retry', 'leased')
               AND available_at <= $2
               AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
             ORDER BY created_at, operation_id
             FOR UPDATE SKIP LOCKED
             LIMIT $3
           )
           UPDATE rymessage_action_v2_outbound_mutations AS mutation
           SET status = 'leased', lease_id = $4, lease_expires_at = $5,
               attempt_count = mutation.attempt_count + 1, updated_at = $2
           FROM candidates
           WHERE mutation.connector_id = candidates.connector_id
             AND mutation.operation_id = candidates.operation_id
           RETURNING mutation.connector_id AS "connectorId",
                     mutation.operation_id AS "operationId",
                     mutation.action_id AS "actionId",
                     mutation.mutation AS request,
                     mutation.mutation_digest AS "mutationDigest",
                     mutation.attempt_count AS "attemptCount"`,
          [
            input.connectorId,
            input.now,
            clampLeaseItems(input.limit),
            leaseId,
            leaseExpiresAt,
          ],
        );
        return { leaseId, leaseExpiresAt, items: leased };
      });
    },

    async settleV2Mutation(input) {
      return transaction(pool, async client => {
        const [leased] = await rows<{
          attemptCount: number;
          actionId: string;
        } & QueryResultRow>(
          client,
          `SELECT attempt_count AS "attemptCount", action_id AS "actionId"
           FROM rymessage_action_v2_outbound_mutations
           WHERE connector_id = $1 AND operation_id = $2
             AND lease_id = $3 AND status = 'leased'
           FOR UPDATE`,
          [input.connectorId, input.operationId, input.leaseId],
        );
        if (!leased) return false;
        if (
          input.receipt
          && (
            input.receipt.operationId !== input.operationId
            || input.receipt.actionId !== leased.actionId
          )
        ) {
          throw new RyMessageActionPersistenceError(
            'RECEIPT_IDENTITY_MISMATCH',
            'ActionV2 receipt does not match the leased operation',
          );
        }
        const status = input.receipt
          ? input.receipt.outcome === 'conflict' ? 'conflict' : 'succeeded'
          : input.retryable && leased.attemptCount < RYMESSAGE_ACTION_MAX_ATTEMPTS
            ? 'retry'
            : 'dead-letter';
        await client.query(
          `UPDATE rymessage_action_v2_outbound_mutations
           SET status = $1, lease_id = NULL, lease_expires_at = NULL,
               available_at = $2, receipt = $3::jsonb, last_error_code = $4,
               updated_at = $5
           WHERE connector_id = $6 AND operation_id = $7 AND lease_id = $8`,
          [
            status,
            status === 'retry'
              ? retryAt(input.now, leased.attemptCount)
              : input.now,
            input.receipt ? JSON.stringify(input.receipt) : null,
            input.errorCode ?? null,
            input.now,
            input.connectorId,
            input.operationId,
            input.leaseId,
          ],
        );
        return true;
      });
    },

    async invalidateV2Recovery(input) {
      await assertConnector(pool, input.connectorId);
      await pool.query(
        `UPDATE rymessage_action_v2_feed_state
         SET feed_id = NULL, cursor = NULL,
             recovery_generation = recovery_generation + 1,
             recovery_required = true, full_sync_generation = NULL,
             last_error = $1, updated_at = $2
         WHERE connector_id = $3`,
        [input.reason.slice(0, 256), input.now, input.connectorId],
      );
    },

  };
}
