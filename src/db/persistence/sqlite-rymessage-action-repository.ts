import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  companionActionDigest,
  sanitizeCompanionAction,
  stableCompanionOperationId,
  type CompanionActionMutation,
  type PortableCompanionAction,
} from '@/lib/connectors/rymessage/action-contract';
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
  RYMESSAGE_ACTION_MAX_OBSERVATIONS_PER_RECONCILE,
  RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE,
  RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS,
  RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS,
  RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS,
  RyMessageActionPersistenceError,
  assertCompanionMutationRevisionFence,
  type RyMessageActionPersistence,
  type RyMessageActionProjection,
  type RyMessageFeedState,
  type RyMessageLeasedMutation,
} from './rymessage-actions';

interface FeedStateRow {
  connectorId: string;
  feedId: string | null;
  cursor: string | null;
  recoveryGeneration: number;
  recoveryRequired: number;
  fullSyncGeneration: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface ProjectionRow {
  connectorId: string;
  actionId: string;
  sourceId: string;
  revision: number;
  payload: string | null;
  payloadDigest: string;
  tombstonedAt: string | null;
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}

function feedState(row: FeedStateRow): RyMessageFeedState {
  return {
    ...row,
    recoveryRequired: row.recoveryRequired === 1,
  };
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

  function ensureFeedState(connectorId: string, now: string): FeedStateRow {
    database.prepare(`
      INSERT INTO rymessage_action_feed_state (
        connector_id, recovery_generation, recovery_required, created_at, updated_at
      ) VALUES (?, 0, 1, ?, ?)
      ON CONFLICT(connector_id) DO NOTHING
    `).run(connectorId, now, now);
    return database.prepare(`
      SELECT connector_id AS connectorId, feed_id AS feedId, cursor,
             recovery_generation AS recoveryGeneration,
             recovery_required AS recoveryRequired,
             full_sync_generation AS fullSyncGeneration,
             last_synced_at AS lastSyncedAt, last_error AS lastError
      FROM rymessage_action_feed_state WHERE connector_id = ?
    `).get(connectorId) as FeedStateRow;
  }

  function readProjection(
    connectorId: string,
    actionId: string,
  ): ProjectionRow | undefined {
    return database.prepare(`
      SELECT connector_id AS connectorId, action_id AS actionId, source_id AS sourceId,
             revision, payload, payload_digest AS payloadDigest,
             tombstoned_at AS tombstonedAt
      FROM rymessage_action_projections
      WHERE connector_id = ? AND action_id = ?
    `).get(connectorId, actionId) as ProjectionRow | undefined;
  }

  function enqueueMutation(input: {
    connectorId: string;
    actionId: string;
    operationId: string;
    baseRevision: number;
    expectedFieldRevisions: Readonly<Record<string, number>>;
    mutation: CompanionActionMutation;
    now: string;
  }): 'queued' | 'duplicate' {
    const mutationJson = JSON.stringify(input.mutation);
    const digest = companionActionDigest({
      actionId: input.actionId,
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    });
    const existing = database.prepare(`
      SELECT mutation_digest AS mutationDigest
      FROM rymessage_action_outbound_mutations
      WHERE connector_id = ? AND operation_id = ?
    `).get(input.connectorId, input.operationId) as { mutationDigest: string } | undefined;
    if (existing) {
      if (existing.mutationDigest !== digest) {
        throw new RyMessageActionPersistenceError(
          'IDEMPOTENCY_CONFLICT',
          'Mutation identity was reused with different content',
        );
      }
      return 'duplicate';
    }
    const queued = database.prepare(`
      SELECT COUNT(*) AS count
      FROM rymessage_action_outbound_mutations
      WHERE connector_id = ? AND status IN ('pending', 'retry', 'leased')
    `).get(input.connectorId) as { count: number };
    if (queued.count >= RYMESSAGE_ACTION_MAX_OUTBOUND_QUEUE) {
      throw new RyMessageActionPersistenceError(
        'OUTBOUND_QUOTA_EXCEEDED',
        'RyMessage mutation queue quota exceeded',
      );
    }
    database.prepare(`
      INSERT INTO rymessage_action_outbound_mutations (
        connector_id, operation_id, action_id, base_revision,
        expected_field_revisions, mutation, mutation_digest, status,
        available_at, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
    `).run(
      input.connectorId,
      input.operationId,
      input.actionId,
      input.baseRevision,
      JSON.stringify(input.expectedFieldRevisions),
      mutationJson,
      digest,
      input.now,
      input.now,
      input.now,
    );
    return 'queued';
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
            const storedItem = item.kind === 'upsert'
              ? {
                  ...item,
                  action: sanitizeCompanionAction(item.action),
                  projection: {
                    ...item.projection,
                    action: sanitizeCompanionAction(item.projection.action),
                  },
                }
              : item;
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
              item.kind === 'upsert' ? JSON.stringify(storedItem) : null,
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

    async readFeedState(connectorId) {
      return immediate(() => {
        assertConnector(connectorId);
        return feedState(ensureFeedState(connectorId, new Date().toISOString()));
      });
    },

    async applyFeedPage(command) {
      return immediate(() => {
        assertConnector(command.connectorId);
        const state = ensureFeedState(command.connectorId, command.receivedAt);
        if (state.cursor !== command.requestedCursor) {
          throw new RyMessageActionPersistenceError(
            'CURSOR_RACE',
            'RyMessage feed cursor changed during page processing',
          );
        }
        if (
          state.recoveryRequired === 1
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
          && state.recoveryRequired === 1;
        const generation = command.page.mode === 'full'
          ? state.fullSyncGeneration ?? randomUUID()
          : state.fullSyncGeneration;

        for (const item of command.page.items) {
          if (item.kind !== 'upsert') continue;
          const receipt = database.prepare(`
            SELECT payload_digest AS payloadDigest
            FROM rymessage_action_receipts
            WHERE connector_id = ? AND event_id = ?
          `).get(command.connectorId, item.eventId) as { payloadDigest: string } | undefined;
          if (receipt) continue;
          const existing = readProjection(command.connectorId, item.aggregateId);
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
            database.prepare(`
              UPDATE rymessage_action_feed_state
              SET recovery_required = 1, last_error = ?, updated_at = ?
              WHERE connector_id = ?
            `).run(reason, command.receivedAt, command.connectorId);
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

        let applied = 0;
        let added = 0;
        let updated = 0;
        let ignored = 0;
        let tombstoned = 0;
        let conflicts = 0;

        for (const item of command.page.items) {
          const digest = companionActionDigest(item);
          const receipt = database.prepare(`
            SELECT operation_id AS operationId, action_id AS actionId,
                   aggregate_revision AS aggregateRevision,
                   payload_digest AS payloadDigest
            FROM rymessage_action_receipts
            WHERE connector_id = ? AND event_id = ?
          `).get(command.connectorId, item.eventId) as {
            operationId: string;
            actionId: string;
            aggregateRevision: number;
            payloadDigest: string;
          } | undefined;
          const existing = readProjection(command.connectorId, item.aggregateId);
          if (receipt) {
            if (
              receipt.operationId !== item.operationId
              || receipt.actionId !== item.aggregateId
              || receipt.aggregateRevision !== item.aggregateVersion
              || receipt.payloadDigest !== digest
            ) {
              throw new RyMessageActionPersistenceError(
                'EVENT_IDENTITY_CONFLICT',
                'Companion event identity was reused with different content',
              );
            }
            if (command.page.mode === 'full' && generation && item.kind === 'upsert') {
              const projectionDigest = companionActionDigest(
                sanitizeCompanionAction(item.action),
              );
              if (
                existing?.payload
                && !existing.tombstonedAt
                && existing.revision === item.aggregateVersion
                && existing.payloadDigest === projectionDigest
              ) {
                database.prepare(`
                  UPDATE rymessage_action_projections
                  SET last_seen_generation = ?
                  WHERE connector_id = ? AND action_id = ?
                `).run(generation, command.connectorId, item.aggregateId);
                ignored++;
                continue;
              }
              if (existing && !existing.tombstonedAt) {
                throw new RyMessageActionPersistenceError(
                  'EVENT_PROJECTION_CONFLICT',
                  'Companion event replay does not match the live projection',
                );
              }
            } else {
              ignored++;
              continue;
            }
          }

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
                const live = database.prepare(`
                  SELECT COUNT(*) AS count
                  FROM rymessage_action_projections
                  WHERE connector_id = ? AND tombstoned_at IS NULL
                `).get(command.connectorId) as { count: number };
                if (live.count >= RYMESSAGE_ACTION_MAX_LIVE_PROJECTIONS) {
                  throw new RyMessageActionPersistenceError(
                    'PROJECTION_QUOTA_EXCEEDED',
                    'RyMessage action projection quota exceeded',
                  );
                }
              }
              database.prepare(`
                INSERT INTO rymessage_action_projections (
                  connector_id, action_id, source_id, stable_key, revision, payload,
                  payload_digest, last_event_id, last_operation_id,
                  last_seen_generation, tombstoned_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                ON CONFLICT(connector_id, action_id) DO UPDATE SET
                  source_id = excluded.source_id,
                  stable_key = excluded.stable_key,
                  revision = excluded.revision,
                  payload = excluded.payload,
                  payload_digest = excluded.payload_digest,
                  last_event_id = excluded.last_event_id,
                  last_operation_id = excluded.last_operation_id,
                  last_seen_generation = excluded.last_seen_generation,
                  tombstoned_at = NULL,
                  updated_at = excluded.updated_at
              `).run(
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
                command.receivedAt,
              );

              const observedMaterializationIds = new Set<string>();
              for (const relation of item.action.materializations) {
                observedMaterializationIds.add(relation.materializationId);
                const current = database.prepare(`
                  SELECT local_task_id AS localTaskId, relation_state AS relationState
                  FROM rymessage_action_materializations
                  WHERE connector_id = ? AND materialization_id = ?
                `).get(command.connectorId, relation.materializationId) as {
                  localTaskId: string | null;
                  relationState: string;
                } | undefined;
                database.prepare(`
                  INSERT INTO rymessage_action_materializations (
                    connector_id, materialization_id, action_id, action_revision,
                    revision, provider, provider_account_id, provider_list_id,
                    provider_task_id, state, provider_task_status_snapshot,
                    provider_version_snapshot, last_observed_at, local_task_id,
                    relation_state, conflict_code, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                  ON CONFLICT(connector_id, materialization_id) DO UPDATE SET
                    action_id = excluded.action_id,
                    action_revision = excluded.action_revision,
                    revision = excluded.revision,
                    state = excluded.state,
                    provider_task_status_snapshot = excluded.provider_task_status_snapshot,
                    provider_version_snapshot = excluded.provider_version_snapshot,
                    last_observed_at = excluded.last_observed_at,
                    relation_state = CASE
                      WHEN excluded.state = 'deleted' THEN 'deleted'
                      WHEN excluded.state = 'link-broken' THEN 'link-broken'
                      ELSE rymessage_action_materializations.relation_state
                    END,
                    updated_at = excluded.updated_at
                `).run(
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
                  current?.localTaskId ?? null,
                  relation.state === 'deleted'
                    ? 'deleted'
                    : relation.state === 'link-broken'
                      ? 'link-broken'
                      : current?.relationState ?? 'pending-import',
                  command.receivedAt,
                  command.receivedAt,
                );
              }
              const known = database.prepare(`
                SELECT materialization_id AS materializationId
                FROM rymessage_action_materializations
                WHERE connector_id = ? AND action_id = ?
              `).all(command.connectorId, item.action.actionId) as Array<{
                materializationId: string;
              }>;
              for (const relation of known) {
                if (observedMaterializationIds.has(relation.materializationId)) continue;
                database.prepare(`
                  UPDATE rymessage_action_materializations
                  SET relation_state = 'link-broken', conflict_code = 'RELATION_REMOVED',
                      updated_at = ?
                  WHERE connector_id = ? AND materialization_id = ?
                `).run(
                  command.receivedAt,
                  command.connectorId,
                  relation.materializationId,
                );
              }
              applied++;
              if (existing) updated++;
              else added++;
              outcome = 'applied';
            }
          } else if (!existing || item.aggregateVersion >= existing.revision) {
            database.prepare(`
              INSERT INTO rymessage_action_projections (
                connector_id, action_id, source_id, revision, payload,
                payload_digest, last_event_id, last_operation_id,
                last_seen_generation, tombstoned_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(connector_id, action_id) DO UPDATE SET
                revision = excluded.revision,
                payload = NULL,
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
              digest,
              item.eventId,
              item.operationId,
              generation,
              item.occurredAt,
              command.receivedAt,
              command.receivedAt,
            );
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET relation_state = 'deleted', conflict_code = 'ACTION_TOMBSTONED',
                  updated_at = ?
              WHERE connector_id = ? AND action_id = ?
            `).run(command.receivedAt, command.connectorId, item.aggregateId);
            tombstoned++;
            outcome = 'tombstoned';
          } else {
            ignored++;
            outcome = 'stale';
          }

          database.prepare(`
            INSERT INTO rymessage_action_receipts (
              connector_id, event_id, operation_id, action_id, aggregate_revision,
              payload_digest, outcome, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(connector_id, event_id) DO NOTHING
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

        let recoveryCompleted = false;
        if (command.page.mode === 'full' && command.page.complete && generation) {
          const missing = database.prepare(`
            SELECT action_id AS actionId
            FROM rymessage_action_projections
            WHERE connector_id = ? AND tombstoned_at IS NULL
              AND (last_seen_generation IS NULL OR last_seen_generation != ?)
          `).all(command.connectorId, generation) as Array<{ actionId: string }>;
          for (const row of missing) {
            database.prepare(`
              UPDATE rymessage_action_projections
              SET payload = NULL, tombstoned_at = ?, updated_at = ?
              WHERE connector_id = ? AND action_id = ?
            `).run(command.receivedAt, command.receivedAt, command.connectorId, row.actionId);
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET relation_state = 'deleted', conflict_code = 'RECOVERY_OMISSION',
                  updated_at = ?
              WHERE connector_id = ? AND action_id = ?
            `).run(command.receivedAt, command.connectorId, row.actionId);
          }
          tombstoned += missing.length;
          recoveryCompleted = true;
        }

        const tombstoneCount = database.prepare(`
          SELECT COUNT(*) AS count
          FROM rymessage_action_projections
          WHERE connector_id = ? AND tombstoned_at IS NOT NULL
        `).get(command.connectorId) as { count: number };
        const tombstoneOverflow = tombstoneCount.count
          - RYMESSAGE_ACTION_MAX_TOMBSTONE_PROJECTIONS;
        const pruneTombstones = tombstoneOverflow > 0;
        const retentionRecoveryRequired = pruneTombstones
          && !(command.page.mode === 'full' && command.page.complete);
        if (pruneTombstones) {
          database.prepare(`
            DELETE FROM rymessage_action_materializations
            WHERE connector_id = ? AND action_id IN (
              SELECT action_id FROM rymessage_action_projections
              WHERE connector_id = ? AND tombstoned_at IS NOT NULL
              ORDER BY tombstoned_at, action_id LIMIT ?
            )
          `).run(command.connectorId, command.connectorId, tombstoneOverflow);
          database.prepare(`
            DELETE FROM rymessage_action_projections
            WHERE rowid IN (
              SELECT rowid FROM rymessage_action_projections
              WHERE connector_id = ? AND tombstoned_at IS NOT NULL
              ORDER BY tombstoned_at, action_id LIMIT ?
            )
          `).run(command.connectorId, tombstoneOverflow);
        }
        if (retentionRecoveryRequired) {
          database.prepare(`
            UPDATE rymessage_action_feed_state
            SET feed_id = NULL, cursor = NULL,
                recovery_generation = recovery_generation + 1,
                recovery_required = 1, full_sync_generation = NULL,
                last_synced_at = ?, last_error = 'TOMBSTONE_RETENTION_RECOVERY',
                updated_at = ?
            WHERE connector_id = ?
          `).run(command.receivedAt, command.receivedAt, command.connectorId);
        } else {
          database.prepare(`
            UPDATE rymessage_action_feed_state
            SET feed_id = ?, cursor = ?, recovery_required = ?,
                full_sync_generation = ?, last_synced_at = ?, last_error = NULL,
                updated_at = ?
            WHERE connector_id = ?
          `).run(
            command.page.feedId,
            command.page.nextCursor,
            recoveryCompleted ? 0 : state.recoveryRequired,
            recoveryCompleted ? null : generation,
            command.receivedAt,
            command.receivedAt,
            command.connectorId,
          );
        }

        const receiptCount = database.prepare(`
          SELECT COUNT(*) AS count FROM rymessage_action_receipts WHERE connector_id = ?
        `).get(command.connectorId) as { count: number };
        const overflow = receiptCount.count - RYMESSAGE_ACTION_MAX_RETAINED_RECEIPTS;
        if (overflow > 0) {
          database.prepare(`
            DELETE FROM rymessage_action_receipts WHERE rowid IN (
              SELECT rowid FROM rymessage_action_receipts
              WHERE connector_id = ? ORDER BY received_at, event_id LIMIT ?
            )
          `).run(command.connectorId, overflow);
        }

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
      immediate(() => {
        assertConnector(input.connectorId);
        ensureFeedState(input.connectorId, input.now);
        database.prepare(`
          UPDATE rymessage_action_feed_state
          SET feed_id = NULL, cursor = NULL, recovery_generation = recovery_generation + 1,
              recovery_required = 1, full_sync_generation = NULL,
              last_error = ?, updated_at = ?
          WHERE connector_id = ?
        `).run(input.reason.slice(0, 300), input.now, input.connectorId);
      });
    },

    async reconcileMaterializations(input) {
      return immediate(() => {
        assertConnector(input.connectorId);
        const relations = database.prepare(`
          SELECT materialization_id AS materializationId, action_id AS actionId,
                 action_revision AS actionRevision, provider_list_id AS providerListId,
                 provider_task_id AS providerTaskId, state, local_task_id AS localTaskId,
                 relation_state AS relationState, provider_task_status_snapshot AS statusSnapshot,
                 provider_version_snapshot AS versionSnapshot
          FROM rymessage_action_materializations
          WHERE connector_id = ?
          ORDER BY updated_at, materialization_id
          LIMIT ?
        `).all(input.connectorId, RYMESSAGE_ACTION_MAX_RECONCILE_ITEMS) as Array<{
          materializationId: string;
          actionId: string;
          actionRevision: number;
          providerListId: string;
          providerTaskId: string;
          state: string;
          localTaskId: string | null;
          relationState: string;
          statusSnapshot: string | null;
          versionSnapshot: string | null;
        }>;
        let linked = 0;
        let pendingImport = 0;
        let conflicts = 0;
        let broken = 0;
        let observationsQueued = 0;
        let observationCandidates = 0;

        for (const relation of relations) {
          if (relation.state === 'deleted') {
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET relation_state = 'deleted', updated_at = ?
              WHERE connector_id = ? AND materialization_id = ?
            `).run(input.now, input.connectorId, relation.materializationId);
            continue;
          }
          if (relation.state === 'link-broken') {
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET relation_state = 'link-broken', updated_at = ?
              WHERE connector_id = ? AND materialization_id = ?
            `).run(input.now, input.connectorId, relation.materializationId);
            broken++;
            continue;
          }
          const sourceId = `${relation.providerListId}:${relation.providerTaskId}`;
          const matches = database.prepare(`
            SELECT id, status, updated_at AS updatedAt, metadata
            FROM tasks
            WHERE connector_type = 'microsoft-todo' AND source_id = ?
              AND is_checklist_item = 0 AND deleted_at IS NULL
            ORDER BY connector_instance_id, id
            LIMIT 2
          `).all(sourceId) as Array<{
            id: string;
            status: string;
            updatedAt: string;
            metadata: string;
          }>;
          if (matches.length === 0) {
            const wasLinked = relation.localTaskId || relation.relationState === 'link-broken';
            const state = wasLinked ? 'link-broken' : 'pending-import';
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET local_task_id = NULL, relation_state = ?, conflict_code = ?,
                  updated_at = ?
              WHERE connector_id = ? AND materialization_id = ?
            `).run(
              state,
              wasLinked ? 'PROVIDER_TASK_MISSING' : null,
              input.now,
              input.connectorId,
              relation.materializationId,
            );
            if (wasLinked) broken++;
            else pendingImport++;
            continue;
          }
          if (matches.length > 1) {
            database.prepare(`
              UPDATE rymessage_action_materializations
              SET local_task_id = NULL, relation_state = 'conflict',
                  conflict_code = 'AMBIGUOUS_PROVIDER_IDENTITY', updated_at = ?
              WHERE connector_id = ? AND materialization_id = ?
            `).run(input.now, input.connectorId, relation.materializationId);
            conflicts++;
            continue;
          }

          const task = matches[0]!;
          database.prepare(`
            UPDATE rymessage_action_materializations
            SET local_task_id = ?, relation_state = 'linked',
                conflict_code = NULL, updated_at = ?
            WHERE connector_id = ? AND materialization_id = ?
          `).run(
            task.id,
            input.now,
            input.connectorId,
            relation.materializationId,
          );
          linked++;
          const status = task.status === 'done' ? 'completed' : task.status;
          if (
            relation.statusSnapshot !== status
            || relation.versionSnapshot !== task.updatedAt
          ) {
            if (observationCandidates >= RYMESSAGE_ACTION_MAX_OBSERVATIONS_PER_RECONCILE) {
              continue;
            }
            observationCandidates++;
            const projection = readProjection(input.connectorId, relation.actionId);
            const action = parseJson<PortableCompanionAction>(projection?.payload ?? null);
            if (action) {
              const operationId = stableCompanionOperationId(
                `${input.connectorId}:${relation.materializationId}:observe:${status}:${task.updatedAt}`,
              );
              const result = enqueueMutation({
                connectorId: input.connectorId,
                actionId: relation.actionId,
                operationId,
                baseRevision: action.revision,
                expectedFieldRevisions: {
                  [`materialization:${relation.materializationId}`]:
                    action.fieldRevisions[`materialization:${relation.materializationId}`] ?? 0,
                },
                mutation: {
                  kind: 'materialization.observe',
                  materializationId: relation.materializationId,
                  providerTaskStatusSnapshot: status,
                  providerVersionSnapshot: task.updatedAt,
                  observedAt: task.updatedAt,
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
      const row = readProjection(connectorId, actionId);
      if (!row) return null;
      return {
        connectorId: row.connectorId,
        actionId: row.actionId,
        sourceId: row.sourceId,
        revision: row.revision,
        action: parseJson<PortableCompanionAction>(row.payload),
        tombstonedAt: row.tombstonedAt,
      } satisfies RyMessageActionProjection;
    },

    async listProjections(connectorId) {
      return immediate(() => {
        assertConnector(connectorId);
        const rows = database.prepare(`
          SELECT connector_id AS connectorId, action_id AS actionId, source_id AS sourceId,
                 revision, payload, tombstoned_at AS tombstonedAt
          FROM rymessage_action_projections
          WHERE connector_id = ?
          ORDER BY action_id
        `).all(connectorId) as Array<{
          connectorId: string;
          actionId: string;
          sourceId: string;
          revision: number;
          payload: string | null;
          tombstonedAt: string | null;
        }>;
        return rows.map((row) => ({
          connectorId: row.connectorId,
          actionId: row.actionId,
          sourceId: row.sourceId,
          revision: row.revision,
          action: parseJson<PortableCompanionAction>(row.payload),
          tombstonedAt: row.tombstonedAt,
        }));
      });
    },

    async enqueueMutation(command) {
      return immediate(() => {
        assertConnector(command.connectorId);
        const digest = companionActionDigest({
          actionId: command.actionId,
          baseRevision: command.baseRevision,
          mutation: command.mutation,
        });
        const existingMutation = database.prepare(`
          SELECT mutation_digest AS mutationDigest
          FROM rymessage_action_outbound_mutations
          WHERE connector_id = ? AND operation_id = ?
        `).get(command.connectorId, command.operationId) as {
          mutationDigest: string;
        } | undefined;
        if (existingMutation) {
          if (existingMutation.mutationDigest !== digest) {
            throw new RyMessageActionPersistenceError(
              'IDEMPOTENCY_CONFLICT',
              'Mutation identity was reused with different content',
            );
          }
          return 'duplicate';
        }
        const projection = readProjection(command.connectorId, command.actionId);
        const action = parseJson<PortableCompanionAction>(projection?.payload ?? null);
        if (!projection || projection.tombstonedAt || !action) {
          throw new RyMessageActionPersistenceError(
            'ACTION_NOT_FOUND',
            'Canonical Companion action does not exist',
          );
        }
        assertCompanionMutationRevisionFence({
          action,
          baseRevision: command.baseRevision,
          expectedFieldRevisions: command.expectedFieldRevisions,
          mutation: command.mutation,
        });
        if (command.mutation.kind === 'materialization.observe') {
          const relation = database.prepare(`
            SELECT 1 FROM rymessage_action_materializations
            WHERE connector_id = ? AND action_id = ? AND materialization_id = ?
          `).get(
            command.connectorId,
            command.actionId,
            command.mutation.materializationId,
          );
          if (!relation) {
            throw new RyMessageActionPersistenceError(
              'MATERIALIZATION_NOT_FOUND',
              'Cannot observe an unknown materialization',
            );
          }
        }
        return enqueueMutation(command);
      });
    },

    async leaseMutations(input) {
      return immediate(() => {
        assertConnector(input.connectorId);
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(
          Date.parse(input.now) + clampLeaseSeconds(input.leaseSeconds) * 1_000,
        ).toISOString();
        database.prepare(`
          UPDATE rymessage_action_outbound_mutations
          SET status = 'retry', lease_id = NULL, lease_expires_at = NULL,
              available_at = ?, updated_at = ?
          WHERE connector_id = ? AND status = 'leased' AND lease_expires_at <= ?
        `).run(input.now, input.now, input.connectorId, input.now);
        const candidates = database.prepare(`
          SELECT operation_id AS operationId, action_id AS actionId,
                 base_revision AS baseRevision,
                 expected_field_revisions AS expectedFieldRevisions,
                 mutation, attempt_count AS attemptCount
          FROM rymessage_action_outbound_mutations
          WHERE connector_id = ? AND status IN ('pending', 'retry') AND available_at <= ?
          ORDER BY created_at, operation_id
          LIMIT ?
        `).all(
          input.connectorId,
          input.now,
          clampLeaseItems(input.limit),
        ) as Array<{
          operationId: string;
          actionId: string;
          baseRevision: number;
          expectedFieldRevisions: string;
          mutation: string;
          attemptCount: number;
        }>;
        const items: RyMessageLeasedMutation[] = [];
        for (const candidate of candidates) {
          const projection = readProjection(input.connectorId, candidate.actionId);
          const action = parseJson<PortableCompanionAction>(projection?.payload ?? null);
          if (!action) {
            database.prepare(`
              UPDATE rymessage_action_outbound_mutations
              SET status = 'conflict', last_error_code = 'ACTION_NOT_FOUND',
                  last_error = 'Canonical action is unavailable', updated_at = ?
              WHERE connector_id = ? AND operation_id = ?
            `).run(input.now, input.connectorId, candidate.operationId);
            continue;
          }
          const expected = parseJson<Record<string, number>>(
            candidate.expectedFieldRevisions,
          ) ?? {};
          const mutation = parseJson<CompanionActionMutation>(candidate.mutation)!;
          try {
            assertCompanionMutationRevisionFence({
              action,
              baseRevision: candidate.baseRevision,
              expectedFieldRevisions: expected,
              mutation,
            });
          } catch (error) {
            const persistenceError = error instanceof RyMessageActionPersistenceError
              ? error
              : null;
            database.prepare(`
              UPDATE rymessage_action_outbound_mutations
              SET status = 'conflict', last_error_code = ?,
                  last_error = ?, updated_at = ?
              WHERE connector_id = ? AND operation_id = ?
            `).run(
              persistenceError?.code ?? 'REVISION_FENCE_INVALID',
              persistenceError?.message.slice(0, 300) ?? 'Mutation revision fence is invalid',
              input.now,
              input.connectorId,
              candidate.operationId,
            );
            continue;
          }
          database.prepare(`
            UPDATE rymessage_action_outbound_mutations
            SET status = 'leased', lease_id = ?, lease_expires_at = ?,
                base_revision = ?, attempt_count = attempt_count + 1, updated_at = ?
            WHERE connector_id = ? AND operation_id = ?
          `).run(
            leaseId,
            leaseExpiresAt,
            action.revision,
            input.now,
            input.connectorId,
            candidate.operationId,
          );
          items.push({
            operationId: candidate.operationId,
            connectorId: input.connectorId,
            actionId: candidate.actionId,
            baseRevision: action.revision,
            expectedFieldRevisions: expected,
            mutation,
            attemptCount: candidate.attemptCount + 1,
          });
        }
        return { leaseId, leaseExpiresAt, items };
      });
    },

    async completeMutation(outcome) {
      immediate(() => {
        const row = database.prepare(`
          SELECT attempt_count AS attemptCount, action_id AS actionId
          FROM rymessage_action_outbound_mutations
          WHERE connector_id = ? AND operation_id = ? AND status = 'leased' AND lease_id = ?
        `).get(outcome.connectorId, outcome.operationId, outcome.leaseId) as {
          attemptCount: number;
          actionId: string;
        } | undefined;
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
            database.prepare(`
              UPDATE rymessage_action_outbound_mutations
              SET status = 'conflict', receipt = NULL, lease_id = NULL,
                  lease_expires_at = NULL,
                  last_error_code = 'RECEIPT_IDENTITY_MISMATCH',
                  last_error = 'Companion receipt does not match the leased mutation',
                  updated_at = ?
              WHERE connector_id = ? AND operation_id = ? AND lease_id = ?
            `).run(
              outcome.now,
              outcome.connectorId,
              outcome.operationId,
              outcome.leaseId,
            );
            return;
          }
          const status = outcome.receipt.outcome === 'conflict' ? 'conflict' : 'succeeded';
          database.prepare(`
            UPDATE rymessage_action_outbound_mutations
            SET status = ?, receipt = ?, lease_id = NULL, lease_expires_at = NULL,
                last_error_code = NULL, last_error = NULL, updated_at = ?
            WHERE connector_id = ? AND operation_id = ? AND lease_id = ?
          `).run(
            status,
            JSON.stringify(outcome.receipt),
            outcome.now,
            outcome.connectorId,
            outcome.operationId,
            outcome.leaseId,
          );
          return;
        }
        const status = outcome.retryable && row.attemptCount < RYMESSAGE_ACTION_MAX_ATTEMPTS
          ? 'retry'
          : 'dead-letter';
        database.prepare(`
          UPDATE rymessage_action_outbound_mutations
          SET status = ?, lease_id = NULL, lease_expires_at = NULL,
              available_at = ?, last_error_code = ?, last_error = ?, updated_at = ?
          WHERE connector_id = ? AND operation_id = ? AND lease_id = ?
        `).run(
          status,
          retryAt(outcome.now, row.attemptCount),
          outcome.errorCode?.slice(0, 100) ?? 'MUTATION_FAILED',
          outcome.errorMessage?.replace(/\s+/g, ' ').slice(0, 300) ?? 'Mutation failed',
          outcome.now,
          outcome.connectorId,
          outcome.operationId,
          outcome.leaseId,
        );
      });
    },

    async readStatus(connectorId) {
      return immediate(() => {
        assertConnector(connectorId);
        const state = feedState(ensureFeedState(connectorId, new Date().toISOString()));
        const counts = database.prepare(`
          SELECT
            (SELECT COUNT(*) FROM rymessage_action_projections
             WHERE connector_id = ? AND tombstoned_at IS NULL) AS projectionCount,
            (SELECT COUNT(*) FROM rymessage_action_materializations
             WHERE connector_id = ? AND relation_state = 'linked') AS linkedCount,
            (SELECT COUNT(*) FROM rymessage_action_materializations
             WHERE connector_id = ? AND relation_state = 'pending-import') AS pendingImportCount,
            (SELECT COUNT(*) FROM rymessage_action_materializations
             WHERE connector_id = ? AND relation_state = 'conflict') AS conflictCount,
            (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
             WHERE connector_id = ? AND status = 'conflict') AS mutationConflictCount,
            (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
             WHERE connector_id = ? AND status IN ('pending', 'retry', 'leased')) AS pendingWriteCount,
            (SELECT COUNT(*) FROM rymessage_action_outbound_mutations
             WHERE connector_id = ? AND status = 'dead-letter') AS deadLetterCount
        `).get(
          connectorId,
          connectorId,
          connectorId,
          connectorId,
          connectorId,
          connectorId,
          connectorId,
        ) as Omit<Awaited<ReturnType<RyMessageActionPersistence['readStatus']>>, 'feed'>;
        return { feed: state, ...counts };
      });
    },
  };
}
