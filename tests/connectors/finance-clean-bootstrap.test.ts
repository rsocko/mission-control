import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-clean-bootstrap-'));
process.env.MC_DB_PATH = join(directory, 'bootstrap.db');
process.env.FINANCE_MANAGER_API_TOKEN = 'invented-service-token';
delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
delete process.env.TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED;
delete process.env.TYRION_FINANCE_INSIGHTS_WEEKLY_SUMMARY_NOTIFICATIONS_ENABLED;

const connectorId = 'finance-clean-bootstrap-test';
const now = '2026-10-10T04:00:00.000Z';
const identityNamespace = 'a'.repeat(64);

let sqlite: typeof import('@/db').sqlite;
let operator: typeof import('@/lib/sync/operator-control');
let bootstrap: typeof import('@/lib/connectors/monarch-money/clean-bootstrap');
let leases: typeof import('@/lib/sync/connector-lock-runtime');

function key(suffix: string): string {
  return `finance-clean-bootstrap-${suffix.padEnd(18, 'x')}`;
}

function insertTransaction(options: { manual?: boolean } = {}): void {
  sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, account_id, assigned_kid_id, kid_assignment_method,
      manual_decision_action, manual_decided_at, synced_at
    ) VALUES (?, ?, ?, '2026-10-01', 42, 'Private merchant', 'direct-account',
      ?, ?, ?, ?, ?)
  `).run(
    'transaction-1',
    connectorId,
    'upstream-private-1',
    options.manual ? 'private-kid' : null,
    options.manual ? 'manual' : 'historical-pattern',
    options.manual ? 'assign-kid' : null,
    options.manual ? now : null,
    now,
  );
}

function insertNotification(): void {
  sqlite.prepare(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, body,
      received_at, sort_at, metadata, presentation
    ) VALUES (
      'notification-1', ?, 'finance-manager', ?, 'Private title',
      'Private body', ?, ?, '{}', '{}'
    )
  `).run(`finance-insight:${connectorId}:private-occurrence`, connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO notification_actions (
      id, notification_id, action_type, label
    ) VALUES ('action-1', 'notification-1', 'review', 'Review')
  `).run();
}

function insertDerivedState(options: { manual?: boolean } = {}): void {
  insertTransaction(options);
  sqlite.prepare(`
    INSERT INTO finance_accounts (
      id, connector_id, upstream_account_id, display_name, type,
      last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES ('account-1', ?, 'direct-account', 'Private account', 'credit',
      'legacy-generation', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, created_at, first_observed_at,
      last_observed_at, updated_at
    ) VALUES (
      'exception-1', ?, 'transaction-1', 'open', 'no-match', 1, 'pending',
      'private-fingerprint', ?, ?, ?, ?
    )
  `).run(connectorId, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_projection_state (
      connector_id, status, created_at, updated_at
    ) VALUES (?, 'succeeded', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_projection_facts (
      connector_id, generation_id, source_ref, occurred_on, payload
    ) VALUES (?, 'legacy-generation', 'private-source-ref', '2026-10-01', '{}')
  `).run(connectorId);
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_backfill_plans (
      id, connector_id, idempotency_key, horizon_months, coverage_start,
      coverage_end, currency, bridge_contract_version, window_count,
      next_window_ordinal, status, created_at, updated_at
    ) VALUES (
      'backfill-1', ?, 'legacy-backfill-key', 37, '2023-10-01', '2026-10-01',
      'USD', 'v3', 1, 1, 'completed', ?, ?
    )
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_insight_transaction_window_proofs (
      plan_id, connector_id, window_ordinal, generation_ref, window_start,
      window_end, source_as_of, item_count, content_digest, currency,
      bridge_contract_version, created_at
    ) VALUES (
      'backfill-1', ?, 0, 'legacy-generation', '2023-10-01', '2026-10-01',
      ?, 12803, 'legacy-digest', 'USD', 'v3', ?
    )
  `).run(connectorId, now, now);
  insertNotification();
  sqlite.prepare(`
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title,
      created_at, updated_at, last_synced_at
    ) VALUES (
      'task-1', 'finance-attention:private', 'finance-manager', ?,
      'Private task', ?, ?, ?
    )
  `).run(connectorId, now, now, now);
}

async function dryRun(suffix = 'dry-run') {
  return bootstrap.inventoryFinanceCleanBootstrap({
    connectorId,
    actorType: 'service',
    idempotencyKey: key(suffix),
  });
}

async function apply(
  inventory: Awaited<ReturnType<typeof dryRun>>,
  suffix = 'apply',
) {
  return bootstrap.applyFinanceCleanBootstrap({
    connectorId,
    actorType: 'service',
    idempotencyKey: key(suffix),
    dryRunId: inventory.dryRunId,
    scopeDigest: inventory.scopeDigest,
    confirmationToken: inventory.confirmationToken,
  });
}

beforeAll(async () => {
  const database = await import('@/db');
  ({ sqlite } = database);
  await database.initializeSqlitePersistenceComposition();
  const { registerSqliteSyncInfrastructure } = await import(
    '@/db/persistence/sqlite-sync-runtime'
  );
  registerSqliteSyncInfrastructure();
  operator = await import('@/lib/sync/operator-control');
  bootstrap = await import('@/lib/connectors/monarch-money/clean-bootstrap');
  leases = await import('@/lib/sync/connector-lock-runtime');
});

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
    contractVersion: '3.0',
    engineVersion: '3.0.0',
    policyVersion: 3,
    policyUpdatedAt: now,
    householdCurrency: 'USD',
  })));
  sqlite.exec(`
    DELETE FROM finance_clean_bootstrap_audit;
    DELETE FROM finance_insight_transaction_window_proofs;
    DELETE FROM finance_insight_transaction_backfill_plans;
    DELETE FROM finance_insight_transaction_projection_facts;
    DELETE FROM finance_insight_transaction_projection_windows;
    DELETE FROM finance_insight_transaction_projection_state;
    DELETE FROM finance_attribution_audit;
    DELETE FROM finance_attribution_exceptions;
    DELETE FROM finance_attribution_subjects;
    DELETE FROM finance_accounts;
    DELETE FROM finance_transactions;
    DELETE FROM notification_delivery_events;
    DELETE FROM notification_actions;
    DELETE FROM notifications;
    DELETE FROM tasks;
    DELETE FROM connector_sync_operator_runs;
    DELETE FROM connector_sync_controls;
    DELETE FROM connector_operation_leases;
    DELETE FROM sync_job_events;
    DELETE FROM sync_jobs;
    DELETE FROM sync_schedules;
    DELETE FROM connector_configs;
  `);
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at, deleted_at
    ) VALUES (?, 'finance-manager', 'Tyrion', 0, 'poll', 240, '{}', ?, ?, '[]', ?, ?, NULL)
  `).run(
    connectorId,
    JSON.stringify({ identityNamespace, token: 'preserved-secret' }),
    JSON.stringify({ bridgeUrl: 'https://tyrion.example/api/connector/v1' }),
    now,
    now,
  );
  await operator.quarantineFinanceConnectorSync({
    connectorId,
    actorType: 'service',
    idempotencyKey: key('quarantine'),
  });
});

afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
  delete process.env.FINANCE_MANAGER_API_TOKEN;
  vi.unstubAllGlobals();
});

describe.sequential('finance clean-current-state bootstrap', () => {
  it('inventories aggregate-only scope, applies atomically, and replays idempotently', async () => {
    insertDerivedState();
    const inventory = await dryRun();

    expect(inventory.inventory).toEqual({
      manualAttributionDecisions: 0,
      automatedAttributionExceptions: 1,
      financeNotifications: 1,
      financeTasks: 1,
      accountProjections: 1,
      transactionProjections: 1,
      historyProjections: 1,
      backfillPlans: 1,
      backfillProofs: 1,
      activeDeliveryWork: 0,
      activeActionWork: 0,
    });
    expect(JSON.stringify(inventory)).not.toContain('Private');
    expect(inventory.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.confirmationToken).toMatch(/^[a-f0-9]{64}$/);

    const result = await apply(inventory);
    const replay = await apply(inventory);
    expect(result.replayed).toBe(false);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(sqlite.prepare(`
      SELECT credentials, settings, enabled FROM connector_configs WHERE id = ?
    `).get(connectorId)).toEqual({
      credentials: JSON.stringify({ identityNamespace, token: 'preserved-secret' }),
      settings: JSON.stringify({ bridgeUrl: 'https://tyrion.example/api/connector/v1' }),
      enabled: 0,
    });
    expect(sqlite.prepare(`
      SELECT scheduler_state AS state FROM connector_sync_controls WHERE connector_id = ?
    `).get(connectorId)).toEqual({ state: 'quarantined' });
    expect(sqlite.prepare(`
      SELECT state, source_state AS sourceState, is_actionable AS actionable
      FROM notifications WHERE id = 'notification-1'
    `).get()).toEqual({ state: 'resolved', sourceState: 'resolved', actionable: 0 });
    expect(sqlite.prepare(`
      SELECT status, local_disposition AS disposition, status_reason AS reason
      FROM tasks WHERE id = 'task-1'
    `).get()).toEqual({
      status: 'cancelled',
      disposition: 'handled',
      reason: 'not_planned',
    });
    expect(sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM finance_transactions WHERE connector_instance_id = ?) AS transactions,
        (SELECT COUNT(*) FROM finance_accounts WHERE connector_id = ?) AS accounts,
        (SELECT COUNT(*) FROM finance_attribution_exceptions WHERE connector_id = ?) AS exceptions,
        (SELECT COUNT(*) FROM finance_insight_transaction_backfill_plans WHERE connector_id = ?) AS plans
    `).get(connectorId, connectorId, connectorId, connectorId)).toEqual({
      transactions: 0,
      accounts: 0,
      exceptions: 0,
      plans: 0,
    });
  });

  it('refuses apply when any manual attribution decision exists', async () => {
    insertDerivedState({ manual: true });
    const inventory = await dryRun('manual-dry-run');
    expect(inventory.inventory.manualAttributionDecisions).toBe(1);
    await expect(apply(inventory, 'manual-apply')).rejects.toThrowError(
      expect.objectContaining({
        code: 'finance_clean_bootstrap_manual_decisions_present',
      }),
    );
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM finance_transactions WHERE connector_instance_id = ?`,
    ).get(connectorId)).toEqual({ count: 1 });
  });

  it('detects scope drift after inventory and fails closed', async () => {
    insertDerivedState();
    const inventory = await dryRun('drift-dry-run');
    sqlite.prepare(`DELETE FROM finance_accounts WHERE id = 'account-1'`).run();
    sqlite.prepare(`
      INSERT INTO finance_accounts (
        id, connector_id, upstream_account_id, display_name, type,
        last_seen_generation_id, first_seen_at, last_seen_at
      ) VALUES ('account-2', ?, 'direct-account-2', 'Private account 2', 'credit',
        'legacy-generation', ?, ?)
    `).run(connectorId, now, now);
    expect(inventory.inventory.accountProjections).toBe(1);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM finance_accounts WHERE connector_id = ?`,
    ).get(connectorId)).toEqual({ count: 1 });

    await expect(apply(inventory, 'drift-apply')).rejects.toThrowError(
      expect.objectContaining({ code: 'finance_clean_bootstrap_scope_drift' }),
    );
  });

  it('refuses in-flight delivery work', async () => {
    insertDerivedState();
    sqlite.prepare(`
      INSERT INTO notification_delivery_events (
        id, notification_id, dedupe_key, status, policy_snapshot,
        payload_snapshot, created_at
      ) VALUES ('delivery-1', 'notification-1', 'delivery-private', 'pending', '{}', '{}', ?)
    `).run(now);
    const inventory = await dryRun('delivery-dry-run');
    expect(inventory.inventory.activeDeliveryWork).toBe(1);
    await expect(apply(inventory, 'delivery-apply')).rejects.toThrowError(
      expect.objectContaining({ code: 'finance_clean_bootstrap_in_flight_work' }),
    );
  });

  it('refuses every notification gate, including weekly summaries', async () => {
    process.env.TYRION_FINANCE_INSIGHTS_WEEKLY_SUMMARY_NOTIFICATIONS_ENABLED = 'true';
    try {
      await expect(dryRun('weekly-gate')).rejects.toThrowError(
        expect.objectContaining({ code: 'finance_insight_repair_gates_enabled' }),
      );
    } finally {
      delete process.env.TYRION_FINANCE_INSIGHTS_WEEKLY_SUMMARY_NOTIFICATIONS_ENABLED;
    }
  });

  it('refuses a concurrent operation while another connector lease is held', async () => {
    const repository = await leases.getConnectorOperationLeaseRepository();
    const leaseAt = new Date().toISOString();
    const acquired = await repository.acquire({
      connectorId,
      operationType: 'retention',
      owner: 'retention:competing-operator',
      leaseDurationMs: 60_000,
      at: leaseAt,
    });
    expect(acquired.status).toBe('acquired');
    await expect(dryRun('lease-race')).rejects.toThrowError(
      expect.objectContaining({ code: 'finance_clean_bootstrap_busy' }),
    );
    await repository.release({
      connectorId,
      owner: 'retention:competing-operator',
    });
  });
});
