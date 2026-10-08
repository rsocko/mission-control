import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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
} from './rymessage-actions';

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
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

export function createSqliteRyMessageActionRepository(
  database: Database.Database,
): RyMessageActionPersistence {
  function immediate<T>(work: () => T): T {
    return database.transaction(work).immediate();
  }

  function assertConnector(connectorId: string): void {
    const row = database.prepare(`
      SELECT type, enabled, deleted_at AS deletedAt
      FROM connector_configs WHERE id = ?
    `).get(connectorId) as {
      type: string;
      enabled: number;
      deletedAt: string | null;
    } | undefined;
    if (!row || row.deletedAt || row.type !== 'rymessage') {
      throw new RyMessageActionPersistenceError(
        'CONNECTOR_NOT_FOUND',
        'RyMessage connector not found',
      );
    }
    if (row.enabled !== 1) {
      throw new RyMessageActionPersistenceError(
        'CONNECTOR_DISABLED',
        'RyMessage connector is disabled',
      );
    }
  }

  return {
    async readV2FeedState(connectorId) {
      return immediate(() => {
        assertConnector(connectorId);
        const now = new Date().toISOString();
        database.prepare(`
          INSERT INTO rymessage_action_v2_feed_state (
            connector_id, recovery_generation, recovery_required, created_at, updated_at
          ) VALUES (?, 0, 1, ?, ?)
          ON CONFLICT(connector_id) DO NOTHING
        `).run(connectorId, now, now);
        const row = database.prepare(`
          SELECT connector_id AS connectorId, feed_id AS feedId, cursor,
                 recovery_generation AS recoveryGeneration,
                 recovery_required AS recoveryRequired,
                 full_sync_generation AS fullSyncGeneration,
                 last_synced_at AS lastSyncedAt, last_error AS lastError
          FROM rymessage_action_v2_feed_state WHERE connector_id = ?
        `).get(connectorId) as {
          connectorId: string; feedId: string | null; cursor: string | null;
          recoveryGeneration: number; recoveryRequired: number;
          fullSyncGeneration: string | null;
          lastSyncedAt: string | null; lastError: string | null;
        };
        return { ...row, recoveryRequired: row.recoveryRequired === 1 };
      });
    },

    async applyV2FeedPage(command) {
      return immediate(() => {
        assertConnector(command.connectorId);
        const state = database.prepare(`
          SELECT feed_id AS feedId, cursor,
                 recovery_required AS recoveryRequired,
                 full_sync_generation AS fullSyncGeneration
          FROM rymessage_action_v2_feed_state WHERE connector_id = ?
        `).get(command.connectorId) as {
          feedId: string | null;
          cursor: string | null;
          recoveryRequired: number;
          fullSyncGeneration: string | null;
        } | undefined;
        if (!state || state.cursor !== command.requestedCursor) {
          throw new RyMessageActionPersistenceError('CURSOR_RACE', 'ActionV2 cursor changed');
        }
        if (state.feedId && state.feedId !== command.page.feedId) {
          throw new RyMessageActionPersistenceError(
            'FEED_IDENTITY_CHANGED',
            'ActionV2 feed identity changed',
          );
        }
        if (state.recoveryRequired === 1 && command.page.mode !== 'full') {
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
          const receipt = database.prepare(`
            SELECT payload_digest AS payloadDigest
            FROM rymessage_action_v2_receipts
            WHERE connector_id = ? AND event_id = ?
          `).get(command.connectorId, item.eventId) as { payloadDigest: string } | undefined;
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
          const existing = database.prepare(`
            SELECT revision, payload_digest AS payloadDigest
            FROM rymessage_action_v2_projections
            WHERE connector_id = ? AND action_id = ?
          `).get(command.connectorId, item.aggregateId) as {
            revision: number; payloadDigest: string;
          } | undefined;
          if (
            existing
            && existing.revision === item.aggregateVersion
            && existing.payloadDigest !== digest
            && !(
              command.page.mode === 'full'
              && (state.recoveryRequired === 1 || state.fullSyncGeneration !== null)
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
            database.prepare(`
              INSERT INTO rymessage_action_v2_projections (
                connector_id, action_id, source_id, revision, payload, payload_digest,
                last_event_id, last_operation_id, last_seen_generation,
                tombstoned_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(connector_id, action_id) DO UPDATE SET
                source_id = excluded.source_id,
                revision = excluded.revision,
                payload = excluded.payload,
                payload_digest = excluded.payload_digest,
                last_event_id = excluded.last_event_id,
                last_operation_id = excluded.last_operation_id,
                last_seen_generation = excluded.last_seen_generation,
                tombstoned_at = excluded.tombstoned_at,
                updated_at = excluded.updated_at
            `).run(
              command.connectorId,
              item.aggregateId,
              item.sourceId,
              item.aggregateVersion,
              item.kind === 'upsert' ? JSON.stringify(item) : null,
              digest,
              item.eventId,
              item.operationId,
              fullSyncGeneration,
              item.kind === 'tombstone' ? item.occurredAt : null,
              command.receivedAt,
              command.receivedAt,
            );
            applied++;
          }
          database.prepare(`
            INSERT INTO rymessage_action_v2_receipts (
              connector_id, event_id, operation_id, action_id, aggregate_revision,
              payload_digest, outcome, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            command.connectorId,
            item.eventId,
            item.operationId,
            item.aggregateId,
            item.aggregateVersion,
            digest,
            outcome,
            command.receivedAt,
          );
        }
        if (command.page.mode === 'full' && command.page.complete) {
          database.prepare(`
            UPDATE rymessage_action_v2_projections
            SET payload = NULL, tombstoned_at = ?, updated_at = ?
            WHERE connector_id = ?
              AND tombstoned_at IS NULL
              AND (last_seen_generation IS NULL OR last_seen_generation <> ?)
          `).run(
            command.receivedAt,
            command.receivedAt,
            command.connectorId,
            fullSyncGeneration,
          );
        }
        const liveCount = database.prepare(`
          SELECT COUNT(*) AS count
          FROM rymessage_action_v2_projections
          WHERE connector_id = ? AND tombstoned_at IS NULL
        `).get(command.connectorId) as { count: number };
        if (liveCount.count > RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS) {
          throw new RyMessageActionPersistenceError(
            'LIVE_QUOTA_EXCEEDED',
            'ActionV2 live projection quota exceeded',
          );
        }
        database.prepare(`
          DELETE FROM rymessage_action_v2_projections
          WHERE connector_id = ? AND action_id IN (
            SELECT action_id
            FROM rymessage_action_v2_projections
            WHERE connector_id = ? AND tombstoned_at IS NOT NULL
            ORDER BY tombstoned_at DESC, action_id DESC
            LIMIT -1 OFFSET ?
          )
        `).run(
          command.connectorId,
          command.connectorId,
          RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS,
        );
        database.prepare(`
          DELETE FROM rymessage_action_v2_receipts
          WHERE connector_id = ? AND event_id IN (
            SELECT event_id
            FROM rymessage_action_v2_receipts
            WHERE connector_id = ?
            ORDER BY received_at DESC, event_id DESC
            LIMIT -1 OFFSET ?
          )
        `).run(
          command.connectorId,
          command.connectorId,
          RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS,
        );
        database.prepare(`
          UPDATE rymessage_action_v2_feed_state
          SET feed_id = ?, cursor = ?, recovery_required = ?,
              full_sync_generation = ?,
              last_synced_at = ?, last_error = NULL, updated_at = ?
          WHERE connector_id = ?
        `).run(
          command.page.feedId,
          command.page.nextCursor,
          command.page.mode === 'full' && !command.page.complete ? 1 : 0,
          command.page.mode === 'full' && !command.page.complete
            ? fullSyncGeneration
            : null,
          command.receivedAt,
          command.receivedAt,
          command.connectorId,
        );
        return { applied, replayed };
      });
    },

    async listV2Projections(connectorId) {
      assertConnector(connectorId);
      const rows = database.prepare(`
        SELECT connector_id AS connectorId, action_id AS actionId, source_id AS sourceId,
               revision, payload, tombstoned_at AS tombstonedAt
        FROM rymessage_action_v2_projections
        WHERE connector_id = ? ORDER BY action_id
      `).all(connectorId) as Array<{
        connectorId: string; actionId: string; sourceId: string; revision: number;
        payload: string | null; tombstonedAt: string | null;
      }>;
      return rows.map(row => ({
        ...row,
        item: parseJson<CompanionActionFeedItemV2>(row.payload),
      }));
    },

    async getV2Projection(connectorId, actionId) {
      assertConnector(connectorId);
      const row = database.prepare(`
        SELECT connector_id AS connectorId, action_id AS actionId, source_id AS sourceId,
               revision, payload, tombstoned_at AS tombstonedAt
        FROM rymessage_action_v2_projections
        WHERE connector_id = ? AND action_id = ?
      `).get(connectorId, actionId) as {
        connectorId: string; actionId: string; sourceId: string; revision: number;
        payload: string | null; tombstonedAt: string | null;
      } | undefined;
      return row ? {
        ...row,
        item: parseJson<CompanionActionFeedItemV2>(row.payload),
      } : null;
    },

    async enqueueV2Mutation(input) {
      return immediate(() => {
        assertConnector(input.connectorId);
        const digest = companionActionV2Digest(input.request);
        const existing = database.prepare(`
          SELECT mutation_digest AS digest
          FROM rymessage_action_v2_outbound_mutations
          WHERE connector_id = ? AND operation_id = ?
        `).get(input.connectorId, input.request.operationId) as { digest: string } | undefined;
        if (existing) {
          if (existing.digest !== digest) {
            throw new RyMessageActionPersistenceError(
              'OPERATION_DIGEST_CONFLICT',
              'ActionV2 operation identity was reused with different content',
            );
          }
          return 'duplicate' as const;
        }
        const queued = database.prepare(`
          SELECT COUNT(*) AS count
          FROM rymessage_action_v2_outbound_mutations
          WHERE connector_id = ? AND status IN ('pending', 'retry', 'leased')
        `).get(input.connectorId) as { count: number };
        if (queued.count >= RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE) {
          throw new RyMessageActionPersistenceError(
            'OUTBOUND_QUOTA_EXCEEDED',
            'ActionV2 mutation queue quota exceeded',
          );
        }
        database.prepare(`
          INSERT INTO rymessage_action_v2_outbound_mutations (
            connector_id, operation_id, action_id, mutation, mutation_digest,
            status, available_at, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
        `).run(
          input.connectorId,
          input.request.operationId,
          input.request.actionId,
          JSON.stringify(input.request),
          digest,
          input.now,
          input.now,
          input.now,
        );
        return 'queued' as const;
      });
    },

    async leaseV2Mutations(input) {
      return immediate(() => {
        assertConnector(input.connectorId);
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(
          Date.parse(input.now) + clampLeaseSeconds(input.leaseSeconds) * 1_000,
        ).toISOString();
        const rows = database.prepare(`
          SELECT operation_id AS operationId
          FROM rymessage_action_v2_outbound_mutations
          WHERE connector_id = ?
            AND status IN ('pending', 'retry', 'leased')
            AND available_at <= ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          ORDER BY created_at, operation_id
          LIMIT ?
        `).all(
          input.connectorId,
          input.now,
          input.now,
          clampLeaseItems(input.limit),
        ) as Array<{ operationId: string }>;
        for (const row of rows) {
          database.prepare(`
            UPDATE rymessage_action_v2_outbound_mutations
            SET status = 'leased', lease_id = ?, lease_expires_at = ?,
                attempt_count = attempt_count + 1, updated_at = ?
            WHERE connector_id = ? AND operation_id = ?
          `).run(
            leaseId,
            leaseExpiresAt,
            input.now,
            input.connectorId,
            row.operationId,
          );
        }
        const items = rows.map(row => {
          const leased = database.prepare(`
            SELECT connector_id AS connectorId, operation_id AS operationId,
                   action_id AS actionId, mutation, mutation_digest AS mutationDigest,
                   attempt_count AS attemptCount
            FROM rymessage_action_v2_outbound_mutations
            WHERE connector_id = ? AND operation_id = ?
          `).get(input.connectorId, row.operationId) as {
            connectorId: string; operationId: string; actionId: string;
            mutation: string; mutationDigest: string; attemptCount: number;
          };
          return {
            ...leased,
            request: JSON.parse(leased.mutation) as CompanionActionMutationRequestV2,
          };
        });
        return { leaseId, leaseExpiresAt, items };
      });
    },

    async settleV2Mutation(input) {
      return immediate(() => {
        const row = database.prepare(`
          SELECT attempt_count AS attemptCount, action_id AS actionId
          FROM rymessage_action_v2_outbound_mutations
          WHERE connector_id = ? AND operation_id = ? AND lease_id = ? AND status = 'leased'
        `).get(input.connectorId, input.operationId, input.leaseId) as {
          attemptCount: number;
          actionId: string;
        } | undefined;
        if (!row) return false;
        if (
          input.receipt
          && (
            input.receipt.operationId !== input.operationId
            || input.receipt.actionId !== row.actionId
          )
        ) {
          throw new RyMessageActionPersistenceError(
            'RECEIPT_IDENTITY_MISMATCH',
            'ActionV2 receipt does not match the leased operation',
          );
        }
        const status = input.receipt
          ? input.receipt.outcome === 'conflict' ? 'conflict' : 'succeeded'
          : input.retryable && row.attemptCount < RYMESSAGE_ACTION_MAX_ATTEMPTS
            ? 'retry'
            : 'dead-letter';
        database.prepare(`
          UPDATE rymessage_action_v2_outbound_mutations
          SET status = ?, lease_id = NULL, lease_expires_at = NULL,
              available_at = ?, receipt = ?, last_error_code = ?, updated_at = ?
          WHERE connector_id = ? AND operation_id = ? AND lease_id = ?
        `).run(
          status,
          status === 'retry' ? retryAt(input.now, row.attemptCount) : input.now,
          input.receipt ? JSON.stringify(input.receipt) : null,
          input.errorCode ?? null,
          input.now,
          input.connectorId,
          input.operationId,
          input.leaseId,
        );
        return true;
      });
    },

    async invalidateV2Recovery(input) {
      immediate(() => {
        assertConnector(input.connectorId);
        database.prepare(`
          UPDATE rymessage_action_v2_feed_state
          SET feed_id = NULL, cursor = NULL,
              recovery_generation = recovery_generation + 1,
              recovery_required = 1, full_sync_generation = NULL,
              last_error = ?, updated_at = ?
          WHERE connector_id = ?
        `).run(input.reason.slice(0, 256), input.now, input.connectorId);
      });
    },

  };
}
