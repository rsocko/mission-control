import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import { createSqliteFinanceWorkerPersistence } from '@/db/persistence/sqlite-finance-worker-repositories';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceWorkerPersistenceContract,
  type FinanceWorkerContractHarness,
} from '../contracts/finance-worker-persistence.contract';

const dataDirectory = resolve(process.cwd(), 'data');
const databasePath = resolve(
  dataDirectory,
  `finance-worker-contract-${process.pid}.db`,
);
let sqlite: Database.Database | null = null;

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function createHarness(): Promise<FinanceWorkerContractHarness> {
  if (!sqlite) {
    mkdirSync(dataDirectory, { recursive: true });
    rmSync(databasePath, { force: true });
    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  }
  const database = sqlite;
  const repositories = createSqliteFinanceWorkerPersistence(database, {
    idFactory: (() => {
      let id = 0;
      return () => `finance-contract-id-${++id}`;
    })(),
  });

  return {
    repositories,
    async reset() {
      database.prepare(
        `DELETE FROM finance_attribution_exceptions WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_attribution_subjects WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_transactions WHERE connector_instance_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_sync_state WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_accounts WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_category_groups WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_categories WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_tags WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_recurring_obligations WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_budget_snapshots WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(
        `DELETE FROM finance_dataset_sync_state WHERE connector_id = ?`,
      ).run(CONNECTOR_ID);
      database.prepare(`DELETE FROM connector_configs WHERE id = ?`).run(CONNECTOR_ID);
    },
    async seedConnector(credentials: unknown = {}) {
      database.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES (?, 'finance-manager', ?, 1, 'poll', '{}', ?, '{}', '[]', ?, ?)
      `).run(
        CONNECTOR_ID,
        CONNECTOR_ID,
        JSON.stringify(credentials),
        BASE_TIME,
        BASE_TIME,
      );
    },
    async credentials() {
      const row = database.prepare(
        `SELECT credentials FROM connector_configs WHERE id = ?`,
      ).get(CONNECTOR_ID) as { credentials: string };
      return parseJson(row.credentials) as Record<string, unknown>;
    },
    async transaction(upstreamId) {
      const row = database.prepare(`
        SELECT id, lifecycle_status AS lifecycleStatus,
               assigned_kid_id AS assignedKidId,
               kid_assignment_method AS kidAssignmentMethod,
               manual_decision_action AS manualDecisionAction,
               manual_decided_at AS manualDecidedAt,
               attribution_status AS attributionStatus,
               attribution_reasons AS attributionReasons,
               attribution_retryable AS attributionRetryable,
               is_pending AS isPending, tags, tag_references AS tagReferences,
               last_seen_at AS lastSeenAt
        FROM finance_transactions
        WHERE connector_instance_id = ? AND upstream_transaction_id = ?
      `).get(CONNECTOR_ID, upstreamId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        ...row,
        attributionReasons: parseJson(row.attributionReasons),
        attributionRetryable: row.attributionRetryable === 1,
        isPending: row.isPending === 1,
        tags: parseJson(row.tags),
        tagReferences: parseJson(row.tagReferences),
      } as Awaited<ReturnType<FinanceWorkerContractHarness['transaction']>>;
    },
    async transactionCount() {
      const row = database.prepare(`
        SELECT count(*) AS count FROM finance_transactions
        WHERE connector_instance_id = ?
      `).get(CONNECTOR_ID) as { count: number };
      return row.count;
    },
    async setManualDecision(input) {
      database.prepare(`
        UPDATE finance_transactions
        SET assigned_kid_id = ?, kid_assignment_method = 'manual',
            manual_decision_action = ?, manual_decided_at = ?,
            attribution_status = ?, attribution_confidence = 'definite',
            attribution_method = 'manual', attribution_decision_source = 'manual',
            attribution_review_state = 'resolved', attribution_retryable = 0
        WHERE connector_instance_id = ? AND upstream_transaction_id = ?
      `).run(
        input.kidId,
        input.action,
        input.decidedAt,
        input.action === 'assign-kid' ? 'attributed' : 'unassigned',
        CONNECTOR_ID,
        input.upstreamId,
      );
    },
    async syncState() {
      return (database.prepare(`
        SELECT status, current_generation_id AS generationId,
               last_successful_generation_id AS lastSuccessfulGenerationId,
               last_error_code AS lastErrorCode
        FROM finance_sync_state WHERE connector_id = ?
      `).get(CONNECTOR_ID) ?? null) as Awaited<
        ReturnType<FinanceWorkerContractHarness['syncState']>
      >;
    },
    async attributionException(upstreamId) {
      return (database.prepare(`
        SELECT occurrence_count AS occurrenceCount, status
        FROM finance_attribution_exceptions
        WHERE connector_id = ? AND transaction_id = ?
      `).get(CONNECTOR_ID, `finance:${CONNECTOR_ID}:${upstreamId}`) ?? null) as Awaited<
        ReturnType<FinanceWorkerContractHarness['attributionException']>
      >;
    },
    async referenceAccount() {
      const row = database.prepare(`
        SELECT id, is_active AS isActive, source_is_active AS sourceIsActive,
               institution
        FROM finance_accounts
        WHERE connector_id = ? AND upstream_account_id = 'account-1'
      `).get(CONNECTOR_ID) as {
        id: string;
        isActive: number;
        sourceIsActive: number;
        institution: string | null;
      } | undefined;
      return row
        ? {
            ...row,
            isActive: row.isActive === 1,
            sourceIsActive: row.sourceIsActive === 1,
          }
        : null;
    },
    async recurringGenerations() {
      const rows = database.prepare(`
        SELECT DISTINCT generation_id AS generationId, is_current AS isCurrent
        FROM finance_recurring_obligations
        WHERE connector_id = ?
        ORDER BY generation_id
      `).all(CONNECTOR_ID) as Array<{ generationId: string; isCurrent: number }>;
      return rows.map((row) => ({ ...row, isCurrent: row.isCurrent === 1 }));
    },
  };
}

describeFinanceWorkerPersistenceContract('SQLite', createHarness);

afterAll(() => {
  sqlite?.close();
  sqlite = null;
  rmSync(databasePath, { force: true });
});
