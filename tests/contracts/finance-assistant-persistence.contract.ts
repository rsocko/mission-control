import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';
import type { FinanceAssistantPersistence } from '@/db/persistence/finance-assistant';
import { runOrderedDatabaseBootstrap } from '@/db/bootstrap/registry';
import { createSqliteFinanceAssistantPersistence } from '@/db/persistence/sqlite-finance-assistant-repository';

vi.unmock('drizzle-orm');

export const CONNECTOR_ID = 'finance-assistant-contract';
export const SECOND_CONNECTOR_ID = 'finance-assistant-contract-second';
export const BASE_TIME = '2026-08-13T12:00:00.000Z';
export const KID_ID = 'finance-assistant-kid';
export const SECOND_KID_ID = 'finance-assistant-kid-second';
export const TRANSACTION_ID = 'finance-assistant-transaction';
export const UPSTREAM_TRANSACTION_ID = 'finance-assistant-upstream-transaction';
export const CATEGORY_ID = 'finance-assistant-upstream-category';

export interface FinanceAssistantSeedTransaction {
  id: string;
  upstreamTransactionId: string;
  date: string;
  amount: number;
  merchant: string | null;
  originalCategory?: string | null;
  confirmedCategory?: string | null;
  assignedKidId?: string | null;
  triageStatus?: string;
  pending?: boolean;
  recurring?: boolean;
  lifecycleStatus?: 'active' | 'deleted';
  attributionStatus?: 'attributed' | 'unassigned' | 'pending' | 'unavailable';
  confidence?: 'definite' | 'likely' | 'none' | null;
  method?: 'manual' | 'account-rule' | 'merchant-rule' | 'historical-pattern' | null;
  sourceFingerprint?: string;
  lastSeenAt?: string;
  manualDecidedAt?: string | null;
}

export interface FinanceAssistantTransactionSnapshot {
  assignedKidId: string | null;
  kidAssignmentMethod: string | null;
  manualDecisionAction: string | null;
  manualDecidedAt: string | null;
  attributionStatus: string;
  attributionMethod: string | null;
  attributionRetryable: boolean;
  attributionReasons: unknown;
  triageStatus: string;
  confirmedCategory: string | null;
}

export interface FinanceAssistantMutationAuditSnapshot {
  transactionId: string;
  upstreamTransactionId: string;
  requestedValue: string;
  status: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface FinanceAssistantApprovalAuditSnapshot {
  correlationId: string;
  callHash: string;
  tool: string;
  decision: string;
  outcome: string;
  durationMs: number;
}

export interface FinanceAssistantContractHarness {
  assistant: FinanceAssistantPersistence;
  reset(): Promise<void>;
  seedConnector(input?: {
    id?: string;
    enabled?: boolean;
    createdAt?: string;
    pollIntervalMinutes?: number | null;
    capabilities?: Record<string, unknown>;
    credentials?: Record<string, string>;
    settings?: Record<string, unknown>;
    syncedLists?: string[];
    type?: string;
  }): Promise<void>;
  seedSyncState(input: {
    status?: 'idle' | 'running' | 'succeeded' | 'failed';
    sourceAsOf?: string | null;
    coverageStart?: string | null;
    coverageEnd?: string | null;
    lastSuccessfulSyncAt?: string | null;
    lastErrorCode?: string | null;
    attributionStatus?: 'idle' | 'healthy' | 'degraded' | 'unavailable';
    attributionLastSuccessfulAt?: string | null;
    attributionPolicyVersion?: number | null;
  }): Promise<void>;
  seedKid(input: {
    id: string;
    name: string;
    dailyLimit?: number | null;
    weeklyLimit?: number | null;
    monthlyLimit?: number | null;
  }): Promise<void>;
  seedAttributionSubject(input: { kidId: string; policyVersion: number }): Promise<void>;
  seedCategory(input: {
    upstreamCategoryId: string;
    name: string;
    isActive?: boolean;
    sourceIsActive?: boolean;
  }): Promise<void>;
  seedTransaction(input: FinanceAssistantSeedTransaction): Promise<void>;
  seedException(input: {
    id: string;
    transactionId: string;
    status?: 'open' | 'retry_requested' | 'resolved' | 'dismissed';
    reasonCode?: string;
    retryable?: boolean;
    lastObservedAt: string;
    updatedAt: string;
  }): Promise<void>;
  seedObligation(input: {
    id: string;
    merchant: string;
    amount: number;
    frequency: string;
    nextExpectedDate: string | null;
    categoryName?: string | null;
    isCurrent?: boolean;
  }): Promise<void>;
  seedMutationAudit(input: {
    id: string;
    idempotencyKey: string;
    transactionId: string;
    upstreamTransactionId: string;
    requestedValue: string;
    status: 'pending' | 'processing' | 'succeeded' | 'failed';
    updatedAt: string;
  }): Promise<void>;
  transactionSnapshot(id: string): Promise<FinanceAssistantTransactionSnapshot | null>;
  mutationAudit(
    idempotencyKey: string,
  ): Promise<FinanceAssistantMutationAuditSnapshot | null>;
  attributionAuditCount(): Promise<number>;
  exceptionStatus(id: string): Promise<string | null>;
  pendingApprovalIds(): Promise<string[]>;
  approvalAudit(): Promise<FinanceAssistantApprovalAuditSnapshot[]>;
}

const EXPECTED_VERSION = {
  sourceFingerprint: 'contract-fingerprint',
  lastSeenAt: BASE_TIME,
  assignedKidId: null,
  confirmedCategory: null,
  manualDecidedAt: null,
};

function approvalInput(kidName = 'Avery'): string {
  return JSON.stringify({ kidName });
}

/**
 * Shared, backend-neutral proof for the Houston finance-assistant persistence
 * port. Both the SQLite and live-PostgreSQL adapters must satisfy every case
 * identically, including bounds, ordering, marshalling of integer/boolean and
 * text/JSON columns, null-safe compare-and-swap, exactly-once approval
 * consume, and all-or-nothing mutation semantics.
 */
export function describeFinanceAssistantPersistenceContract(
  backend: string,
  createHarness: () => Promise<FinanceAssistantContractHarness>,
): void {
  describe(`${backend} finance assistant persistence`, () => {
    let harness: FinanceAssistantContractHarness;
    let assistant: FinanceAssistantPersistence;

    beforeEach(async () => {
      harness = await createHarness();
      assistant = harness.assistant;
      await harness.reset();
    });

    async function seedBaseProjection(): Promise<void> {
      await harness.seedConnector();
      await harness.seedSyncState({
        sourceAsOf: BASE_TIME,
        coverageStart: '2026-08-01',
        coverageEnd: '2026-08-13',
        lastSuccessfulSyncAt: BASE_TIME,
        attributionStatus: 'healthy',
        attributionLastSuccessfulAt: BASE_TIME,
        attributionPolicyVersion: 7,
      });
      await harness.seedKid({
        id: KID_ID,
        name: 'Avery',
        dailyLimit: 20,
        weeklyLimit: null,
        monthlyLimit: 300,
      });
      await harness.seedKid({ id: SECOND_KID_ID, name: 'Blair' });
      await harness.seedAttributionSubject({ kidId: KID_ID, policyVersion: 7 });
      await harness.seedCategory({ upstreamCategoryId: CATEGORY_ID, name: 'Entertainment' });
      await harness.seedTransaction({
        id: TRANSACTION_ID,
        upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
        date: '2026-08-12',
        amount: -42.75,
        merchant: 'Contract Market',
        originalCategory: 'Food',
        pending: true,
        recurring: false,
        attributionStatus: 'unassigned',
        confidence: 'likely',
        method: 'merchant-rule',
        sourceFingerprint: EXPECTED_VERSION.sourceFingerprint,
        lastSeenAt: EXPECTED_VERSION.lastSeenAt,
      });
    }

    const sqliteDataDirectory = resolve(process.cwd(), 'data');
    const sqliteDatabasePath = resolve(
      sqliteDataDirectory,
      `finance-assistant-contract-${process.pid}.db`,
    );
    let sqlite: Database.Database | null = null;

    function parseJson(value: unknown): unknown {
      return typeof value === 'string' ? JSON.parse(value) : value;
    }

    async function createSqliteHarness(): Promise<FinanceAssistantContractHarness> {
      if (!sqlite) {
        mkdirSync(sqliteDataDirectory, { recursive: true });
        rmSync(sqliteDatabasePath, { force: true });
        sqlite = new Database(sqliteDatabasePath);
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

    if (backend !== 'SQLite') {
      describeFinanceAssistantPersistenceContract('SQLite', createSqliteHarness);

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
          ) as {
            counts: Record<string, number>;
            taintedLibA: string[];
            decrementHistory: Array<{
              layer: string;
              totalMigrationUnits: { from: number; to: number; delta: number };
              removedTaintedApiHelpers: string[];
              removedTaintedLibA: string[];
              removedTierARoutes: string[];
              newlyCleanRoutes: string[];
              tierBReclassifications: string[];
              notMigratedFromTheOwnedFileSet: string[];
            }>;
          };
          expect(baseline.counts).toEqual({
            apiRoutes: 266,
            tierARoutes: 208,
            tierBRoutes: 26,
            cleanRoutes: 32,
            directTaintSourceRoutes: 138,
            transitiveOnlyTaintSourceRoutes: 70,
            directDbNamespaceRoutes: 139,
            taintedLibA: 88,
            taintedApiHelpers: 1,
            totalMigrationUnits: 297,
          });
          const l09 = baseline.decrementHistory.find((record) => record.layer === 'L09');
          expect(l09?.totalMigrationUnits).toEqual({ from: 313, to: 310, delta: -3 });
          const removedTaintedLibA = [
            'src/lib/ai/finance-approval-store.ts',
            'src/lib/ai/tools/finance-tools.ts',
            'src/lib/finance/houston-tools.ts',
          ];
          expect(l09?.removedTaintedLibA).toEqual(removedTaintedLibA);
          expect(l09?.removedTaintedApiHelpers).toEqual([]);
          expect(l09?.removedTierARoutes).toEqual([]);
          expect(l09?.newlyCleanRoutes).toEqual([]);
          expect(l09?.tierBReclassifications).toEqual([]);
          expect(l09?.notMigratedFromTheOwnedFileSet).toEqual([]);
          for (const removed of removedTaintedLibA) {
            expect(baseline.taintedLibA).not.toContain(removed);
          }
        });
      });

      afterAll(() => {
        sqlite?.close();
        sqlite = null;
        rmSync(sqliteDatabasePath, { force: true });
      });
    }

    describe('connector selection and configuration', () => {
      it('returns nothing when no finance connector is enabled', async () => {
        expect(await assistant.listEnabledConnectors()).toEqual([]);
        expect(await assistant.readConnectorConfig(CONNECTOR_ID)).toBeNull();
      });

      it('excludes disabled connectors and exposes ambiguity without reading the estate', async () => {
        await harness.seedConnector({ enabled: false });
        expect(await assistant.listEnabledConnectors()).toEqual([]);
        expect(await assistant.readConnectorConfig(CONNECTOR_ID)).toBeNull();

        await harness.reset();
        await harness.seedConnector({ createdAt: '2026-08-01T00:00:00.000Z' });
        await harness.seedConnector({
          id: SECOND_CONNECTOR_ID,
          createdAt: '2026-08-02T00:00:00.000Z',
        });

        const connectors = await assistant.listEnabledConnectors();
        expect(connectors).toHaveLength(2);
        expect(connectors[0].id).toBe(CONNECTOR_ID);
      });

      it('normalizes stored configuration documents into domain values', async () => {
        await harness.seedConnector({
          pollIntervalMinutes: 240,
          capabilities: { read: true, write: 'yes', sync: false },
          credentials: { serviceToken: 'contract-service-token' },
          settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
          syncedLists: ['contract-list'],
        });

        const config = await assistant.readConnectorConfig(CONNECTOR_ID);
        expect(config).toMatchObject<Partial<ConnectorConfig>>({
          id: CONNECTOR_ID,
          type: 'finance-manager',
          enabled: true,
          pollIntervalMinutes: 240,
          credentials: { serviceToken: 'contract-service-token' },
          settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
          syncedLists: ['contract-list'],
        });
        // Non-boolean capability values must never be coerced into `true`.
        expect(config?.capabilities).toEqual({
          read: true,
          write: false,
          delete: false,
          sync: false,
          subtasks: false,
          lists: false,
          tags: false,
          tagWriteBack: false,
        });
      });

      it('reads projection freshness inputs with null-preserving semantics', async () => {
        await harness.seedConnector();
        expect(await assistant.readProjectionState(CONNECTOR_ID)).toBeNull();

        await harness.seedSyncState({
          status: 'failed',
          sourceAsOf: BASE_TIME,
          lastErrorCode: 'contract_failure',
          attributionStatus: 'degraded',
        });
        expect(await assistant.readProjectionState(CONNECTOR_ID)).toEqual({
          sourceAsOf: BASE_TIME,
          coverageStart: null,
          coverageEnd: null,
          lastSuccessfulSyncAt: null,
          status: 'failed',
          lastErrorCode: 'contract_failure',
          attributionStatus: 'degraded',
          attributionLastSuccessfulAt: null,
        });
      });
    });

    describe('bounded reads', () => {
      it('marshals flags, joins the projected category, and honors the page bound', async () => {
        await seedBaseProjection();
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-2`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-2`,
          date: '2026-08-11',
          amount: -10.5,
          merchant: 'Contract Music',
          confirmedCategory: CATEGORY_ID,
          assignedKidId: KID_ID,
          recurring: true,
          sourceFingerprint: 'contract-fingerprint-2',
        });

        const page = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          limit: 1,
        });
        expect(page.truncated).toBe(true);
        expect(page.transactions).toHaveLength(1);
        expect(page.transactions[0]).toMatchObject({
          id: TRANSACTION_ID,
          date: '2026-08-12',
          amount: -42.75,
          merchant: 'Contract Market',
          category: 'Food',
          confirmedCategory: null,
          pending: true,
          recurring: false,
          kidName: null,
          assignedKidId: null,
          manualDecidedAt: null,
        });

        const all = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          limit: 10,
        });
        expect(all.truncated).toBe(false);
        expect(all.transactions.map((row) => row.id)).toEqual([
          TRANSACTION_ID,
          `${TRANSACTION_ID}-2`,
        ]);
        expect(all.transactions[1]).toMatchObject({
          category: 'Entertainment',
          confirmedCategory: CATEGORY_ID,
          kidName: 'Avery',
          recurring: true,
          pending: false,
        });
      });

      it('applies merchant, category, kid, and triage filters literally', async () => {
        await seedBaseProjection();
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-wild`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-wild`,
          date: '2026-08-10',
          amount: -5,
          merchant: 'Contract %Market',
          confirmedCategory: CATEGORY_ID,
          assignedKidId: KID_ID,
          triageStatus: 'confirmed',
          sourceFingerprint: 'contract-fingerprint-wild',
        });

        const wildcard = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          merchantQuery: '%market',
          limit: 10,
        });
        expect(wildcard.transactions.map((row) => row.id)).toEqual([
          `${TRANSACTION_ID}-wild`,
        ]);

        const byCategory = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          categoryName: 'entertainment',
          limit: 10,
        });
        expect(byCategory.transactions.map((row) => row.id)).toEqual([
          `${TRANSACTION_ID}-wild`,
        ]);

        const byKid = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          kidId: KID_ID,
          limit: 10,
        });
        expect(byKid.transactions.map((row) => row.id)).toEqual([
          `${TRANSACTION_ID}-wild`,
        ]);

        const byTriage = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
          triageStatus: 'pending',
          limit: 10,
        });
        expect(byTriage.transactions.map((row) => row.id)).toEqual([TRANSACTION_ID]);
      });

      it('excludes deleted transactions and out-of-range dates', async () => {
        await seedBaseProjection();
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-deleted`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-deleted`,
          date: '2026-08-12',
          amount: -1,
          merchant: 'Contract Deleted',
          lifecycleStatus: 'deleted',
          sourceFingerprint: 'contract-fingerprint-deleted',
        });

        const page = await assistant.searchTransactions({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-12',
          endDate: '2026-08-12',
          limit: 10,
        });
        expect(page.transactions.map((row) => row.id)).toEqual([TRANSACTION_ID]);
      });

      it('aggregates household spending with integer counts and numeric totals', async () => {
        await seedBaseProjection();
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-kid`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-kid`,
          date: '2026-08-11',
          amount: -10.5,
          merchant: 'Contract Music',
          confirmedCategory: CATEGORY_ID,
          assignedKidId: KID_ID,
          sourceFingerprint: 'contract-fingerprint-kid',
        });

        const summary = await assistant.readSpendingSummary({
          connectorId: CONNECTOR_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
        });
        expect(summary.totalAmount).toBeCloseTo(53.25, 5);
        expect(summary.transactionCount).toBe(2);
        expect(summary.byCategory.map((row) => row.category)).toEqual([
          'Food',
          'Entertainment',
        ]);
        expect(summary.byCategory[0].transactionCount).toBe(1);
        expect(summary.byKid).toHaveLength(1);
        expect(summary.byKid[0].kidName).toBe('Avery');

        const totals = await assistant.readKidSpendingTotal({
          connectorId: CONNECTOR_ID,
          kidId: KID_ID,
          startDate: '2026-08-01',
          endDate: '2026-08-13',
        });
        expect(totals.totalAmount).toBeCloseTo(10.5, 5);
        expect(totals.transactionCount).toBe(1);
      });

      it('returns only current exceptions, newest first, with boolean retryable', async () => {
        await seedBaseProjection();
        await harness.seedException({
          id: 'contract-exception-old',
          transactionId: TRANSACTION_ID,
          reasonCode: 'low-confidence',
          retryable: true,
          lastObservedAt: '2026-08-10T12:00:00.000Z',
          updatedAt: '2026-08-10T12:00:00.000Z',
        });
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-2`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-2`,
          date: '2026-08-11',
          amount: -10.5,
          merchant: 'Contract Music',
          assignedKidId: KID_ID,
          sourceFingerprint: 'contract-fingerprint-2',
        });
        await harness.seedException({
          id: 'contract-exception-new',
          transactionId: `${TRANSACTION_ID}-2`,
          reasonCode: 'no-match',
          retryable: false,
          lastObservedAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z',
        });
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-3`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-3`,
          date: '2026-08-13',
          amount: -3.25,
          merchant: 'Contract Resolved',
          sourceFingerprint: 'contract-fingerprint-3',
        });
        await harness.seedException({
          id: 'contract-exception-resolved',
          transactionId: `${TRANSACTION_ID}-3`,
          status: 'resolved',
          lastObservedAt: '2026-08-13T12:00:00.000Z',
          updatedAt: '2026-08-13T12:00:00.000Z',
        });

        const page = await assistant.listAttributionExceptions({
          connectorId: CONNECTOR_ID,
          limit: 10,
        });
        expect(page.truncated).toBe(false);
        expect(page.exceptions.map((row) => row.reasonCode)).toEqual([
          'no-match',
          'low-confidence',
        ]);
        expect(page.exceptions[0]).toMatchObject({
          retryable: false,
          assignedKidId: KID_ID,
          merchantName: 'Contract Music',
        });
        expect(page.exceptions[1].retryable).toBe(true);
        expect(page.subjects).toEqual([{ kidId: KID_ID, name: 'Avery' }]);

        const bounded = await assistant.listAttributionExceptions({
          connectorId: CONNECTOR_ID,
          limit: 1,
        });
        expect(bounded.exceptions).toHaveLength(1);
        expect(bounded.truncated).toBe(true);
      });

      it('bounds recurring obligations and aggregates the full horizon', async () => {
        await seedBaseProjection();
        await harness.seedObligation({
          id: 'contract-obligation-monthly',
          merchant: 'Contract Music',
          amount: -12,
          frequency: 'monthly',
          nextExpectedDate: '2026-08-20',
          categoryName: 'Subscriptions',
        });
        await harness.seedObligation({
          id: 'contract-obligation-weekly',
          merchant: 'Contract Grocer',
          amount: -12,
          frequency: 'Weekly',
          nextExpectedDate: '2026-08-25',
        });
        await harness.seedObligation({
          id: 'contract-obligation-superseded',
          merchant: 'Contract Superseded',
          amount: -1000,
          frequency: 'monthly',
          nextExpectedDate: '2026-08-21',
          isCurrent: false,
        });

        const page = await assistant.listRecurringObligations({
          connectorId: CONNECTOR_ID,
          horizonStart: '2026-08-13',
          horizonEnd: '2026-11-11',
          limit: 1,
        });
        expect(page.truncated).toBe(true);
        expect(page.obligations).toEqual([{
          merchant: 'Contract Music',
          amount: -12,
          frequency: 'monthly',
          nextExpectedDate: '2026-08-20',
          category: 'Subscriptions',
        }]);
        expect(page.estimatedMonthlyAmount).toBeCloseTo(12 + 12 * (52 / 12), 5);
      });

      it('matches names case-insensitively and proves ambiguity with a bounded read', async () => {
        await seedBaseProjection();
        expect(await assistant.matchKidsByName('avery')).toEqual([{
          id: KID_ID,
          name: 'Avery',
          dailyLimit: 20,
          weeklyLimit: null,
          monthlyLimit: 300,
        }]);
        expect(await assistant.matchKidsByName('nobody')).toEqual([]);

        await harness.seedKid({ id: `${KID_ID}-duplicate`, name: 'avery' });
        expect(await assistant.matchKidsByName('Avery')).toHaveLength(2);

        expect(await assistant.matchProjectedKidsByName({
          connectorId: CONNECTOR_ID,
          name: 'Avery',
        })).toEqual([{ id: KID_ID, name: 'Avery' }]);
        // Blair has no attribution subject in the current policy generation.
        expect(await assistant.matchProjectedKidsByName({
          connectorId: CONNECTOR_ID,
          name: 'Blair',
        })).toEqual([]);

        expect(await assistant.matchProjectedCategoriesByName({
          connectorId: CONNECTOR_ID,
          name: 'entertainment',
        })).toEqual([{ upstreamCategoryId: CATEGORY_ID, name: 'Entertainment' }]);

        await harness.seedCategory({
          upstreamCategoryId: `${CATEGORY_ID}-inactive`,
          name: 'Retired',
          sourceIsActive: false,
        });
        expect(await assistant.matchProjectedCategoriesByName({
          connectorId: CONNECTOR_ID,
          name: 'Retired',
        })).toEqual([]);
      });

      it('finds approved mutation targets by exact date and amount', async () => {
        await seedBaseProjection();
        await harness.seedTransaction({
          id: `${TRANSACTION_ID}-fractional`,
          upstreamTransactionId: `${UPSTREAM_TRANSACTION_ID}-fractional`,
          date: '2026-08-12',
          amount: -12.34,
          merchant: 'Contract Fractional Amount',
          sourceFingerprint: 'contract-fingerprint-fractional',
        });
        const targets = await assistant.findApprovedMutationTargets({
          connectorId: CONNECTOR_ID,
          date: '2026-08-12',
          amount: -42.75,
        });
        expect(targets.map((row) => row.id)).toEqual([TRANSACTION_ID]);
        expect(targets[0].sourceFingerprint).toBe(EXPECTED_VERSION.sourceFingerprint);
        expect(await assistant.findApprovedMutationTargets({
          connectorId: CONNECTOR_ID,
          date: '2026-08-12',
          amount: -1,
        })).toEqual([]);
        expect(await assistant.findApprovedMutationTargets({
          connectorId: CONNECTOR_ID,
          date: '2026-08-12',
          amount: -12.34,
        })).toMatchObject([{ id: `${TRANSACTION_ID}-fractional` }]);
      });
    });

    describe('approval-gated kid assignment', () => {
      it('applies once, replays by approval identity, and rejects conflicting reuse', async () => {
        await seedBaseProjection();
        const command = {
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-kid-approval',
          actorType: 'parent-admin' as const,
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        };

        expect(await assistant.applyManualKidAssignment(command)).toEqual({ status: 'applied' });
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          assignedKidId: KID_ID,
          kidAssignmentMethod: 'manual',
          manualDecisionAction: 'assign-kid',
          manualDecidedAt: BASE_TIME,
          attributionStatus: 'attributed',
          attributionMethod: 'manual',
          attributionRetryable: false,
          attributionReasons: [],
          triageStatus: 'confirmed',
        });
        expect(await harness.attributionAuditCount()).toBe(1);

        expect(await assistant.applyManualKidAssignment(command)).toEqual({ status: 'replayed' });
        expect(await harness.attributionAuditCount()).toBe(1);

        expect(await assistant.applyManualKidAssignment({
          ...command,
          kidId: SECOND_KID_ID,
        })).toEqual({ status: 'idempotency-conflict' });
        expect(await harness.attributionAuditCount()).toBe(1);
      });

      it('resolves the projected exception in the same atomic decision', async () => {
        await seedBaseProjection();
        await harness.seedException({
          id: 'contract-exception-open',
          transactionId: TRANSACTION_ID,
          lastObservedAt: BASE_TIME,
          updatedAt: BASE_TIME,
        });

        expect(await assistant.applyManualKidAssignment({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-exception-approval',
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        })).toEqual({ status: 'applied' });
        expect(await harness.exceptionStatus('contract-exception-open')).toBe('resolved');
      });

      it('fails closed and writes nothing when the approved version is stale', async () => {
        await seedBaseProjection();
        const result = await assistant.applyManualKidAssignment({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-stale-approval',
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: { ...EXPECTED_VERSION, lastSeenAt: '2026-08-13T13:00:00.000Z' },
        });
        expect(result).toEqual({ status: 'transaction-conflict' });
        expect(await harness.attributionAuditCount()).toBe(0);
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          assignedKidId: null,
          manualDecidedAt: null,
        });
      });

      it('treats an absent, deleted, or unprojected target as fail-closed', async () => {
        await seedBaseProjection();
        expect(await assistant.applyManualKidAssignment({
          connectorId: CONNECTOR_ID,
          transactionId: 'contract-missing-transaction',
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-missing',
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        })).toEqual({ status: 'transaction-not-found' });

        expect(await assistant.applyManualKidAssignment({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: SECOND_KID_ID,
          idempotencyKey: 'houston:contract-unprojected',
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        })).toEqual({ status: 'unknown-attribution-subject' });
        expect(await harness.attributionAuditCount()).toBe(0);
      });

      it('rejects decisions for a connector that is not an enabled finance connector', async () => {
        await seedBaseProjection();
        expect(await assistant.applyManualKidAssignment({
          connectorId: SECOND_CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-unknown-connector',
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        })).toEqual({ status: 'connector-not-found' });
      });

      it('replays a resolved decision by approval identity', async () => {
        await seedBaseProjection();
        const key = 'houston:contract-replay-approval';
        await assistant.applyManualKidAssignment({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: key,
          actorType: 'parent-admin',
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        });
        expect(await assistant.findReplayedKidAssignments(key)).toEqual([{ kidName: 'Avery' }]);
        expect(await assistant.findReplayedKidAssignments('houston:unknown')).toEqual([]);
      });

      it('serializes concurrent identical decisions as apply plus replay', async () => {
        await seedBaseProjection();
        const command = {
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          kidId: KID_ID,
          idempotencyKey: 'houston:contract-concurrent-kid-approval',
          actorType: 'parent-admin' as const,
          decidedAt: BASE_TIME,
          expectedVersion: EXPECTED_VERSION,
        };
        const results = await Promise.all([
          assistant.applyManualKidAssignment(command),
          assistant.applyManualKidAssignment(command),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual(['applied', 'replayed']);
        expect(await harness.attributionAuditCount()).toBe(1);
      });
    });

    describe('approval-gated category mutation', () => {
      const claim = {
        connectorId: CONNECTOR_ID,
        transactionId: TRANSACTION_ID,
        categoryId: CATEGORY_ID,
        expectedCategoryName: 'Entertainment',
        idempotencyKey: 'houston:contract-category-approval',
        claimedAt: BASE_TIME,
        expectedVersion: EXPECTED_VERSION,
      };

      it('commits the claim before provider I/O and confirms only verified writes', async () => {
        await seedBaseProjection();

        const claimed = await assistant.claimCategoryMutation(claim);
        expect(claimed).toEqual({
          status: 'claimed',
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          claimToken: BASE_TIME,
        });
        // The claim is durable and observable *before* the provider call.
        expect(await harness.mutationAudit(claim.idempotencyKey)).toMatchObject({
          status: 'processing',
          attemptCount: 1,
          requestedValue: CATEGORY_ID,
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          completedAt: null,
        });
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          confirmedCategory: null,
          triageStatus: 'pending',
        });

        expect(await assistant.completeCategoryMutation({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          categoryId: CATEGORY_ID,
          idempotencyKey: claim.idempotencyKey,
          claimToken: BASE_TIME,
          completedAt: '2026-08-13T12:00:05.000Z',
        })).toBe(true);
        expect(await harness.mutationAudit(claim.idempotencyKey)).toMatchObject({
          status: 'succeeded',
          completedAt: '2026-08-13T12:00:05.000Z',
          lastErrorCode: null,
        });
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          confirmedCategory: CATEGORY_ID,
          triageStatus: 'confirmed',
        });
        expect(await assistant.findReplayedCategoryUpdates(claim.idempotencyKey)).toEqual([
          { categoryName: 'Entertainment' },
        ]);
        expect(await assistant.claimCategoryMutation(claim)).toEqual({
          status: 'already-succeeded',
        });
      });

      it('records provider failure without changing projected category state', async () => {
        await seedBaseProjection();
        await assistant.claimCategoryMutation(claim);

        expect(await assistant.failCategoryMutation({
          connectorId: CONNECTOR_ID,
          idempotencyKey: claim.idempotencyKey,
          claimToken: BASE_TIME,
          errorCode: 'upstream_unavailable',
          errorMessage: 'contract bridge failure',
          failedAt: '2026-08-13T12:00:07.000Z',
        })).toBe(true);
        expect(await harness.mutationAudit(claim.idempotencyKey)).toMatchObject({
          status: 'failed',
          lastErrorCode: 'upstream_unavailable',
          lastErrorMessage: 'contract bridge failure',
        });
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          confirmedCategory: null,
          triageStatus: 'pending',
        });
        expect(await assistant.findReplayedCategoryUpdates(claim.idempotencyKey)).toEqual([]);
      });

      it('rejects a stale approved version and a changed category without claiming', async () => {
        await seedBaseProjection();
        expect(await assistant.claimCategoryMutation({
          ...claim,
          expectedVersion: { ...EXPECTED_VERSION, confirmedCategory: 'changed' },
        })).toEqual({ status: 'transaction-conflict' });
        expect(await harness.mutationAudit(claim.idempotencyKey)).toBeNull();

        expect(await assistant.claimCategoryMutation({
          ...claim,
          expectedCategoryName: 'Renamed',
        })).toEqual({ status: 'category-conflict' });
        expect(await harness.mutationAudit(claim.idempotencyKey)).toBeNull();

        expect(await assistant.claimCategoryMutation({
          ...claim,
          transactionId: 'contract-missing-transaction',
        })).toEqual({ status: 'transaction-not-found' });
      });

      it('rejects reusing an approval identity for a different target or category', async () => {
        await seedBaseProjection();
        await assistant.claimCategoryMutation(claim);
        expect(await assistant.claimCategoryMutation({
          ...claim,
          categoryId: `${CATEGORY_ID}-other`,
        })).toEqual({ status: 'idempotency-conflict' });
      });

      it('allows only one active mutation per transaction and retries a stale claim', async () => {
        await seedBaseProjection();
        await harness.seedMutationAudit({
          id: 'contract-other-mutation',
          idempotencyKey: 'houston:contract-other-approval',
          transactionId: TRANSACTION_ID,
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          requestedValue: CATEGORY_ID,
          status: 'processing',
          updatedAt: BASE_TIME,
        });
        expect(await assistant.claimCategoryMutation(claim)).toEqual({
          status: 'mutation-in-progress',
        });

        await harness.seedMutationAudit({
          id: 'contract-other-mutation',
          idempotencyKey: 'houston:contract-other-approval',
          transactionId: TRANSACTION_ID,
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          requestedValue: CATEGORY_ID,
          status: 'failed',
          updatedAt: BASE_TIME,
        });
        await harness.seedMutationAudit({
          id: 'contract-own-mutation',
          idempotencyKey: claim.idempotencyKey,
          transactionId: TRANSACTION_ID,
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          requestedValue: CATEGORY_ID,
          status: 'processing',
          updatedAt: '2026-08-13T11:40:00.000Z',
        });
        // A claim that has been `processing` for longer than the stale window
        // is abandoned and may be retried by the same approval identity.
        expect(await assistant.claimCategoryMutation(claim)).toEqual({
          status: 'claimed',
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          claimToken: BASE_TIME,
        });
        expect(await harness.mutationAudit(claim.idempotencyKey)).toMatchObject({
          status: 'processing',
          attemptCount: 1,
        });

        await harness.seedMutationAudit({
          id: 'contract-own-mutation',
          idempotencyKey: claim.idempotencyKey,
          transactionId: TRANSACTION_ID,
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          requestedValue: CATEGORY_ID,
          status: 'processing',
          updatedAt: '2026-08-13T11:59:00.000Z',
        });
        expect(await assistant.claimCategoryMutation(claim)).toEqual({
          status: 'mutation-in-progress',
        });
      });

      it('rejects completion and failure from an abandoned provider attempt', async () => {
        await seedBaseProjection();
        const first = await assistant.claimCategoryMutation({
          ...claim,
          claimedAt: '2026-08-13T11:40:00.000Z',
        });
        expect(first.status).toBe('claimed');
        const second = await assistant.claimCategoryMutation(claim);
        expect(second).toEqual({
          status: 'claimed',
          upstreamTransactionId: UPSTREAM_TRANSACTION_ID,
          claimToken: BASE_TIME,
        });

        expect(await assistant.completeCategoryMutation({
          connectorId: CONNECTOR_ID,
          transactionId: TRANSACTION_ID,
          categoryId: CATEGORY_ID,
          idempotencyKey: claim.idempotencyKey,
          claimToken: '2026-08-13T11:40:00.000Z',
          completedAt: '2026-08-13T12:00:01.000Z',
        })).toBe(false);
        expect(await assistant.failCategoryMutation({
          connectorId: CONNECTOR_ID,
          idempotencyKey: claim.idempotencyKey,
          claimToken: '2026-08-13T11:40:00.000Z',
          errorCode: 'stale_provider_failure',
          errorMessage: 'abandoned attempt failed',
          failedAt: '2026-08-13T12:00:02.000Z',
        })).toBe(false);
        expect(await harness.mutationAudit(claim.idempotencyKey)).toMatchObject({
          status: 'processing',
          updatedAt: BASE_TIME,
        });
        expect(await harness.transactionSnapshot(TRANSACTION_ID)).toMatchObject({
          confirmedCategory: null,
          triageStatus: 'pending',
        });
      });
    });

    describe('pending approvals and redacted audit', () => {
      const pending = {
        approvalId: 'contract-approval-id',
        toolCallId: 'contract-call-id',
        tool: 'assignFinanceTransactionKid' as const,
        toolInput: approvalInput(),
        correlationId: 'contract-correlation',
        createdAt: BASE_TIME,
        expiresAt: '2026-08-13T13:00:00.000Z',
      };

      it('stores once, replays identical retries, and rejects conflicting reuse', async () => {
        expect(await assistant.persistPendingApproval(pending)).toEqual({ status: 'stored' });
        expect(await assistant.persistPendingApproval(pending)).toEqual({ status: 'replayed' });
        expect(await assistant.persistPendingApproval({
          ...pending,
          toolInput: approvalInput('Mallory'),
        })).toEqual({ status: 'conflict' });
        expect(await harness.pendingApprovalIds()).toEqual([pending.approvalId]);
      });

      it('consumes a matching proposal exactly once', async () => {
        await assistant.persistPendingApproval(pending);
        const consume = {
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          tool: pending.tool,
          toolInput: pending.toolInput,
          now: '2026-08-13T12:30:00.000Z',
        };

        expect(await assistant.consumePendingApproval(consume)).toEqual({
          status: 'consumed',
          toolInput: pending.toolInput,
        });
        expect(await assistant.consumePendingApproval(consume)).toEqual({ status: 'invalid' });
        expect(await harness.pendingApprovalIds()).toEqual([]);
      });

      it('rejects mismatched arguments without consuming the proposal', async () => {
        await assistant.persistPendingApproval(pending);
        expect(await assistant.consumePendingApproval({
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          tool: pending.tool,
          toolInput: approvalInput('Mallory'),
          now: '2026-08-13T12:30:00.000Z',
        })).toEqual({ status: 'invalid' });
        expect(await harness.pendingApprovalIds()).toEqual([pending.approvalId]);

        expect(await assistant.consumePendingApproval({
          approvalId: pending.approvalId,
          toolCallId: 'other-call-id',
          tool: pending.tool,
          toolInput: pending.toolInput,
          now: '2026-08-13T12:30:00.000Z',
        })).toEqual({ status: 'invalid' });
        expect(await harness.pendingApprovalIds()).toEqual([pending.approvalId]);
      });

      it('expires proposals at the boundary and prunes them on the next write', async () => {
        await assistant.persistPendingApproval(pending);
        expect(await assistant.consumePendingApproval({
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          tool: pending.tool,
          toolInput: pending.toolInput,
          now: pending.expiresAt,
        })).toEqual({ status: 'expired' });
        expect(await harness.pendingApprovalIds()).toEqual([]);

        await assistant.persistPendingApproval(pending);
        expect(await assistant.persistPendingApproval({
          ...pending,
          approvalId: 'contract-approval-later',
          createdAt: '2026-08-13T13:00:00.000Z',
          expiresAt: '2026-08-13T14:00:00.000Z',
        })).toEqual({ status: 'stored' });
        expect(await harness.pendingApprovalIds()).toEqual(['contract-approval-later']);
      });

      it('appends redacted approval audit rows', async () => {
        await assistant.recordApprovalAudit({
          correlationId: 'contract-correlation',
          callHash: 'contract-approval-id',
          tool: 'updateFinanceTransactionCategory',
          decision: 'deny',
          outcome: 'denied',
          durationMs: 0,
          createdAt: BASE_TIME,
        });
        expect(await harness.approvalAudit()).toEqual([{
          correlationId: 'contract-correlation',
          callHash: 'contract-approval-id',
          tool: 'updateFinanceTransactionCategory',
          decision: 'deny',
          outcome: 'denied',
          durationMs: 0,
        }]);
      });
    });
  });
}
