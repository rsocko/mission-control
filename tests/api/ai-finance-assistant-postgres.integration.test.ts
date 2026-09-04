import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceWorkerPersistence } from '@/db/postgres/repositories/finance-worker-repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

/**
 * Scoped PostgreSQL proof for the L09 Houston finance approval seam of
 * `POST /api/ai`.
 *
 * This test does NOT claim the AI route is PostgreSQL-clean: the route remains
 * Tier A through excluded L10 AI-core dependencies. Every module mocked below
 * is an explicitly excluded L10 dependency (provider/config resolution,
 * context selection, admission control, runtime lifecycle, logging, and the
 * non-finance Houston tool surface). What is proven here is that the finance
 * approval consume, the redacted approval audit, and the pending approval
 * lifecycle reach live PostgreSQL with `@/db` SQLite compatibility poisoned.
 */
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

const mocks = vi.hoisted(() => ({
  finance: null as FinanceCorePersistence | null,
  sqliteCompatibilityAccess: vi.fn(),
  streamChat: vi.fn(),
}));

vi.mock('@/db', () => {
  const forbidden = new Proxy({}, {
    get() {
      mocks.sqliteCompatibilityAccess();
      throw new Error('SQLite compatibility persistence was reached');
    },
  });
  return { sqlite: forbidden, db: forbidden, default: forbidden };
});

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => {
    if (!mocks.finance) throw new Error('Finance persistence is not registered');
    return { finance: mocks.finance };
  },
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  getAIRouteOutcome: () => ({ route: 'local' }),
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({ configured: true, provider: 'openai' }),
}));

vi.mock('@/lib/ai/features/chat', () => ({
  streamChat: mocks.streamChat,
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
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-ai-finance-assistant',
        }),
      }
    : {}),
});
let pool: Pool | null = null;

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

async function initialize(): Promise<Pool> {
  if (!pool) {
    if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
    assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    pool = backend.context.pool;
    mocks.finance = createPostgresFinanceWorkerPersistence(pool);
  }
  return pool;
}

async function seedPendingApproval(): Promise<void> {
  const database = await initialize();
  await database.query(
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
    const database = await initialize();
    await database.query('DELETE FROM houston_finance_pending_approvals');
    await database.query('DELETE FROM houston_finance_action_audit');
    mocks.streamChat.mockReset();
    mocks.streamChat.mockResolvedValue({
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
    const database = await initialize();
    await seedPendingApproval();
    const { POST } = await import('@/app/api/ai/route');

    const response = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(false)] }),
    }));
    expect(response.status).toBe(200);

    const pending = await database.query(
      `SELECT approval_id FROM houston_finance_pending_approvals WHERE approval_id = $1`,
      [APPROVAL_ID],
    );
    expect(pending.rowCount).toBe(0);

    const audit = await database.query(
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
    expect(mocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('rejects an unknown approval and records the invalid-approval audit', async () => {
    const database = await initialize();
    const { POST } = await import('@/app/api/ai/route');

    const response = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'The finance approval is invalid, expired, or has already been used.',
    });

    const audit = await database.query(
      `SELECT decision, outcome FROM houston_finance_action_audit`,
    );
    expect(audit.rows).toEqual([{ decision: 'approve', outcome: 'invalid-approval' }]);
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(mocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('consumes an approved proposal exactly once across requests', async () => {
    const database = await initialize();
    await seedPendingApproval();
    const { POST } = await import('@/app/api/ai/route');

    const first = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(first.status).toBe(200);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);

    const second = await POST(new Request('http://localhost/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [approvalMessage(true)] }),
    }));
    expect(second.status).toBe(400);
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);

    const audit = await database.query(
      `SELECT outcome FROM houston_finance_action_audit ORDER BY created_at, id`,
    );
    expect(audit.rows).toEqual([{ outcome: 'invalid-approval' }]);
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM houston_finance_pending_approvals');
  await pool.query('DELETE FROM houston_finance_action_audit');
  await backend.shutdown();
  pool = null;
});
