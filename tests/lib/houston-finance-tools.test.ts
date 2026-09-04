import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import {
  FINANCE_TOOL_NAMES,
  financeObligationsInputSchema,
  financeTransactionSearchInputSchema,
  householdFinanceSummaryInputSchema,
} from '@/lib/finance/houston-contracts';

vi.unmock('drizzle-orm');

const mocks = vi.hoisted(() => ({
  finance: null as FinanceCorePersistence | null,
  sqliteCompatibilityAccess: vi.fn(),
}));

// The Houston finance chain must reach persistence only through the registered
// worker composition. Any surviving `@/db` SQLite compatibility access fails
// the test rather than silently working on the SQLite backend.
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

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-houston-finance-'));
const databasePath = join(tempDirectory, 'houston-finance.db');
const connectorId = 'invented-finance-connector';
const now = '2026-08-13T12:00:00.000Z';
let sqlite: Database.Database;
let facade: typeof import('@/lib/finance/houston-tools');

function insertConnector(id = connectorId, name = 'Invented household finance') {
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', ?, 1, 'poll', 240, '{}',
      '{"serviceToken":"invented-service-token"}',
      '{"bridgeUrl":"http://localhost:8100","maxRetries":0}',
      '[]', ?, ?)
  `).run(id, name, now, now);
}

function seedProjection() {
  insertConnector();
  sqlite.prepare(`
    INSERT INTO finance_sync_state (
      connector_id, status, last_successful_sync_at, last_successful_source_as_of,
      last_successful_projection_coverage_start,
      last_successful_projection_coverage_end, last_successful_generation_id,
      attribution_status, attribution_last_successful_at, attribution_policy_version,
      created_at, updated_at
    ) VALUES (?, 'succeeded', ?, ?, '2026-08-01', '2026-08-13',
      'private-generation-id', 'healthy', ?, 7, ?, ?)
  `).run(connectorId, now, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO kid_profiles (
      id, name, color, daily_limit, weekly_limit, monthly_limit
    ) VALUES ('invented-kid-id', 'Avery', '#123456', 20, 80, 300)
  `).run();
  sqlite.prepare(`
    INSERT INTO kid_profiles (id, name, color)
    VALUES ('invented-second-kid-id', 'Blair', '#654321')
  `).run();
  sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, original_category, confirmed_category, account_id,
      account_name, card_last4, assigned_kid_id, triage_status, is_pending,
      is_recurring, notes, tags, lifecycle_status, provenance_provider,
      provenance_fetched_at, source_fingerprint, last_seen_generation_id,
      first_seen_at, last_seen_at, synced_at, attribution_status,
      attribution_confidence, attribution_method, attribution_explanation,
      attribution_reasons, attribution_review_state
    ) VALUES (
      'local-transaction-id', ?, 'raw-upstream-transaction-id', '2026-08-12', -42.75,
      'Invented Market', 'Food', 'Groceries', 'raw-account-id',
      'Private Account', '9876', 'invented-kid-id', 'pending', 0,
      0, 'private note', '[]', 'active', 'live', ?,
      'private-fingerprint', 'private-generation-id', ?, ?, ?, 'attributed',
      'likely', 'merchant-rule', 'Echo raw-account-id and private-fingerprint.',
      '[]', 'pending'
    )
  `).run(connectorId, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_subjects (
      id, connector_id, kid_id, policy_version, engine_version,
      first_seen_at, last_seen_at
    ) VALUES ('invented-subject', ?, 'invented-kid-id', 7, '1.0.0', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_subjects (
      id, connector_id, kid_id, policy_version, engine_version,
      first_seen_at, last_seen_at
    ) VALUES ('invented-second-subject', ?, 'invented-second-kid-id', 7, '1.0.0', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_categories (
      id, connector_id, upstream_category_id, name, is_active, source_is_active,
      last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES (
      'invented-category', ?, 'invented-upstream-category', 'Entertainment',
      1, 1, 'private-category-generation', ?, ?
    )
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, policy_version, occurrence_count,
      created_at, first_observed_at, last_observed_at, updated_at
    ) VALUES (
      'private-exception-id', ?, 'local-transaction-id', 'open',
      'low-confidence', 1, 'pending', 'private-exception-fingerprint',
      7, 1, ?, ?, ?, ?
    )
  `).run(connectorId, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_dataset_sync_state (
      connector_id, dataset, last_attempt_at, last_attempt_outcome,
      last_successful_at, source_as_of, fresh_until, coverage_start,
      coverage_end, current_generation_id, schema_version, config_version,
      published_item_count, source_limit, created_at, updated_at
    ) VALUES (
      ?, 'recurring', ?, 'succeeded', ?, ?, '2026-08-14T12:00:00.000Z',
      '2026-08-01', '2026-11-30', 'private-recurring-generation',
      '1.0', 1, 1, 5000, ?, ?
    )
  `).run(connectorId, now, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_recurring_obligations (
      id, connector_id, generation_id, upstream_recurring_id, merchant,
      amount, frequency, next_expected_date, upstream_account_id, account_name,
      upstream_category_id, category_name, is_current, source_as_of, created_at
    ) VALUES (
      'local-obligation-id', ?, 'private-recurring-generation',
      'raw-recurring-id', 'Invented Music', -12, 'monthly', '2026-08-20',
      'raw-account-id', 'Private Account', 'raw-category-id',
      'Subscriptions', 1, ?, ?
    )
  `).run(connectorId, now, now);
}

function mutationAuditStatus(): { status: string; code: string | null } | undefined {
  return sqlite.prepare(`
    SELECT status, last_error_code AS code
    FROM finance_mutation_audit
    WHERE idempotency_key LIKE 'houston:%'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get() as { status: string; code: string | null } | undefined;
}

async function currentProposal() {
  const transaction = (await facade.searchFinanceTransactions(
    { query: 'Market', limit: 1 },
    { now: new Date(now) },
  )).transactions[0];
  return {
    transactionRef: transaction.target.transactionRef,
    expected: {
      ...transaction.factsViaTyrionBridge,
      kidName: transaction.tyrionDerived.kidName,
      stateToken: transaction.target.stateToken,
    },
  };
}

beforeAll(async () => {
  sqlite = new Database(databasePath);
  sqlite.pragma('foreign_keys = ON');
  const { runOrderedDatabaseBootstrap } = await import('@/db/bootstrap/registry');
  runOrderedDatabaseBootstrap(sqlite, resolve(process.cwd(), 'drizzle'));
  const { createSqliteFinanceWorkerPersistence } = await import(
    '@/db/persistence/sqlite-finance-worker-repositories'
  );
  mocks.finance = createSqliteFinanceWorkerPersistence(sqlite);
  facade = await import('@/lib/finance/houston-tools');
});

afterAll(() => {
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('Houston finance facade', () => {
  it('uses strict, fixed input bounds', () => {
    expect(FINANCE_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(householdFinanceSummaryInputSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(financeTransactionSearchInputSchema.safeParse({ limit: 26 }).success).toBe(false);
    expect(financeTransactionSearchInputSchema.safeParse({
      startDate: '2025-01-01',
      endDate: '2026-08-13',
    }).success).toBe(false);
    expect(financeObligationsInputSchema.safeParse({ horizonDays: 366 }).success).toBe(false);
  });

  it('returns a sanitized stable error when no connector is configured', async () => {
    await expect(facade.getFinanceConnectorHealth({}, {
      now: new Date(now),
    })).rejects.toMatchObject({
      code: 'finance_not_configured',
      message: 'No enabled finance connector is configured.',
    });
  });

  it('rejects ambiguous connector selection explicitly', async () => {
    insertConnector('invented-first', 'Invented first');
    insertConnector('invented-second', 'Invented second');
    await expect(facade.getHouseholdFinanceSummary({}, {
      now: new Date(now),
    })).rejects.toMatchObject({ code: 'finance_connector_ambiguous' });
    sqlite.prepare('DELETE FROM connector_configs').run();
    seedProjection();
  });

  it('returns bounded source-labelled reads without sensitive projection fields', async () => {
    const [summary, transactions, exceptions, kid, obligations, health] = await Promise.all([
      facade.getHouseholdFinanceSummary({}, { now: new Date(now) }),
      facade.searchFinanceTransactions({ query: 'Market', limit: 10 }, { now: new Date(now) }),
      facade.getPendingFinanceExceptions({ limit: 10 }, { now: new Date(now) }),
      facade.getKidSpending({ kidName: 'Avery', limit: 10 }, { now: new Date(now) }),
      facade.getFinanceObligations({ horizonDays: 90, limit: 10 }, { now: new Date(now) }),
      facade.getFinanceConnectorHealth({}, { now: new Date(now) }),
    ]);

    expect(summary.meta).toMatchObject({
      sourceAsOf: now,
      coverage: { start: '2026-08-01', end: '2026-08-13' },
      freshness: 'fresh',
      truncated: false,
    });
    expect(summary.meta.provenance.map(item => item.label)).toEqual([
      'Monarch facts via Tyrion Bridge',
      'Tyrion-derived attribution/conclusions',
      'Mission Control-calculated aggregates',
    ]);
    expect(transactions.transactions[0]).toMatchObject({
      factsViaTyrionBridge: {
        merchant: 'Invented Market',
        amount: -42.75,
        pending: false,
        recurring: false,
      },
      tyrionDerived: {
        kidName: 'Avery',
        confidence: 'likely',
      },
    });
    expect(exceptions.exceptions[0]).toMatchObject({
      merchant: 'Invented Market',
      reason: 'low-confidence',
      retryable: true,
      kidName: 'Avery',
    });
    expect(kid.missionControlCalculated).toMatchObject({
      totalSpending: 42.75,
      monthlyLimit: 300,
    });
    expect(obligations).toMatchObject({
      missionControlCalculated: { estimatedMonthlyAmount: 12 },
      meta: { freshness: 'fresh' },
    });
    expect(health).toMatchObject({
      missionControlCalculated: { overall: 'degraded' },
      tyrionAttribution: { status: 'healthy' },
      meta: { freshness: 'partial' },
    });

    for (const result of [summary, transactions, exceptions, kid, obligations, health]) {
      const serialized = JSON.stringify(result);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(16 * 1024);
      for (const secret of [
        connectorId,
        'raw-upstream-transaction-id',
        'raw-account-id',
        '9876',
        'private-fingerprint',
        'private note',
        'private-generation-id',
        'private-exception-id',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
    expect(mocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });

  it('marks old and failed projections as stale or partial rather than current', async () => {
    const stale = await facade.searchFinanceTransactions({
      startDate: '2026-08-01',
      endDate: '2026-08-13',
    }, {
      now: new Date('2026-08-15T12:00:00.000Z'),
    });
    expect(stale.meta.freshness).toBe('stale');

    sqlite.prepare(`
      UPDATE finance_sync_state
      SET status = 'failed', last_error_code = 'invented_failure'
      WHERE connector_id = ?
    `).run(connectorId);
    const partial = await facade.getHouseholdFinanceSummary({}, { now: new Date(now) });
    expect(partial.meta.freshness).toBe('partial');
  });

  it('does not label requests outside persisted coverage as current', async () => {
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET status = 'succeeded', last_error_code = NULL
      WHERE connector_id = ?
    `).run(connectorId);
    const partial = await facade.getHouseholdFinanceSummary({
      startDate: '2026-07-20',
      endDate: '2026-08-05',
    }, { now: new Date(now) });
    expect(partial.meta.freshness).toBe('partial');

    const unavailable = await facade.searchFinanceTransactions({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    }, { now: new Date(now) });
    expect(unavailable.meta.freshness).toBe('unavailable');
  });

  it('does not label stale Tyrion attribution as current', async () => {
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET attribution_status = 'healthy',
          attribution_last_successful_at = '2026-08-01T12:00:00.000Z'
      WHERE connector_id = ?
    `).run(connectorId);
    const exceptions = await facade.getPendingFinanceExceptions(
      { limit: 10 },
      { now: new Date(now) },
    );
    expect(exceptions.meta.freshness).toBe('stale');
    const transactions = await facade.searchFinanceTransactions({
      startDate: '2026-08-01',
      endDate: '2026-08-13',
    }, { now: new Date(now) });
    expect(transactions.meta).toMatchObject({
      sourceAsOf: '2026-08-01T12:00:00.000Z',
      freshness: 'stale',
    });
  });

  it('applies an approved kid assignment once, preserves manual precedence, and redacts approval audit', async () => {
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET attribution_status = 'healthy', attribution_last_successful_at = ?
      WHERE connector_id = ?
    `).run(now, connectorId);
    const input = { ...(await currentProposal()), kidName: 'Blair' };
    const execution = {
      approvalId: 'invented-kid-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    };

    await expect(facade.assignFinanceTransactionKid(input, execution)).resolves.toMatchObject({
      status: 'updated',
      missionControlConfirmed: { kidName: 'Blair' },
      replayed: false,
    });
    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'deleted'
      WHERE id = 'local-transaction-id'
    `).run();
    await expect(facade.assignFinanceTransactionKid(input, execution)).resolves.toMatchObject({
      status: 'updated',
      replayed: true,
    });
    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'active'
      WHERE id = 'local-transaction-id'
    `).run();
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, attribution_method AS method,
             kid_assignment_method AS assignmentMethod
      FROM finance_transactions WHERE id = 'local-transaction-id'
    `).get()).toEqual({
      kidId: 'invented-second-kid-id',
      method: 'manual',
      assignmentMethod: 'manual',
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_attribution_audit
      WHERE transaction_id = 'local-transaction-id'
    `).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(`
      SELECT status FROM finance_attribution_exceptions WHERE id = 'private-exception-id'
    `).get()).toEqual({ status: 'resolved' });

    const approvalRows = sqlite.prepare(`
      SELECT correlation_id AS correlationId, call_hash AS callHash, tool,
             decision, outcome, duration_ms AS durationMs
      FROM houston_finance_action_audit
      WHERE tool = 'assignFinanceTransactionKid'
    `).all() as Array<Record<string, unknown>>;
    expect(approvalRows).toHaveLength(2);
    expect(approvalRows[0]).toMatchObject({
      correlationId: 'invented-correlation',
      tool: 'assignFinanceTransactionKid',
      decision: 'approve',
      outcome: 'succeeded',
    });
    const serialized = JSON.stringify(approvalRows);
    expect(serialized).not.toContain('local-transaction-id');
    expect(serialized).not.toContain('Blair');
    expect(serialized).not.toContain('Invented Market');
  });

  it('fails stale proposals closed before another attribution mutation', async () => {
    const proposal = await currentProposal();
    sqlite.prepare(`
      UPDATE finance_transactions SET last_seen_at = '2026-08-13T13:00:00.000Z'
      WHERE id = 'local-transaction-id'
    `).run();
    const result = await facade.assignFinanceTransactionKid({
      ...proposal,
      kidName: 'Avery',
    }, {
      approvalId: 'invented-stale-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'target_stale', retryable: false },
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_attribution_audit
    `).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(`
      SELECT outcome FROM houston_finance_action_audit
      WHERE call_hash = 'invented-stale-approval'
    `).get()).toEqual({ outcome: 'stale' });
  });

  it('fails closed when the source or attribution projection is stale', async () => {
    const proposal = await currentProposal();
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET last_successful_source_as_of = '2026-07-01T12:00:00.000Z',
          attribution_last_successful_at = '2026-07-01T12:00:00.000Z'
      WHERE connector_id = ?
    `).run(connectorId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(facade.assignFinanceTransactionKid({
      ...proposal,
      kidName: 'Avery',
    }, {
      approvalId: 'invented-stale-projection-kid-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'target_stale' },
    });
    await expect(facade.updateFinanceTransactionCategory({
      ...proposal,
      categoryName: 'Entertainment',
    }, {
      approvalId: 'invented-stale-projection-category-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'target_stale' },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    sqlite.prepare(`
      UPDATE finance_sync_state
      SET last_successful_source_as_of = ?,
          attribution_last_successful_at = ?
      WHERE connector_id = ?
    `).run(now, now, connectorId);
  });

  it('keeps category state unchanged on upstream failure and confirms only verified writes', async () => {
    const input = { ...(await currentProposal()), categoryName: 'Entertainment' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      error: { code: 'upstream_unavailable', message: 'invented private failure' },
    }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-monarch-contract-version': '1.0',
      },
    })));
    const failed = await facade.updateFinanceTransactionCategory(input, {
      approvalId: 'invented-category-failure-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    });
    expect(mutationAuditStatus()).toEqual({ status: 'failed', code: 'upstream_unavailable' });
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'upstream_unavailable', retryable: true },
    });
    expect(sqlite.prepare(`
      SELECT confirmed_category AS category
      FROM finance_transactions WHERE id = 'local-transaction-id'
    `).get()).toEqual({ category: 'Groceries' });

    // The provider observes a committed `processing` claim, proving no
    // database transaction is held across the externally-observable request.
    const observed: Array<string | undefined> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      observed.push(mutationAuditStatus()?.status);
      return Promise.resolve(new Response(JSON.stringify({
        contractVersion: '1.0',
        status: 'updated',
        transactionId: 'raw-upstream-transaction-id',
        categoryId: 'invented-upstream-category',
      }), {
        headers: {
          'content-type': 'application/json',
          'x-monarch-contract-version': '1.0',
        },
      }));
    }));
    const updated = await facade.updateFinanceTransactionCategory(input, {
      approvalId: 'invented-category-success-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    });
    expect(observed).toEqual(['processing']);
    expect(mutationAuditStatus()).toEqual({ status: 'succeeded', code: null });
    expect(updated).toMatchObject({
      status: 'updated',
      factsViaTyrionBridge: { category: 'Entertainment' },
      replayed: false,
    });

    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'deleted'
      WHERE id = 'local-transaction-id'
    `).run();
    sqlite.prepare(`
      UPDATE finance_categories SET source_is_active = 0
      WHERE connector_id = ? AND upstream_category_id = 'invented-upstream-category'
    `).run(connectorId);
    await expect(facade.updateFinanceTransactionCategory(input, {
      approvalId: 'invented-category-success-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    })).resolves.toMatchObject({
      status: 'updated',
      factsViaTyrionBridge: { category: 'Entertainment' },
      replayed: true,
    });
    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'active'
      WHERE id = 'local-transaction-id'
    `).run();
    sqlite.prepare(`
      UPDATE finance_categories SET source_is_active = 1
      WHERE connector_id = ? AND upstream_category_id = 'invented-upstream-category'
    `).run(connectorId);
    expect(sqlite.prepare(`
      SELECT confirmed_category AS category
      FROM finance_transactions WHERE id = 'local-transaction-id'
    `).get()).toEqual({ category: 'invented-upstream-category' });
    const reread = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
    expect(reread.factsViaTyrionBridge.category).toBe('Entertainment');
    expect(JSON.stringify(reread)).not.toContain('invented-upstream-category');
  });

  it('rejects a category proposal when the approved target state has changed', async () => {
    const proposal = await currentProposal();
    sqlite.prepare(`
      UPDATE finance_transactions SET confirmed_category = 'Changed category'
      WHERE id = 'local-transaction-id'
    `).run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const mutationsBefore = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_mutation_audit
    `).get();

    const result = await facade.updateFinanceTransactionCategory({
      ...proposal,
      categoryName: 'Entertainment',
    }, {
      approvalId: 'invented-stale-category-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'target_stale', retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_mutation_audit
    `).get()).toEqual(mutationsBefore);
    sqlite.prepare(`
      UPDATE finance_transactions SET confirmed_category = 'invented-upstream-category'
      WHERE id = 'local-transaction-id'
    `).run();
  });

  it('surfaces sanitized errors for unknown or ambiguous household members', async () => {
    await expect(facade.getKidSpending({ kidName: 'Nobody' }, { now: new Date(now) }))
      .rejects.toMatchObject({ code: 'finance_kid_not_found' });

    sqlite.prepare(`
      INSERT INTO kid_profiles (id, name, color)
      VALUES ('invented-duplicate-kid-id', 'avery', '#abcdef')
    `).run();
    await expect(facade.getKidSpending({ kidName: 'Avery' }, { now: new Date(now) }))
      .rejects.toMatchObject({ code: 'finance_kid_ambiguous' });
    sqlite.prepare(`DELETE FROM kid_profiles WHERE id = 'invented-duplicate-kid-id'`).run();
  });

  it('never reaches SQLite compatibility persistence', () => {
    expect(mocks.sqliteCompatibilityAccess).not.toHaveBeenCalled();
  });
});
