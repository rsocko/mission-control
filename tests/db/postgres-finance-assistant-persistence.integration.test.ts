import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceAssistantPersistence } from '@/db/postgres/repositories/finance-assistant-repository';
import { createPostgresFinanceWorkerPersistence } from '@/db/postgres/repositories/finance-worker-repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceAssistantPersistenceContract,
  type FinanceAssistantContractHarness,
} from '../contracts/finance-assistant-persistence.contract';

vi.unmock('drizzle-orm');

const apiMocks = vi.hoisted(() => ({
  finance: null as FinanceCorePersistence | null,
  sqliteCompatibilityAccess: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock('@/db', () => {
  const forbidden = new Proxy({}, {
    get() {
      apiMocks.sqliteCompatibilityAccess();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { sqlite: forbidden, db: forbidden, default: forbidden };
});

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => {
    if (!apiMocks.finance) throw new Error('Finance persistence is not registered');
    return { finance: apiMocks.finance };
  },
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  getAIRouteOutcome: () => ({ route: 'local' }),
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({ configured: true, provider: 'openai' }),
}));

vi.mock('@/lib/ai/features/chat', () => ({
  streamChat: apiMocks.streamChat,
}));

vi.mock('@/lib/ai/context-budget', () => ({
  loadAIContextSnapshot: async () => ({
    counts: {
      overdue: 0,
      dueToday: 0,
      inProgress: 0,
      unreadNotifications: 0,
      urgentNotifications: 0,
    },
    overdue: [],
    dueToday: [],
    inProgress: [],
    sources: [],
    rowCount: 0,
  }),
  applyAIContextCharacterBudget: (value: string) => value,
}));

vi.mock('@/lib/ai/admission-controller', () => ({
  acquireOllamaAdmissionWithTimeout: async () => ({ release: () => undefined }),
  getAIOverloadDetails: () => null,
}));

vi.mock('@/lib/runtime/lifecycle', () => ({
  startRuntimeOperation: () => ({
    accepted: true,
    signal: new AbortController().signal,
    finish: () => undefined,
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

vi.mock('@/lib/ai/tools', async () => {
  const { financeTools, createFinanceMutationTools } = await import(
    '@/lib/ai/tools/finance-tools'
  );
  return {
    createHoustonTools: () => ({ ...financeTools, ...createFinanceMutationTools() }),
  };
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-assistant-contract',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<Pool> {
  if (initialized) return backend.context.pool;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
  apiMocks.finance = createPostgresFinanceWorkerPersistence(backend.context.pool);
  return backend.context.pool;
}

async function createHarness(): Promise<FinanceAssistantContractHarness> {
  const pool = await initialize();
  const assistant = createPostgresFinanceAssistantPersistence(pool, {
    idFactory: (() => {
      let id = 0;
      return () => `finance-assistant-contract-id-${++id}`;
    })(),
  });

  return {
    assistant,
    async reset() {
      for (const table of [
        'houston_finance_pending_approvals',
        'houston_finance_action_audit',
        'finance_attribution_audit',
        'finance_attribution_exceptions',
        'finance_attribution_subjects',
        'finance_mutation_audit',
        'finance_recurring_obligations',
        'finance_transactions',
        'finance_categories',
        'finance_sync_state',
        'kid_profiles',
        'connector_configs',
      ]) {
        await pool.query(`DELETE FROM ${table}`);
      }
    },
    async seedConnector(input = {}) {
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
           credentials, settings, synced_lists, created_at, updated_at
         ) VALUES ($1, $2, $1, $3, 'poll', $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $9)`,
        [
          input.id ?? CONNECTOR_ID,
          input.type ?? 'finance-manager',
          input.enabled !== false,
          input.pollIntervalMinutes ?? null,
          JSON.stringify(input.capabilities ?? {}),
          JSON.stringify(input.credentials ?? {}),
          JSON.stringify(input.settings ?? {}),
          JSON.stringify(input.syncedLists ?? []),
          input.createdAt ?? BASE_TIME,
        ],
      );
    },
    async seedSyncState(input) {
      await pool.query(
        `INSERT INTO finance_sync_state (
           connector_id, status, last_successful_sync_at,
           last_successful_source_as_of,
           last_successful_projection_coverage_start,
           last_successful_projection_coverage_end,
           last_error_code, attribution_status, attribution_last_successful_at,
           attribution_policy_version, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
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
        ],
      );
    },
    async seedKid(input) {
      await pool.query(
        `INSERT INTO kid_profiles (id, name, color, daily_limit, weekly_limit, monthly_limit)
         VALUES ($1, $2, '#123456', $3, $4, $5)`,
        [
          input.id,
          input.name,
          input.dailyLimit ?? null,
          input.weeklyLimit ?? null,
          input.monthlyLimit ?? null,
        ],
      );
    },
    async seedAttributionSubject(input) {
      await pool.query(
        `INSERT INTO finance_attribution_subjects (
           id, connector_id, kid_id, policy_version, engine_version,
           first_seen_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, '1.0.0', $5, $5)`,
        [`subject-${input.kidId}`, CONNECTOR_ID, input.kidId, input.policyVersion, BASE_TIME],
      );
    },
    async seedCategory(input) {
      await pool.query(
        `INSERT INTO finance_categories (
           id, connector_id, upstream_category_id, name, is_active,
           source_is_active, last_seen_generation_id, first_seen_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'contract-generation', $7, $7)`,
        [
          `category-${input.upstreamCategoryId}`,
          CONNECTOR_ID,
          input.upstreamCategoryId,
          input.name,
          input.isActive !== false,
          input.sourceIsActive !== false,
          BASE_TIME,
        ],
      );
    },
    async seedTransaction(input) {
      await pool.query(
        `INSERT INTO finance_transactions (
           id, connector_instance_id, upstream_transaction_id, date, amount,
           merchant_name, original_category, confirmed_category, assigned_kid_id,
           triage_status, is_pending, is_recurring, tags, lifecycle_status,
           source_fingerprint, last_seen_generation_id, first_seen_at,
           last_seen_at, synced_at, manual_decided_at, attribution_status,
           attribution_confidence, attribution_method, attribution_reasons,
           attribution_review_state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '[]'::jsonb,
                   $13, $14, 'contract-generation', $15, $16, $15, $17, $18, $19,
                   $20, '[]'::jsonb, 'pending')`,
        [
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
          input.pending === true,
          input.recurring === true,
          input.lifecycleStatus ?? 'active',
          input.sourceFingerprint ?? 'contract-fingerprint',
          BASE_TIME,
          input.lastSeenAt ?? BASE_TIME,
          input.manualDecidedAt ?? null,
          input.attributionStatus ?? 'pending',
          input.confidence ?? null,
          input.method ?? null,
        ],
      );
    },
    async seedException(input) {
      await pool.query(
        `INSERT INTO finance_attribution_exceptions (
           id, connector_id, transaction_id, status, reason_code, retryable,
           review_state, source_fingerprint, policy_version, occurrence_count,
           created_at, first_observed_at, last_observed_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'contract-exception-fingerprint',
                   7, 1, $7, $8, $8, $9)`,
        [
          input.id,
          CONNECTOR_ID,
          input.transactionId,
          input.status ?? 'open',
          input.reasonCode ?? 'low-confidence',
          input.retryable === true,
          BASE_TIME,
          input.lastObservedAt,
          input.updatedAt,
        ],
      );
    },
    async seedObligation(input) {
      await pool.query(
        `INSERT INTO finance_recurring_obligations (
           id, connector_id, generation_id, upstream_recurring_id, merchant,
           amount, frequency, next_expected_date, category_name, is_current,
           source_as_of, created_at
         ) VALUES ($1, $2, 'contract-generation', $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          input.id,
          CONNECTOR_ID,
          `upstream-${input.id}`,
          input.merchant,
          input.amount,
          input.frequency,
          input.nextExpectedDate,
          input.categoryName ?? null,
          input.isCurrent !== false,
          BASE_TIME,
        ],
      );
    },
    async seedMutationAudit(input) {
      await pool.query(
        `INSERT INTO finance_mutation_audit (
           id, idempotency_key, connector_id, transaction_id,
           upstream_transaction_id, operation, requested_value, status,
           attempt_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 'category_update', $6, $7, 0, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, updated_at = excluded.updated_at,
           attempt_count = 0`,
        [
          input.id,
          input.idempotencyKey,
          CONNECTOR_ID,
          input.transactionId,
          input.upstreamTransactionId,
          input.requestedValue,
          input.status,
          BASE_TIME,
          input.updatedAt,
        ],
      );
    },
    async transactionSnapshot(id) {
      const { rows } = await pool.query(
        `SELECT assigned_kid_id AS "assignedKidId",
                kid_assignment_method AS "kidAssignmentMethod",
                manual_decision_action AS "manualDecisionAction",
                manual_decided_at AS "manualDecidedAt",
                attribution_status AS "attributionStatus",
                attribution_method AS "attributionMethod",
                attribution_retryable AS "attributionRetryable",
                attribution_reasons AS "attributionReasons",
                triage_status AS "triageStatus",
                confirmed_category AS "confirmedCategory"
         FROM finance_transactions WHERE id = $1`,
        [id],
      );
      return (rows[0] ?? null) as Awaited<
        ReturnType<FinanceAssistantContractHarness['transactionSnapshot']>
      >;
    },
    async mutationAudit(idempotencyKey) {
      const { rows } = await pool.query(
        `SELECT transaction_id AS "transactionId",
                upstream_transaction_id AS "upstreamTransactionId",
                requested_value AS "requestedValue", status,
                attempt_count AS "attemptCount", last_error_code AS "lastErrorCode",
                last_error_message AS "lastErrorMessage",
                completed_at AS "completedAt", updated_at AS "updatedAt"
         FROM finance_mutation_audit
         WHERE connector_id = $1 AND idempotency_key = $2`,
        [CONNECTOR_ID, idempotencyKey],
      );
      return (rows[0] ?? null) as Awaited<
        ReturnType<FinanceAssistantContractHarness['mutationAudit']>
      >;
    },
    async attributionAuditCount() {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM finance_attribution_audit`,
      );
      return rows[0].count as number;
    },
    async exceptionStatus(id) {
      const { rows } = await pool.query(
        `SELECT status FROM finance_attribution_exceptions WHERE id = $1`,
        [id],
      );
      return (rows[0]?.status as string | undefined) ?? null;
    },
    async pendingApprovalIds() {
      const { rows } = await pool.query(
        `SELECT approval_id AS "approvalId" FROM houston_finance_pending_approvals
         ORDER BY approval_id`,
      );
      return rows.map((row) => row.approvalId as string);
    },
    async approvalAudit() {
      const { rows } = await pool.query(
        `SELECT correlation_id AS "correlationId", call_hash AS "callHash", tool,
                decision, outcome, duration_ms AS "durationMs"
         FROM houston_finance_action_audit
         ORDER BY created_at, id`,
      );
      return rows as Awaited<ReturnType<FinanceAssistantContractHarness['approvalAudit']>>;
    },
  };
}

if (connectionString) {
  describeFinanceAssistantPersistenceContract('PostgreSQL', createHarness);
} else {
  describe('PostgreSQL finance assistant persistence contract', () => {
    it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
  });
}

const EXCLUDED_L10_DEPENDENCIES = [
  '@/lib/ai/provider-factory',
  '@/lib/ai/config-resolver',
  '@/lib/ai/features/chat',
  '@/lib/ai/context-budget',
  '@/lib/ai/admission-controller',
  '@/lib/runtime/lifecycle',
  '@/lib/logger',
  '@/lib/ai/tools',
] as const;

const APPROVAL_ID = 'invented-postgres-approval-id';
const TOOL_CALL_ID = 'invented-postgres-call-id';
const mutationInput = {
  transactionRef: `txn_${'a'.repeat(43)}`,
  expected: {
    date: '2026-08-13',
    amount: -12.34,
    merchant: 'Invented Market',
    category: 'Groceries',
    kidName: null,
    stateToken: `state_${'b'.repeat(43)}`,
  },
  kidName: 'Avery',
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function approvalMessage(approved: boolean) {
  return {
    id: 'invented-assistant-message',
    role: 'assistant',
    parts: [{
      type: 'tool-assignFinanceTransactionKid',
      toolCallId: TOOL_CALL_ID,
      state: 'approval-responded',
      input: mutationInput,
      approval: {
        id: APPROVAL_ID,
        approved,
        reason: approved ? 'User approved.' : 'User denied.',
      },
    }],
  };
}

async function seedPendingApproval(): Promise<void> {
  const pool = await initialize();
  await pool.query(
    `INSERT INTO houston_finance_pending_approvals (
       approval_id, tool_call_id, tool, tool_input, correlation_id,
       expires_at, created_at
     ) VALUES ($1, $2, 'assignFinanceTransactionKid', $3, 'invented-correlation', $4, $5)`,
    [
      APPROVAL_ID,
      TOOL_CALL_ID,
      canonicalJson(mutationInput),
      '2099-01-01T00:00:00.000Z',
      '2026-08-13T12:00:00.000Z',
    ],
  );
}

function describeOrSkip() {
  return connectionString ? describe : describe.skip;
}

describeOrSkip()('POST /api/ai finance approval seam on PostgreSQL', () => {
  beforeEach(async () => {
    const pool = await initialize();
    await pool.query('DELETE FROM houston_finance_pending_approvals');
    await pool.query('DELETE FROM houston_finance_action_audit');
    apiMocks.streamChat.mockReset();
    apiMocks.streamChat.mockResolvedValue({
      result: { toUIMessageStreamResponse: () => new Response('stream') },
      context: {
        featureId: 'houston-chat',
        sensitivity: 'internal',
        allowedRoutes: ['local'],
        correlationId: 'invented-correlation',
      },
    });
  });

  it('documents every mocked module as an excluded L10 dependency', () => {
    expect(EXCLUDED_L10_DEPENDENCIES).toContain('@/lib/ai/features/chat');
    expect(EXCLUDED_L10_DEPENDENCIES).not.toContain('@/lib/ai/finance-approval-store');
    expect(EXCLUDED_L10_DEPENDENCIES).not.toContain('@/lib/finance/houston-tools');
  });

  it('consumes a denied approval and writes the redacted audit to PostgreSQL', async () => {
    const pool = await initialize();
    await seedPendingApproval();
    const { POST } = await import('@/app/api/ai/route');

    const response = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(false)] }),
    }));
    expect(response.status).toBe(200);

    const pending = await pool.query(
      `SELECT approval_id FROM houston_finance_pending_approvals WHERE approval_id = $1`,
      [APPROVAL_ID],
    );
    expect(pending.rowCount).toBe(0);

    const audit = await pool.query(
      `SELECT call_hash AS "callHash", tool, decision, outcome, duration_ms AS "durationMs"
       FROM houston_finance_action_audit`,
    );
    expect(audit.rows).toEqual([{
      callHash: APPROVAL_ID,
      tool: 'assignFinanceTransactionKid',
      decision: 'deny',
      outcome: 'denied',
      durationMs: 0,
    }]);
    expect(apiMocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('rejects an unknown approval and records the invalid-approval audit', async () => {
    const pool = await initialize();
    const { POST } = await import('@/app/api/ai/route');

    const response = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'The finance approval is invalid, expired, or has already been used.',
    });

    const audit = await pool.query(
      `SELECT decision, outcome FROM houston_finance_action_audit`,
    );
    expect(audit.rows).toEqual([{ decision: 'approve', outcome: 'invalid-approval' }]);
    expect(apiMocks.streamChat).not.toHaveBeenCalled();
    expect(apiMocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('consumes an approved proposal exactly once across requests', async () => {
    const pool = await initialize();
    await seedPendingApproval();
    const { POST } = await import('@/app/api/ai/route');

    const first = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(first.status).toBe(200);
    expect(apiMocks.streamChat).toHaveBeenCalledTimes(1);

    const second = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(second.status).toBe(400);
    expect(apiMocks.streamChat).toHaveBeenCalledTimes(1);

    const audit = await pool.query(
      `SELECT outcome FROM houston_finance_action_audit ORDER BY created_at, id`,
    );
    expect(audit.rows).toEqual([{ outcome: 'invalid-approval' }]);
  });
});

afterAll(async () => {
  if (!initialized) return;
  const harness = await createHarness();
  await harness.reset();
  await backend.shutdown();
  apiMocks.finance = null;
  initialized = false;
});
