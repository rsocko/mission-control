import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import { createSqliteFinanceAssistantPersistence } from '@/db/persistence/sqlite-finance-assistant-repository';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceAssistantPersistenceContract,
  type FinanceAssistantContractHarness,
} from '../contracts/finance-assistant-persistence.contract';

vi.unmock('drizzle-orm');

const dataDirectory = resolve(process.cwd(), 'data');
const databasePath = resolve(
  dataDirectory,
  `finance-assistant-contract-${process.pid}.db`,
);
let sqlite: Database.Database | null = null;

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function createHarness(): Promise<FinanceAssistantContractHarness> {
  if (!sqlite) {
    mkdirSync(dataDirectory, { recursive: true });
    rmSync(databasePath, { force: true });
    sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  }
  const database = sqlite;
  const assistant = createSqliteFinanceAssistantPersistence(database, {
    idFactory: (() => {
      let id = 0;
      return () => `finance-assistant-contract-id-${++id}`;
    })(),
  });

  return {
    assistant,
    async reset() {
      for (const statement of [
        'DELETE FROM houston_finance_pending_approvals',
        'DELETE FROM houston_finance_action_audit',
        'DELETE FROM finance_attribution_audit',
        'DELETE FROM finance_attribution_exceptions',
        'DELETE FROM finance_attribution_subjects',
        'DELETE FROM finance_mutation_audit',
        'DELETE FROM finance_recurring_obligations',
        'DELETE FROM finance_transactions',
        'DELETE FROM finance_categories',
        'DELETE FROM finance_sync_state',
        'DELETE FROM kid_profiles',
        'DELETE FROM connector_configs',
      ]) {
        database.prepare(statement).run();
      }
    },
    async seedConnector(input = {}) {
      database.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
          credentials, settings, synced_lists, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'poll', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id ?? CONNECTOR_ID,
        input.type ?? 'finance-manager',
        input.id ?? CONNECTOR_ID,
        input.enabled === false ? 0 : 1,
        input.pollIntervalMinutes ?? null,
        JSON.stringify(input.capabilities ?? {}),
        JSON.stringify(input.credentials ?? {}),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(input.syncedLists ?? []),
        input.createdAt ?? BASE_TIME,
        input.createdAt ?? BASE_TIME,
      );
    },
    async seedSyncState(input) {
      database.prepare(`
        INSERT INTO finance_sync_state (
          connector_id, status, last_successful_sync_at,
          last_successful_source_as_of,
          last_successful_projection_coverage_start,
          last_successful_projection_coverage_end,
          last_error_code, attribution_status, attribution_last_successful_at,
          attribution_policy_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        CONNECTOR_ID,
        input.status ?? 'succeeded',
        input.lastSuccessfulSyncAt ?? null,
        input.sourceAsOf ?? null,
        input.coverageStart ?? null,
        input.coverageEnd ?? null,
        input.lastErrorCode ?? null,
        input.attributionStatus ?? 'idle',
        input.attributionLastSuccessfulAt ?? null,
        input.attributionPolicyVersion ?? null,
        BASE_TIME,
        BASE_TIME,
      );
    },
    async seedKid(input) {
      database.prepare(`
        INSERT INTO kid_profiles (
          id, name, color, daily_limit, weekly_limit, monthly_limit
        ) VALUES (?, ?, '#123456', ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.dailyLimit ?? null,
        input.weeklyLimit ?? null,
        input.monthlyLimit ?? null,
      );
    },
    async seedAttributionSubject(input) {
      database.prepare(`
        INSERT INTO finance_attribution_subjects (
          id, connector_id, kid_id, policy_version, engine_version,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, '1.0.0', ?, ?)
      `).run(
        `subject-${input.kidId}`,
        CONNECTOR_ID,
        input.kidId,
        input.policyVersion,
        BASE_TIME,
        BASE_TIME,
      );
    },
    async seedCategory(input) {
      database.prepare(`
        INSERT INTO finance_categories (
          id, connector_id, upstream_category_id, name, is_active,
          source_is_active, last_seen_generation_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'contract-generation', ?, ?)
      `).run(
        `category-${input.upstreamCategoryId}`,
        CONNECTOR_ID,
        input.upstreamCategoryId,
        input.name,
        input.isActive === false ? 0 : 1,
        input.sourceIsActive === false ? 0 : 1,
        BASE_TIME,
        BASE_TIME,
      );
    },
    async seedTransaction(input) {
      database.prepare(`
        INSERT INTO finance_transactions (
          id, connector_instance_id, upstream_transaction_id, date, amount,
          merchant_name, original_category, confirmed_category, assigned_kid_id,
          triage_status, is_pending, is_recurring, tags, lifecycle_status,
          source_fingerprint, last_seen_generation_id, first_seen_at,
          last_seen_at, synced_at, manual_decided_at, attribution_status,
          attribution_confidence, attribution_method, attribution_reasons,
          attribution_review_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?,
                  'contract-generation', ?, ?, ?, ?, ?, ?, ?, '[]', 'pending')
      `).run(
        input.id,
        CONNECTOR_ID,
        input.upstreamTransactionId,
        input.date,
        input.amount,
        input.merchant,
        input.originalCategory ?? null,
        input.confirmedCategory ?? null,
        input.assignedKidId ?? null,
        input.triageStatus ?? 'pending',
        input.pending ? 1 : 0,
        input.recurring ? 1 : 0,
        input.lifecycleStatus ?? 'active',
        input.sourceFingerprint ?? 'contract-fingerprint',
        BASE_TIME,
        input.lastSeenAt ?? BASE_TIME,
        BASE_TIME,
        input.manualDecidedAt ?? null,
        input.attributionStatus ?? 'pending',
        input.confidence ?? null,
        input.method ?? null,
      );
    },
    async seedException(input) {
      database.prepare(`
        INSERT INTO finance_attribution_exceptions (
          id, connector_id, transaction_id, status, reason_code, retryable,
          review_state, source_fingerprint, policy_version, occurrence_count,
          created_at, first_observed_at, last_observed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'contract-exception-fingerprint',
                  7, 1, ?, ?, ?, ?)
      `).run(
        input.id,
        CONNECTOR_ID,
        input.transactionId,
        input.status ?? 'open',
        input.reasonCode ?? 'low-confidence',
        input.retryable ? 1 : 0,
        BASE_TIME,
        input.lastObservedAt,
        input.lastObservedAt,
        input.updatedAt,
      );
    },
    async seedObligation(input) {
      database.prepare(`
        INSERT INTO finance_recurring_obligations (
          id, connector_id, generation_id, upstream_recurring_id, merchant,
          amount, frequency, next_expected_date, category_name, is_current,
          source_as_of, created_at
        ) VALUES (?, ?, 'contract-generation', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        CONNECTOR_ID,
        `upstream-${input.id}`,
        input.merchant,
        input.amount,
        input.frequency,
        input.nextExpectedDate,
        input.categoryName ?? null,
        input.isCurrent === false ? 0 : 1,
        BASE_TIME,
        BASE_TIME,
      );
    },
    async seedMutationAudit(input) {
      database.prepare(`
        INSERT INTO finance_mutation_audit (
          id, idempotency_key, connector_id, transaction_id,
          upstream_transaction_id, operation, requested_value, status,
          attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'category_update', ?, ?, 0, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          status = excluded.status, updated_at = excluded.updated_at,
          attempt_count = 0
      `).run(
        input.id,
        input.idempotencyKey,
        CONNECTOR_ID,
        input.transactionId,
        input.upstreamTransactionId,
        input.requestedValue,
        input.status,
        BASE_TIME,
        input.updatedAt,
      );
    },
    async transactionSnapshot(id) {
      const row = database.prepare(`
        SELECT assigned_kid_id AS assignedKidId,
               kid_assignment_method AS kidAssignmentMethod,
               manual_decision_action AS manualDecisionAction,
               manual_decided_at AS manualDecidedAt,
               attribution_status AS attributionStatus,
               attribution_method AS attributionMethod,
               attribution_retryable AS attributionRetryable,
               attribution_reasons AS attributionReasons,
               triage_status AS triageStatus,
               confirmed_category AS confirmedCategory
        FROM finance_transactions WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        ...row,
        attributionRetryable: row.attributionRetryable === 1,
        attributionReasons: parseJson(row.attributionReasons),
      } as Awaited<ReturnType<FinanceAssistantContractHarness['transactionSnapshot']>>;
    },
    async mutationAudit(idempotencyKey) {
      return (database.prepare(`
        SELECT transaction_id AS transactionId,
               upstream_transaction_id AS upstreamTransactionId,
               requested_value AS requestedValue, status,
               attempt_count AS attemptCount, last_error_code AS lastErrorCode,
               last_error_message AS lastErrorMessage,
               completed_at AS completedAt, updated_at AS updatedAt
        FROM finance_mutation_audit
        WHERE connector_id = ? AND idempotency_key = ?
      `).get(CONNECTOR_ID, idempotencyKey) ?? null) as Awaited<
        ReturnType<FinanceAssistantContractHarness['mutationAudit']>
      >;
    },
    async attributionAuditCount() {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM finance_attribution_audit`,
      ).get() as { count: number };
      return row.count;
    },
    async exceptionStatus(id) {
      const row = database.prepare(
        `SELECT status FROM finance_attribution_exceptions WHERE id = ?`,
      ).get(id) as { status: string } | undefined;
      return row?.status ?? null;
    },
    async pendingApprovalIds() {
      const rows = database.prepare(
        `SELECT approval_id AS approvalId FROM houston_finance_pending_approvals ORDER BY approval_id`,
      ).all() as Array<{ approvalId: string }>;
      return rows.map((row) => row.approvalId);
    },
    async approvalAudit() {
      return database.prepare(`
        SELECT correlation_id AS correlationId, call_hash AS callHash, tool,
               decision, outcome, duration_ms AS durationMs
        FROM houston_finance_action_audit
        ORDER BY created_at, id
      `).all() as Awaited<ReturnType<FinanceAssistantContractHarness['approvalAudit']>>;
    },
  };
}

describeFinanceAssistantPersistenceContract('SQLite', createHarness);

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('L09 Houston finance-assistant persistence boundary', () => {
  const contractPath = 'src/db/persistence/finance-assistant.ts';
  const adapters = [
    'src/db/persistence/sqlite-finance-assistant-repository.ts',
    'src/db/postgres/repositories/finance-assistant-repository.ts',
  ] as const;
  const migratedModules = [
    'src/lib/finance/houston-tools.ts',
    'src/lib/ai/finance-approval-store.ts',
  ] as const;

  it('keeps the contract and services backend-neutral and purpose-built', () => {
    const contract = source(contractPath);
    expect(contract).not.toMatch(
      /from\s+['"](?:better-sqlite3|pg|drizzle-orm|@\/db(?:\/schema|\/finance-schema)?)['"]/,
    );
    for (const escapeHatch of [
      /\bquery\s*\(\s*sql\b/,
      /\bexecute\s*\(\s*(?:sql|statement|text)\b/,
      /\bgetHandle\b/,
      /\bgetConnection\b/,
      /\bwithTransaction\b/,
    ]) {
      expect(contract, String(escapeHatch)).not.toMatch(escapeHatch);
    }
    for (const path of migratedModules) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /from\s+['"]@\/lib\/connectors\/monarch-money\/(?:attribution-service|dataset-sync|snapshot-sync)['"]/,
      );
      expect(contents, path).not.toMatch(/\bsqlite\.(?:prepare|transaction|exec|pragma)\b/);
      expect(contents, path).toContain("from '@/lib/persistence/worker-runtime'");
    }
  });

  it('keeps provider I/O out of adapters and after the durable claim', () => {
    for (const path of adapters) {
      const contents = source(path);
      expect(contents, path).not.toMatch(/MonarchBridgeClient|\bfetch\s*\(/);
      expect(contents, path).not.toMatch(/from\s+['"]@\/lib\/connectors\//);
      expect(contents, path).not.toMatch(/resolveDatabaseBackend|dual[- ]?write/i);
    }
    const service = source('src/lib/finance/houston-tools.ts');
    const claim = service.indexOf('finance.assistant.claimCategoryMutation');
    const provider = service.indexOf('new MonarchBridgeClient(config).updateCategory');
    expect(provider).toBeGreaterThan(claim);
    expect(service.indexOf('finance.assistant.completeCategoryMutation')).toBeGreaterThan(provider);
    expect(service.indexOf('finance.assistant.failCategoryMutation')).toBeGreaterThan(provider);
  });

  it('uses null-safe PostgreSQL CAS and records only the exact graph decrement', () => {
    const postgres = source(adapters[1]);
    expect(postgres).toContain('assigned_kid_id IS NOT DISTINCT FROM');
    expect(postgres).toContain('confirmed_category IS NOT DISTINCT FROM');
    expect(postgres).toContain('manual_decided_at IS NOT DISTINCT FROM');
    expect(postgres).toContain('FOR UPDATE');

    const baseline = JSON.parse(
      source('tests/architecture/web-persistence-baseline.json'),
    ) as { counts: Record<string, number>; taintedLibA: string[] };
    expect(baseline.counts).toMatchObject({
      tierARoutes: 217,
      tierBRoutes: 26,
      cleanRoutes: 23,
      taintedLibA: 92,
      totalMigrationUnits: 310,
    });
    for (const removed of [
      'src/lib/ai/finance-approval-store.ts',
      'src/lib/ai/tools/finance-tools.ts',
      'src/lib/finance/houston-tools.ts',
    ]) {
      expect(baseline.taintedLibA).not.toContain(removed);
    }
  });
});

afterAll(() => {
  sqlite?.close();
  sqlite = null;
  rmSync(databasePath, { force: true });
});
