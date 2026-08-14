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
    ) VALUES (?, 'finance-manager', ?, 1, 'poll', 240, '{}', '{}', '{}', '[]', ?, ?)
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
  });
});
