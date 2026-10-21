import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteFinanceWorkerPersistence } from '@/db/persistence/sqlite-finance-worker-repositories';
import type { FinanceCorePersistence } from '@/db/persistence/finance-worker';
import { reconcileAttributionWritebacks } from '@/lib/connectors/monarch-money/attribution-writeback';
import { TyrionAttributionClient } from '@/lib/connectors/monarch-money/attribution-client';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import {
  tyrionActionFixture, tyrionWritebackFixture, writebackJson, writebackObservedAt,
} from '../helpers/tyrion-writeback-fixture';

const directory = mkdtempSync(join(tmpdir(), 'mc-writeback-'));
const connectorId = 'synthetic-writeback';
const transactionId = 'finance:synthetic-writeback:upstream-one';
const financeConfig = {
  credentials: { serviceToken: 'synthetic-token', identityNamespace: 'a'.repeat(64) },
  settings: { tyrionAttributionPolicy: { pinnedPolicyVersion: 1 } },
};
let sqlite: Database.Database;
let persistence: FinanceCorePersistence;

beforeAll(async () => {
  process.env.MC_DB_PATH = join(directory, 'writeback.db');
  sqlite = (await importInitializedSqliteDatabase()).sqlite;
  persistence = createSqliteFinanceWorkerPersistence(sqlite);
  sqlite.prepare(`
    INSERT INTO connector_configs (id, type, name, enabled, sync_mode, capabilities,
      credentials, settings, synced_lists, created_at, updated_at)
    VALUES (?, 'finance-manager', 'Synthetic', 1, 'poll', '{}', ?, '{}', '[]', ?, ?)
  `).run(connectorId, JSON.stringify(financeConfig.credentials), writebackObservedAt, writebackObservedAt);
  sqlite.prepare(`
    INSERT INTO finance_sync_state (connector_id, status, attribution_policy_version, created_at, updated_at)
    VALUES (?, 'succeeded', 1, ?, ?)
  `).run(connectorId, writebackObservedAt, writebackObservedAt);
  sqlite.prepare(`
    INSERT INTO finance_attribution_subjects (id, connector_id, kid_id, policy_version,
      engine_version, first_seen_at, last_seen_at)
    VALUES ('subject-one', ?, 'kid-one', 1, '2.1.0', ?, ?)
  `).run(connectorId, writebackObservedAt, writebackObservedAt);
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MC_API_KEY;
});

beforeEach(() => {
  sqlite.exec('DELETE FROM finance_attribution_audit; DELETE FROM finance_attribution_exceptions; DELETE FROM finance_transactions;');
  sqlite.prepare(`
    INSERT INTO finance_transactions (id, connector_instance_id, upstream_transaction_id, date,
      amount, merchant_name, account_id, source_fingerprint, first_seen_at, last_seen_at, synced_at)
    VALUES (?, ?, 'upstream-one', '2026-10-20', -12, 'Invented merchant', 'account-one',
      'source-hash', ?, ?, ?)
  `).run(transactionId, connectorId, writebackObservedAt, writebackObservedAt, writebackObservedAt);
});

afterAll(() => {
  sqlite?.close();
  delete process.env.MC_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

async function decide(action: 'assign-kid' | 'parent-expense' = 'assign-kid', key = 'manual-key-one') {
  return persistence.attribution.applyManualDecision({
    connectorId, transactionId, action, kidId: action === 'assign-kid' ? 'kid-one' : null,
    idempotencyKey: key, auditAction: 'manual-resolve', actorType: 'parent-admin',
    exceptionId: null, expectedExceptionUpdatedAt: null, expectedTransactionVersion: null,
    now: writebackObservedAt,
  });
}

function client(fetcher: typeof fetch) {
  return new TyrionAttributionClient({
    serviceToken: 'synthetic-token', expectedPolicyVersion: 1, timeoutMs: 500,
  }, fetcher);
}

function receipt() {
  return sqlite.prepare(`
    SELECT writeback_status AS status, writeback_request AS request, writeback_error_code AS errorCode
    FROM finance_attribution_audit WHERE idempotency_key = 'manual-key-one'
  `).get() as { status: string; request: string | null; errorCode: string | null };
}

describe.sequential('durable attribution write-back', () => {
  it('captures exact CAS before dispatch and replays unchanged after remote commit/local timeout', async () => {
    await decide();
    const [audit] = await persistence.attribution.readWritebacks(connectorId);
    const actions: string[] = [];
    let fail = true;
    const remote = client(vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) {
        expect(body.transactionId).toBe('upstream-one');
        expect(body.item.sourceRef).not.toContain('upstream-one');
        return writebackJson(tyrionWritebackFixture(body.item.sourceRef));
      }
      expect(receipt().request).toBe(String(init?.body));
      actions.push(String(init?.body));
      if (fail) throw new TypeError('Synthetic timeout after remote commit');
      return writebackJson(tyrionActionFixture(body.sourceRef));
    }));
    await expect(reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: remote,
    })).rejects.toMatchObject({ status: 502 });
    expect(receipt()).toMatchObject({ status: 'failed', errorCode: 'attribution_service_unavailable' });
    expect(sqlite.prepare('SELECT reason_code AS reason FROM finance_attribution_exceptions').get())
      .toEqual({ reason: 'writeback-failed' });
    await expect(decide('parent-expense', 'newer-manual-key')).rejects.toMatchObject({
      code: 'attribution_writeback_pending',
    });
    fail = false;
    await reconcileAttributionWritebacks(connectorId, { persistence, financeConfig, client: remote });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toBe(actions[1]);
    expect(receipt().status).toBe('succeeded');
    expect(sqlite.prepare('SELECT status FROM finance_attribution_exceptions').get())
      .toEqual({ status: 'resolved' });
    await persistence.attribution.finishWriteback({
      id: audit.id,
      status: 'failed', errorCode: 'late-failure', now: writebackObservedAt,
    });
    expect(receipt().status).toBe('succeeded');
  });

  it('keeps partial projection failure visible and retries only the current decision', async () => {
    await decide('parent-expense');
    let projected = false;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) return writebackJson(tyrionWritebackFixture(body.item.sourceRef));
      if (String(url).endsWith('/actions')) {
        expect(body.action).toBe('mark-parent-expense');
        expect(body).not.toHaveProperty('kidId');
        return writebackJson(tyrionActionFixture(body.sourceRef, 2, 'failed', null));
      }
      expect(body).toMatchObject({ action: 'retry', expectedStateVersion: 2 });
      return writebackJson(tyrionWritebackFixture(body.sourceRef, 2, projected ? 'projected' : 'failed', null));
    });
    const remote = client(fetcher);
    await expect(reconcileAttributionWritebacks(connectorId, { persistence, financeConfig, client: remote }))
      .rejects.toMatchObject({ code: 'tag_projection_unavailable' });
    expect(receipt().status).toBe('failed');
    projected = true;
    await reconcileAttributionWritebacks(connectorId, { persistence, financeConfig, client: remote });
    expect(receipt().status).toBe('succeeded');
  });

  it('does not retry tag drift or report a saved decision as projected', async () => {
    await decide();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return String(url).endsWith('/records')
        ? writebackJson(tyrionWritebackFixture(body.item.sourceRef))
        : writebackJson(tyrionActionFixture(body.sourceRef, 2, 'drift'));
    });
    await expect(reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: client(fetcher),
    })).rejects.toMatchObject({ code: 'transaction_tag_drift', status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(receipt().status).toBe('failed');
  });

  it('rejects an acknowledged projection for a different manual assignment', async () => {
    await decide();
    const remote = client(vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      return String(url).endsWith('/records')
        ? writebackJson(tyrionWritebackFixture(body.item.sourceRef))
        : writebackJson(tyrionActionFixture(body.sourceRef, 2, 'projected', 'kid-other'));
    }));
    await expect(reconcileAttributionWritebacks(connectorId, { persistence, financeConfig, client: remote }))
      .rejects.toMatchObject({ code: 'invalid_attribution_correlation' });
    expect(receipt().status).toBe('failed');
  });

  it('places Houston assignments in the same outbox and prevents a newer approval until reconciliation', async () => {
    const command = {
      connectorId, transactionId, kidId: 'kid-one',
      idempotencyKey: 'manual-key-one', actorType: 'parent-admin' as const,
      decidedAt: writebackObservedAt,
      expectedVersion: {
        sourceFingerprint: 'source-hash', lastSeenAt: writebackObservedAt,
        assignedKidId: null, confirmedCategory: null, manualDecidedAt: null,
      },
    };
    await expect(persistence.assistant.applyManualKidAssignment(command)).resolves.toEqual({ status: 'applied' });
    expect(receipt().status).toBe('pending');
    await expect(persistence.assistant.applyManualKidAssignment(command)).resolves.toEqual({ status: 'replayed' });
    await expect(persistence.assistant.applyManualKidAssignment({
      ...command, idempotencyKey: 'newer-houston-key',
      expectedVersion: {
        ...command.expectedVersion, assignedKidId: 'kid-one', manualDecidedAt: writebackObservedAt,
      },
    })).resolves.toEqual({ status: 'transaction-conflict' });
    await expect(persistence.assistant.findReplayedKidAssignments(command.idempotencyKey))
      .resolves.toEqual([{ connectorId, kidName: null }]);
  });

  it('rebases only after an explicit non-committing state conflict', async () => {
    await decide();
    let records = 0;
    const versions: number[] = [];
    const remote = client(vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) {
        records += 1;
        return writebackJson(tyrionWritebackFixture(body.item.sourceRef, records === 1 ? 1 : 3));
      }
      versions.push(body.expectedStateVersion);
      return versions.length === 1
        ? writebackJson({ error: { code: 'attribution_state_conflict', message: 'State changed' } }, 409)
        : writebackJson(tyrionActionFixture(body.sourceRef, 4));
    }));
    await reconcileAttributionWritebacks(connectorId, { persistence, financeConfig, client: remote });
    expect(versions).toEqual([1, 3]);
    expect(receipt().status).toBe('succeeded');
  });

  it.each(['kid-one', 'kid-other'])('verifies a replay against the current record without overwriting %s', async (currentKidId) => {
    await decide();
    let reads = 0;
    let actions = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) {
        reads += 1;
        expect(body.expectedStateVersion).toBeNull();
        return writebackJson(tyrionWritebackFixture(body.item.sourceRef,
          reads === 1 ? 1 : 3, 'projected', reads === 1 ? 'kid-one' : currentKidId));
      }
      actions += 1;
      expect(String(url)).toMatch(/\/actions$/);
      const response = tyrionActionFixture(body.sourceRef, 2);
      response.projection = tyrionWritebackFixture(body.sourceRef, 3, 'projected', currentKidId).projection;
      return writebackJson(response);
    });
    const operation = reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: client(fetcher),
    });
    if (currentKidId === 'kid-one') {
      await operation;
      expect(receipt().status).toBe('succeeded');
    } else {
      await expect(operation).rejects.toMatchObject({ code: 'manual_decision_conflict', status: 409 });
      expect(receipt().status).toBe('failed');
    }
    expect(reads).toBe(2);
    expect(actions).toBe(1);
  });

  it('does not confuse a newer manual unassign with the original parent/shared choice', async () => {
    await decide('parent-expense');
    let reads = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) {
        reads += 1;
        const current = tyrionWritebackFixture(body.item.sourceRef, reads === 1 ? 1 : 3, 'projected', null);
        if (reads > 1 && current.record.input.existingManualDecision) {
          current.record.input.existingManualDecision.action = 'unassign';
        }
        return writebackJson(current);
      }
      expect(String(url)).toMatch(/\/actions$/);
      const original = tyrionActionFixture(body.sourceRef, 2, 'projected', null);
      original.projection = tyrionWritebackFixture(body.sourceRef, 3, 'projected', null).projection;
      return writebackJson(original);
    });
    await expect(reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: client(fetcher),
    })).rejects.toMatchObject({ code: 'manual_decision_conflict', status: 409 });
    expect(receipt().status).toBe('failed');
    expect(reads).toBe(2);
  });

  it('preserves a timed-out policy request until a confirmed policy rejection permits recovery', async () => {
    await decide();
    const policies: number[] = [];
    const initial = client(vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) return writebackJson(tyrionWritebackFixture(body.item.sourceRef));
      policies.push(body.expectedPolicyVersion);
      throw new TypeError('Synthetic ambiguous outcome');
    }));
    await expect(reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: initial,
    })).rejects.toMatchObject({ status: 502 });
    const original = receipt().request;
    const changed = new TyrionAttributionClient({
      serviceToken: 'synthetic-token', expectedPolicyVersion: 2, timeoutMs: 500,
    }, vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) {
        const record = tyrionWritebackFixture(body.item.sourceRef, 3);
        record.record.attribution.provenance.policyVersion = 2;
        return writebackJson(record);
      }
      policies.push(body.expectedPolicyVersion);
      if (body.expectedPolicyVersion === 1) {
        expect(String(init?.body)).toBe(original);
        return writebackJson({ error: { code: 'policy_conflict', message: 'Policy changed' } }, 409);
      }
      const result = tyrionActionFixture(body.sourceRef, 4);
      result.policyVersion = 2;
      result.attribution.provenance.policyVersion = 2;
      return writebackJson(result);
    }));
    await reconcileAttributionWritebacks(connectorId, {
      persistence,
      financeConfig: { ...financeConfig, settings: { tyrionAttributionPolicy: { pinnedPolicyVersion: 2 } } },
      client: changed,
    });
    expect(policies).toEqual([1, 1, 2]);
    expect(receipt().status).toBe('succeeded');
  });

  it('marks old upgraded audits superseded without sending a financial mutation', async () => {
    await decide();
    sqlite.prepare("UPDATE finance_transactions SET manual_decided_at = '2026-10-20T13:00:00.000Z'").run();
    const fetcher = vi.fn<typeof fetch>();
    await reconcileAttributionWritebacks(connectorId, {
      persistence, financeConfig, client: client(fetcher),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(receipt().status).toBe('superseded');
  });

  it('returns a visible API failure after saving locally and recovers with the same key', async () => {
    process.env.MC_API_KEY = 'synthetic-api-key';
    let projected = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/policy')) {
        return writebackJson({
          contractVersion: '2.1', engineVersion: '2.1.0', policyVersion: 1,
          policyUpdatedAt: writebackObservedAt, householdCurrency: 'USD', subjects: [],
        });
      }
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/records')) return writebackJson(tyrionWritebackFixture(body.item.sourceRef));
      if (String(url).endsWith('/actions')) {
        return writebackJson(tyrionActionFixture(body.sourceRef, 2, projected ? 'projected' : 'failed'));
      }
      return writebackJson(tyrionWritebackFixture(body.sourceRef, 2, projected ? 'projected' : 'failed'));
    }));
    const { PATCH } = await import('@/app/api/finance/transactions/[id]/kid/route');
    const request = () => new Request(`https://mc.example/api/finance/transactions/${transactionId}/kid`, {
      method: 'PATCH',
      headers: {
        host: 'mc.example', origin: 'https://mc.example', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'x-mc-api-key': 'synthetic-api-key',
        'idempotency-key': 'manual-key-one',
      },
      body: JSON.stringify({ action: 'assign-kid', kidId: 'kid-one', connectorId }),
    });
    const failed = await PATCH(request(), { params: Promise.resolve({ id: transactionId }) });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'tag_projection_unavailable' });
    expect(receipt().status).toBe('failed');
    projected = true;
    const recovered = await PATCH(request(), { params: Promise.resolve({ id: transactionId }) });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'resolved', replayed: true });
    expect(receipt().status).toBe('succeeded');
  });
});
