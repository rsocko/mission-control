import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-overview-'));
const databasePath = join(tempDirectory, 'overview.db');
const connectorId = 'finance-overview-api';
let sqlite: Database.Database;

function trustedServiceRequest() {
  return new Request('https://mc.example/api/finance/overview', {
    headers: {
      'x-mc-api-key': 'test-finance-api-key',
    },
  });
}

function trustedBrowserRequest() {
  return {
    url: 'http://next-internal:3099/api/finance/overview',
    headers: new Headers({
      host: 'next-internal:3099',
      'x-forwarded-host': 'mc.example',
      'x-forwarded-proto': 'https',
      referer: 'https://mc.example/finance',
      'sec-fetch-site': 'same-origin',
    }),
  } as Request;
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  process.env.MC_API_KEY = 'test-finance-api-key';
  vi.resetModules();
  const dbModule = await import('@/db');
  sqlite = dbModule.sqlite;
  const now = '2026-08-08T12:00:00.000Z';
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', 'Tyrion household', 1, 'poll', '{}', '{}', '{}', '[]', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_sync_state (
      connector_id, status, attribution_status, attribution_policy_version,
      created_at, updated_at
    ) VALUES (?, 'succeeded', 'healthy', 7, ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO kid_profiles (id, name, color, monthly_limit)
    VALUES ('kid-one', 'Alex', '#3b82f6', 100)
  `).run();
  sqlite.prepare(`
    INSERT INTO finance_attribution_subjects (
      id, connector_id, kid_id, policy_version, engine_version, first_seen_at, last_seen_at
    ) VALUES ('subject-one', ?, 'kid-one', 7, '1.0.0', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, assigned_kid_id, triage_status, is_pending, is_recurring,
      tags, lifecycle_status, source_fingerprint, first_seen_at, last_seen_at, synced_at
    ) VALUES (
      'finance:overview:transaction', ?, 'transaction-one', ?, -85,
      'Invented merchant', 'kid-one', 'pending', 0, 0,
      '[]', 'active', 'source-hash', ?, ?, ?
    )
  `).run(connectorId, `${new Date().toISOString().slice(0, 7)}-02`, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, occurrence_count,
      created_at, first_observed_at, last_observed_at, updated_at
    ) VALUES (
      'exception-one', ?, 'finance:overview:transaction', 'open', 'low-confidence', 1,
      'pending', 'source-hash', 1, ?, ?, ?, ?
    )
  `).run(connectorId, now, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_mutation_audit (
      id, idempotency_key, connector_id, transaction_id, upstream_transaction_id,
      operation, requested_value, status, attempt_count, created_at, updated_at
    ) VALUES (
      'audit-one', 'category-writeback-0001', ?, 'finance:overview:transaction',
      'transaction-one', 'category_update', 'Groceries', 'failed', 1, ?, ?
    )
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, body,
      level, level_rank, category, state, is_actionable, received_at, sort_at,
      reconcile_attempts, metadata, presentation
    ) VALUES (
      'notification-one', 'source-one', 'finance-manager', ?, 'Allowance review',
      'A bounded household alert.', 'action_needed', 1, 'finance', 'unread', 1,
      ?, ?, 0, '{}', '{}'
    )
  `).run(connectorId, now, now);
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
  delete process.env.MONARCH_WEB_URL;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance operations overview API', () => {
  it('discovers the legacy Finance connector alias', async () => {
    sqlite.prepare(`UPDATE connector_configs SET type = 'finance' WHERE id = ?`).run(connectorId);
    try {
      const { GET } = await import('@/app/api/finance/overview/route');
      const response = await GET(trustedServiceRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        connector: { id: connectorId, name: 'Tyrion household' },
      });
    } finally {
      sqlite.prepare(`UPDATE connector_configs SET type = 'finance-manager' WHERE id = ?`)
        .run(connectorId);
    }
  });

  it('returns only bounded authoritative attention aggregates and safe links', async () => {
    const { GET } = await import('@/app/api/finance/overview/route');
    const response = await GET(trustedBrowserRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      connector: { id: connectorId, name: 'Tyrion household' },
      attention: {
        pendingExceptions: 1,
        retryRequested: 0,
        failedWritebacks: 1,
        openAlerts: 1,
      },
      alerts: [{ title: 'Allowance review', summary: 'A bounded household alert.' }],
      subjects: [{ name: 'Alex', policyStatus: 'current', limitStatus: 'unavailable' }],
      links: {
        monarch: { transactions: 'https://app.monarchmoney.com/transactions' },
        tyrionConfiguration: 'https://tyrion.example/configuration',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/upstreamTransactionId|sourceRef|fingerprint|lastErrorMessage/i);
  });

  it('rejects untrusted reads and unsafe configured external links', async () => {
    const { GET } = await import('@/app/api/finance/overview/route');
    const forbidden = await GET(new Request('https://mc.example/api/finance/overview', {
      headers: {
        host: 'mc.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
    }));
    expect(forbidden.status).toBe(403);

    process.env.MONARCH_WEB_URL = 'http://attacker.example';
    const unsafe = await GET(trustedServiceRequest());
    expect(unsafe.status).toBe(503);
    expect(await unsafe.json()).toMatchObject({ code: 'unsafe_external_link' });
    delete process.env.MONARCH_WEB_URL;
  });
});
