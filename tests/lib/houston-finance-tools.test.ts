import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FINANCE_TOOL_NAMES,
  financeObligationsInputSchema,
  financeTransactionSearchInputSchema,
  householdFinanceSummaryInputSchema,
} from '@/lib/finance/houston-contracts';

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

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  const dbModule = await import('@/db');
  sqlite = dbModule.sqlite;
  facade = await import('@/lib/finance/houston-tools');
});

afterAll(() => {
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('Houston finance facade', () => {
  it('uses strict, fixed input bounds', () => {
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
      },
      tyrionDerived: {
        kidName: 'Avery',
        confidence: 'likely',
      },
    });
    expect(exceptions.exceptions[0]).toMatchObject({
      merchant: 'Invented Market',
      reason: 'low-confidence',
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
    const transaction = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
    const input = {
      transactionRef: transaction.target.transactionRef,
      expected: {
        ...transaction.factsViaTyrionBridge,
        kidName: transaction.tyrionDerived.kidName,
        stateToken: transaction.target.stateToken,
      },
      kidName: 'Blair',
    };
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
    const transaction = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
    sqlite.prepare(`
      UPDATE finance_transactions SET last_seen_at = '2026-08-13T13:00:00.000Z'
      WHERE id = 'local-transaction-id'
    `).run();
    const result = await facade.assignFinanceTransactionKid({
      transactionRef: transaction.target.transactionRef,
      expected: {
        ...transaction.factsViaTyrionBridge,
        kidName: transaction.tyrionDerived.kidName,
        stateToken: transaction.target.stateToken,
      },
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
  });

  it('fails closed when the source or attribution projection is stale', async () => {
    const current = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
    const expected = {
      ...current.factsViaTyrionBridge,
      kidName: current.tyrionDerived.kidName,
      stateToken: current.target.stateToken,
    };
    sqlite.prepare(`
      UPDATE finance_sync_state
      SET last_successful_source_as_of = '2026-07-01T12:00:00.000Z',
          attribution_last_successful_at = '2026-07-01T12:00:00.000Z'
      WHERE connector_id = ?
    `).run(connectorId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(facade.assignFinanceTransactionKid({
      transactionRef: current.target.transactionRef,
      expected,
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
      transactionRef: current.target.transactionRef,
      expected,
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
    const current = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
    const input = {
      transactionRef: current.target.transactionRef,
      expected: {
        ...current.factsViaTyrionBridge,
        kidName: current.tyrionDerived.kidName,
        stateToken: current.target.stateToken,
      },
      categoryName: 'Entertainment',
    };
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
    expect(sqlite.prepare(`
      SELECT status, last_error_code AS code
      FROM finance_mutation_audit
      WHERE idempotency_key LIKE 'houston:%'
      ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({ status: 'failed', code: 'upstream_unavailable' });
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'upstream_unavailable', retryable: true },
    });
    expect(sqlite.prepare(`
      SELECT confirmed_category AS category
      FROM finance_transactions WHERE id = 'local-transaction-id'
    `).get()).toEqual({ category: 'Groceries' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contractVersion: '1.0',
      status: 'updated',
      transactionId: 'raw-upstream-transaction-id',
      categoryId: 'invented-upstream-category',
    }), {
      headers: {
        'content-type': 'application/json',
        'x-monarch-contract-version': '1.0',
      },
    })));
    const updated = await facade.updateFinanceTransactionCategory(input, {
      approvalId: 'invented-category-success-approval',
      correlationId: 'invented-correlation',
      now: new Date(now),
    });
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
    const current = (await facade.searchFinanceTransactions(
      { query: 'Market', limit: 1 },
      { now: new Date(now) },
    )).transactions[0];
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
      transactionRef: current.target.transactionRef,
      expected: {
        ...current.factsViaTyrionBridge,
        kidName: current.tyrionDerived.kidName,
        stateToken: current.target.stateToken,
      },
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
  });

  it('rechecks approved transaction versions inside both domain mutation claims', async () => {
    const attribution = await import(
      '@/lib/connectors/monarch-money/attribution-service'
    );
    const snapshot = await import('@/lib/connectors/monarch-money/snapshot-sync');
    const version = sqlite.prepare(`
      SELECT source_fingerprint AS sourceFingerprint,
             last_seen_at AS lastSeenAt, assigned_kid_id AS assignedKidId,
             confirmed_category AS confirmedCategory,
             manual_decided_at AS manualDecidedAt
      FROM finance_transactions WHERE id = 'local-transaction-id'
    `).get() as {
      sourceFingerprint: string;
      lastSeenAt: string;
      assignedKidId: string | null;
      confirmedCategory: string | null;
      manualDecidedAt: string | null;
    };
    sqlite.prepare(`
      UPDATE finance_transactions SET last_seen_at = '2026-08-13T14:00:00.000Z'
      WHERE id = 'local-transaction-id'
    `).run();

    expect(() => attribution.applyManualAttributionDecision({
      connectorId,
      transactionId: 'local-transaction-id',
      action: 'assign-kid',
      kidId: 'invented-kid-id',
      idempotencyKey: 'invented-atomic-kid-claim',
      actorType: 'parent-admin',
      expectedTransactionVersion: version,
    })).toThrowError(expect.objectContaining({ code: 'transaction_conflict' }));

    const categoryVersion = {
      ...version,
      lastSeenAt: '2026-08-13T14:00:00.000Z',
      categoryName: 'Entertainment',
    };
    sqlite.prepare(`
      UPDATE finance_categories SET source_is_active = 0
      WHERE connector_id = ? AND upstream_category_id = 'invented-upstream-category'
    `).run(connectorId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(snapshot.updateFinanceCategory({
      id: connectorId,
      type: 'finance-manager',
      name: 'Invented household finance',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 240,
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: false,
        tags: false,
        tagWriteBack: false,
      },
      credentials: { serviceToken: 'invented-service-token' },
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
      syncedLists: [],
    }, 'local-transaction-id', 'invented-upstream-category',
    'invented-atomic-category-claim', undefined, categoryVersion))
      .rejects.toMatchObject({ code: 'category_conflict' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exports and registers exactly the six production read contracts', async () => {
    expect(FINANCE_TOOL_NAMES).toEqual([
      'getHouseholdFinanceSummary',
      'searchFinanceTransactions',
      'getPendingFinanceExceptions',
      'getKidSpending',
      'getFinanceObligations',
      'getFinanceConnectorHealth',
    ]);
    const { financeTools } = await import('@/lib/ai/tools/finance-tools');
    expect(Object.keys(financeTools)).toEqual(FINANCE_TOOL_NAMES);
    expect(Object.keys(financeTools)).not.toContain('assignFinanceTransactionKid');
    expect(Object.keys(financeTools)).not.toContain('updateFinanceTransactionCategory');
  });
});
