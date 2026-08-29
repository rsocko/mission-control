import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { requestRetryMock } = vi.hoisted(() => ({
  requestRetryMock: vi.fn(),
}));

vi.mock('@/lib/finance/attribution-retry', () => ({
  requestFinanceAttributionRetry: requestRetryMock,
}));

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-attribution-api-'));
const databasePath = join(tempDirectory, 'attribution.db');
const connectorId = 'finance-attribution-api';
const transactionId = `finance:${connectorId}:transaction-one`;
const exceptionId = 'exception-one';
let sqlite: Database.Database;

function trustedHeaders(idempotencyKey?: string): HeadersInit {
  return {
    host: 'mc.example',
    origin: 'https://mc.example',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-mc-api-key': 'test-finance-api-key',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
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
    ) VALUES (?, 'finance-manager', 'Tyrion test', 1, 'poll', '{}', '{}', '{}', '[]', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_sync_state (
      connector_id, status, attribution_status, attribution_policy_version,
      created_at, updated_at
    ) VALUES (?, 'succeeded', 'healthy', 7, ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, account_id, card_last4, assigned_kid_id,
      kid_assignment_method, triage_status, is_pending, is_recurring, tags,
      lifecycle_status, source_fingerprint, first_seen_at, last_seen_at, synced_at,
      attribution_status, attribution_reasons, attribution_review_state,
      attribution_retryable
    ) VALUES (
      ?, ?, 'transaction-one', '2026-08-08', -10,
      'Invented merchant', 'account-one', '1234', 'kid-one',
      'account-rule', 'pending', 0, 0, '[]',
      'active', 'source-hash', ?, ?, ?,
      'attributed', '[]', 'pending', 0
    )
  `).run(transactionId, connectorId, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_subjects (
      id, connector_id, kid_id, policy_version, engine_version,
      first_seen_at, last_seen_at
    ) VALUES ('subject-one', ?, 'kid-one', 7, '1.0.0', ?, ?)
  `).run(connectorId, now, now);
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, policy_version, occurrence_count,
      created_at, first_observed_at, last_observed_at, updated_at
    ) VALUES (?, ?, ?, 'open', 'low-confidence', 1, 'pending',
      'source-hash', 7, 1, ?, ?, ?, ?)
  `).run(exceptionId, connectorId, transactionId, now, now, now, now);
});

afterAll(() => {
  delete process.env.MC_API_KEY;
  delete process.env.MC_SYNC_EXECUTION_MODE;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance attribution exception APIs', () => {
  it('fails closed for untrusted reads and returns connector-scoped pagination', async () => {
    const { GET } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/route'
    );
    const forbidden = await GET(new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions`,
      { headers: { host: 'mc.example', 'sec-fetch-site': 'cross-site' } },
    ), { params: Promise.resolve({ id: connectorId }) });
    expect(forbidden.status).toBe(403);

    const response = await GET({
      url: `http://next-internal:3099/api/connectors/${connectorId}/finance/attribution-exceptions?limit=1`,
      headers: new Headers({
          host: 'next-internal:3099',
          'x-forwarded-host': 'mc.example',
          'x-forwarded-proto': 'https',
          referer: 'https://mc.example/finance/review',
          'sec-fetch-site': 'same-origin',
      }),
    } as Request, { params: Promise.resolve({ id: connectorId }) });
    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      exceptions: [{
        id: exceptionId,
        reasonCode: 'low-confidence',
        retryable: true,
      }],
      nextCursor: null,
      subjects: [{ kidId: 'kid-one', name: 'Household member' }],
    });
    expect(responseBody.exceptions[0]).not.toHaveProperty('transactionId');

    const invalidCursor = await GET(new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions?cursor=invalid`,
      { headers: trustedHeaders() },
    ), { params: Promise.resolve({ id: connectorId }) });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ code: 'invalid_cursor' });
  });

  it('fails closed when a same-origin request supplies an invalid API credential', async () => {
    const { trustedFinanceMutationActor } = await import(
      '@/lib/connectors/monarch-money/finance-request'
    );
    expect(trustedFinanceMutationActor(new Request('https://mc.example/api/finance/sync', {
      method: 'POST',
      headers: {
        host: 'mc.example',
        origin: 'https://mc.example',
        'sec-fetch-site': 'same-origin',
        'x-mc-api-key': 'not-the-api-key',
      },
    }))).toBeNull();
    const { isTrustedFinanceReadRequest } = await import(
      '@/lib/connectors/monarch-money/finance-request'
    );
    expect(isTrustedFinanceReadRequest(new Request('https://mc.example/api/finance/overview', {
      headers: {
        host: 'mc.example',
        origin: 'https://mc.example',
        'sec-fetch-site': 'same-origin',
        'x-mc-api-key': 'not-the-api-key',
      },
    }))).toBe(false);
  });

  it('rejects unknown kid IDs from outside the Tyrion-derived projection', async () => {
    const { POST } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'
    );
    const response = await POST(new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
      {
        method: 'POST',
        headers: trustedHeaders('manual-unknown-0001'),
        body: JSON.stringify({
          action: 'manual-resolve',
          kidId: 'unknown-kid',
          expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
        }),
      },
    ), { params: Promise.resolve({ id: connectorId, exceptionId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'unknown_attribution_subject',
    });
  });

  it('rejects a projected kid from a stale policy version', async () => {
    const { POST } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'
    );
    sqlite.prepare(`
      UPDATE finance_sync_state SET attribution_policy_version = 8
      WHERE connector_id = ?
    `).run(connectorId);
    try {
      const response = await POST(new Request(
        `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
        {
          method: 'POST',
          headers: trustedHeaders('manual-stale-policy-0001'),
          body: JSON.stringify({
            action: 'manual-resolve',
            kidId: 'kid-one',
            expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
          }),
        },
      ), { params: Promise.resolve({ id: connectorId, exceptionId }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'unknown_attribution_subject',
      });
    } finally {
      sqlite.prepare(`
        UPDATE finance_sync_state SET attribution_policy_version = 7
        WHERE connector_id = ?
      `).run(connectorId);
    }
  });

  it('approves idempotently with derived actor audit and manual precedence', async () => {
    const { POST } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'
    );
    const makeRequest = () => new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
      {
        method: 'POST',
        headers: trustedHeaders('example-1'),
        body: JSON.stringify({
          action: 'approve',
          expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
        }),
      },
    );
    expect((await POST(makeRequest(), {
      params: Promise.resolve({ id: connectorId, exceptionId }),
    })).status).toBe(200);
    sqlite.prepare(`
      UPDATE finance_sync_state SET attribution_policy_version = 8
      WHERE connector_id = ?
    `).run(connectorId);
    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'archived'
      WHERE id = ?
    `).run(transactionId);
    expect((await POST(makeRequest(), {
      params: Promise.resolve({ id: connectorId, exceptionId }),
    })).status).toBe(200);
    sqlite.prepare(`
      UPDATE finance_sync_state SET attribution_policy_version = 7
      WHERE connector_id = ?
    `).run(connectorId);
    sqlite.prepare(`
      UPDATE finance_transactions SET lifecycle_status = 'active'
      WHERE id = ?
    `).run(transactionId);

    expect(sqlite.prepare(`
      SELECT kid_assignment_method AS method,
             manual_decision_action AS action,
             attribution_review_state AS reviewState
      FROM finance_transactions WHERE id = ?
    `).get(transactionId)).toEqual({
      method: 'manual',
      action: 'assign-kid',
      reviewState: 'resolved',
    });
    expect(sqlite.prepare(`
      SELECT count(*) AS count, max(actor_type) AS actorType
      FROM finance_attribution_audit
      WHERE connector_id = ? AND idempotency_key = 'example-1'
    `).get(connectorId    )).toEqual({ count: 1, actorType: 'service' });
  });

  it('supports idempotent dismiss and bounded retry lifecycle actions', async () => {
    const { POST } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'
    );
    sqlite.prepare(`
      UPDATE finance_transactions
      SET manual_decided_at = NULL, manual_decision_action = NULL
      WHERE id = ?
    `).run(transactionId);
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'open', review_state = 'pending', retryable = 1,
          resolution = NULL, resolved_at = NULL,
          updated_at = '2026-08-08T12:10:00.000Z'
      WHERE id = ?
    `).run(exceptionId);
    const dismissed = await POST(new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
      {
        method: 'POST',
        headers: trustedHeaders('dismiss-exception-0001'),
        body: JSON.stringify({
          action: 'dismiss',
          expectedUpdatedAt: '2026-08-08T12:10:00.000Z',
        }),
      },
    ), { params: Promise.resolve({ id: connectorId, exceptionId }) });
    expect(await dismissed.json()).toMatchObject({ status: 'dismissed' });

    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'open', review_state = 'pending', retryable = 1,
          resolution = NULL, resolved_at = NULL,
          updated_at = '2026-08-08T12:20:00.000Z'
      WHERE id = ?
    `).run(exceptionId);
    const retryRequest = () => new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
      {
        method: 'POST',
        headers: trustedHeaders('retry-exception-0001'),
        body: JSON.stringify({
          action: 'retry',
          expectedUpdatedAt: '2026-08-08T12:20:00.000Z',
        }),
      },
    );
    process.env.MC_SYNC_EXECUTION_MODE = 'worker';
    const retried = await POST(retryRequest(), {
      params: Promise.resolve({ id: connectorId, exceptionId }),
    });
    expect(await retried.json()).toMatchObject({ status: 'retry_requested' });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions SET retryable = 0 WHERE id = ?
    `).run(exceptionId);
    const replayed = await POST(retryRequest(), {
      params: Promise.resolve({ id: connectorId, exceptionId }),
    });
    expect(await replayed.json()).toMatchObject({ status: 'retry_requested' });
    delete process.env.MC_SYNC_EXECUTION_MODE;
    expect(sqlite.prepare(`
      SELECT status FROM finance_attribution_exceptions WHERE id = ?
    `).get(exceptionId)).toEqual({ status: 'retry_requested' });
    expect(requestRetryMock).toHaveBeenCalledTimes(2);
    expect(requestRetryMock).toHaveBeenCalledWith(connectorId);
    expect(sqlite.prepare(`
      SELECT count(*) AS count, max(full) AS full
      FROM sync_jobs
      WHERE connector_id = ? AND status = 'queued'
    `).get(connectorId)).toEqual({ count: 1, full: 1 });
  });

  it('preserves a newer manual decision when a stale exception action arrives', async () => {
    const { POST } = await import(
      '@/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route'
    );
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'open', review_state = 'pending', updated_at = ?
      WHERE id = ?
    `).run('2026-08-08T12:00:00.000Z', exceptionId);
    sqlite.prepare(`
      UPDATE finance_transactions
      SET manual_decided_at = ?, assigned_kid_id = 'kid-one'
      WHERE id = ?
    `).run('2026-08-08T12:01:00.000Z', transactionId);

    const response = await POST(new Request(
      `https://mc.example/api/connectors/${connectorId}/finance/attribution-exceptions/${exceptionId}`,
      {
        method: 'POST',
        headers: trustedHeaders('stale-manual-decision-0001'),
        body: JSON.stringify({
          action: 'manual-resolve',
          kidId: null,
          expectedUpdatedAt: '2026-08-08T12:00:00.000Z',
        }),
      },
    ), { params: Promise.resolve({ id: connectorId, exceptionId }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'manual_decision_superseded' });
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId FROM finance_transactions WHERE id = ?
    `).get(transactionId)).toEqual({ kidId: 'kid-one' });
  });
});
