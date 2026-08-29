import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-cutover-'));
process.env.MC_DB_PATH = join(directory, 'cutover.db');
process.env.MC_API_KEY = 'invented-operator-api-key';
process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'true';
delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
delete process.env.TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED;

let sqlite: typeof import('@/db').sqlite;
let cutover: typeof import('@/lib/finance-insights/cutover-operator');

const connectorId = 'finance-cutover-test';
const generation = 'publication-generation-one';
const now = '2026-08-22T12:00:00.000Z';

function key(suffix: string): string {
  return `finance-cutover-${suffix.padEnd(20, 'x')}`;
}

function seedConnector(overrides: { id?: string; enabled?: number; settings?: object } = {}) {
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at, deleted_at
    ) VALUES (?, 'finance-manager', 'Tyrion', ?, 'poll', 240, '{}', '{}', ?, '[]', ?, ?, NULL)
  `).run(
    overrides.id ?? connectorId,
    overrides.enabled ?? 1,
    JSON.stringify(overrides.settings ?? { householdCurrency: 'USD' }),
    now,
    now,
  );
}

function seedCompletedPublication(sourceGeneration = generation, sourceSequence = 1) {
  sqlite.prepare(`
    INSERT INTO finance_insight_publications (
      id, connector_id, source_sequence, generation_identity, contract_version,
      provider_type, source_as_of, coverage_start, coverage_end, currency,
      bridge_contract_version, captured_constituents, manifest, manifest_digest,
      create_request, idempotency_key, alert_capable, captured_at, expires_at
    ) VALUES (?, ?, ?, ?, '1.0', 'finance-manager', ?, '2026-08-01', '2026-08-22',
      'USD', 'bridge-v1', '[]', '[]', 'invented-digest', '{}', ?, 1, ?, ?)
  `).run(
    sourceGeneration,
    connectorId,
    sourceSequence,
    `identity-${sourceSequence}`,
    now,
    `publication-key-${sourceSequence}`,
    now,
    '2026-08-29T12:00:00.000Z',
  );
  sqlite.prepare(`
    INSERT INTO finance_insight_publication_delivery (
      publication_id, connector_id, source_sequence, stage, next_batch_ordinal,
      evaluation_state, last_successful_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'evaluation-requested', 0, 'completed', ?, ?, ?)
  `).run(sourceGeneration, connectorId, sourceSequence, now, now, now);
  sqlite.prepare(`
    INSERT INTO finance_insight_occurrence_cache_state (
      connector_id, source_generation, source_sequence, item_count, source_as_of,
      refreshed_at, summary_expires_at, purge_after, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    connectorId,
    sourceGeneration,
    sourceSequence,
    now,
    now,
    '2026-08-23T12:00:00.000Z',
    '2026-08-29T12:00:00.000Z',
    now,
    now,
  );
}

beforeAll(async () => {
  ({ sqlite } = await import('@/db'));
  cutover = await import('@/lib/finance-insights/cutover-operator');
});

beforeEach(() => {
  delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
  delete process.env.TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED;
  sqlite.exec(`
    DELETE FROM finance_insight_cutover_audit;
    DELETE FROM notification_delivery_events;
    DELETE FROM notification_actions;
    DELETE FROM notifications;
    DELETE FROM finance_insight_cutovers;
    DELETE FROM finance_insight_occurrences;
    DELETE FROM finance_insight_occurrence_cache_state;
    DELETE FROM finance_insight_publication_delivery;
    DELETE FROM finance_insight_publication_facts;
    DELETE FROM finance_insight_publications;
    DELETE FROM connector_configs;
  `);
  seedConnector();
  seedCompletedPublication();
});

afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
  delete process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED;
});

describe.sequential('Finance Insight cutover operator', () => {
  it('reports local metadata readiness without contacting Monarch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(cutover.getFinanceInsightCutoverReadiness(connectorId, generation))
      .toMatchObject({
        connector: {
          id: connectorId,
          enabled: true,
          configurationState: { status: 'configured' },
        },
        publication: {
          sourceGeneration: generation,
          sourceSequence: 1,
        },
        gates: {
          shadowIngestEnabled: true,
          immediateNotificationsEnabled: false,
          monthlyDigestEnabled: false,
          deliveryEnabled: false,
        },
        readiness: { ready: true, blockers: [] },
      });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fails closed on disabled, unconfigured, ambiguous, gated, and stale states', () => {
    sqlite.prepare(`UPDATE connector_configs SET enabled = 0, settings = '{}' WHERE id = ?`)
      .run(connectorId);
    process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED = 'true';
    expect(cutover.getFinanceInsightCutoverReadiness(connectorId, 'stale-generation').readiness)
      .toEqual({
        ready: false,
        blockers: [
          'finance_insight_connector_unavailable',
          'finance_connector_disabled',
          'household_currency_unavailable',
          'finance_notification_gate_enabled',
          'finance_insight_cutover_generation_stale',
        ],
      });

    sqlite.prepare(`UPDATE connector_configs SET enabled = 1 WHERE id = ?`).run(connectorId);
    seedConnector({ id: 'finance-second' });
    expect(cutover.getFinanceInsightCutoverReadiness(connectorId, generation).readiness.blockers)
      .toContain('finance_insight_connector_unavailable');
  });

  it('enables one exact generation idempotently and rejects key conflicts', () => {
    const first = cutover.enableFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: generation,
      actorType: 'service',
      idempotencyKey: key('enable'),
      now: new Date(now),
    });
    const replay = cutover.enableFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: generation,
      actorType: 'service',
      idempotencyKey: key('enable'),
      now: new Date(now),
    });

    expect(first).toMatchObject({
      status: 'enabled',
      legacyExpiredCount: 0,
      importedCount: 0,
      replayed: false,
    });
    expect(replay).toMatchObject({ status: 'enabled', replayed: true });
    expect(() => cutover.rollbackFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: generation,
      actorType: 'service',
      idempotencyKey: key('enable'),
    })).toThrowError(expect.objectContaining({ code: 'cutover_idempotency_conflict' }));
    expect(sqlite.prepare(`
      SELECT operation, actor_type AS actorType, result_code AS resultCode,
             blocker_codes AS blockerCodes
      FROM finance_insight_cutover_audit
    `).all()).toEqual([{
      operation: 'enable',
      actorType: 'service',
      resultCode: 'finance_insight_cutover_enabled',
      blockerCodes: '[]',
    }]);
  });

  it('rolls back only the explicit active generation and suppresses in-flight delivery', () => {
    cutover.enableFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: generation,
      actorType: 'parent-admin',
      idempotencyKey: key('enable-rollback'),
      now: new Date(now),
    });
    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, level, category,
        template_key, state, read_state, disposition, source_state, sync_state,
        is_actionable, received_at, sort_at, metadata, presentation
      ) VALUES (
        'cutover-notification', ?, 'finance-manager', ?, 'Invented insight',
        'heads_up', 'finance', 'finance-insight', 'unread', 'unread', 'inbox',
        'active', 'synced', 1, ?, ?, '{}', '{}'
      )
    `).run(`finance-insight:${connectorId}:occurrence-one`, connectorId, now, now);
    sqlite.prepare(`
      INSERT INTO notification_delivery_events (
        id, notification_id, channel, dedupe_key, status, policy_snapshot,
        payload_snapshot, attempt_count, created_at
      ) VALUES (
        'cutover-delivery', 'cutover-notification', 'web_push', 'cutover-delivery',
        'pending', '{}', '{}', 0, ?
      )
    `).run(now);

    expect(() => cutover.rollbackFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: 'different-generation',
      actorType: 'service',
      idempotencyKey: key('rollback-stale'),
    })).toThrowError(expect.objectContaining({
      code: 'finance_insight_cutover_generation_stale',
    }));
    expect(cutover.rollbackFinanceInsightCutoverForOperator({
      connectorId,
      sourceGeneration: generation,
      actorType: 'service',
      idempotencyKey: key('rollback'),
      now: new Date(now),
    })).toMatchObject({
      status: 'rolled-back',
      suppressedDeliveryCount: 1,
      replayed: false,
    });
    expect(sqlite.prepare(`
      SELECT status, suppression_reason AS reason
      FROM notification_delivery_events WHERE id = 'cutover-delivery'
    `).get()).toEqual({
      status: 'suppressed',
      reason: 'finance_insight_cutover_rolled_back',
    });
  });

  it('enforces the trusted operator boundary and stable route errors', async () => {
    const { GET, POST } = await import('@/app/api/connectors/[id]/finance-operations/route');
    const context = { params: Promise.resolve({ id: connectorId }) };
    const untrusted = await GET(
      new NextRequest(`https://mc.example/api/connectors/${connectorId}/finance-operations`),
      context,
    );
    expect(untrusted.status).toBe(403);

    const contentBearing = await POST(new NextRequest(
      `https://mc.example/api/connectors/${connectorId}/finance-operations`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer invented-operator-api-key',
          'content-type': 'application/json',
          'idempotency-key': key('route-content'),
        },
        body: JSON.stringify({
          action: 'enable-insight-cutover',
          sourceGeneration: generation,
          accountBalance: 12_345,
        }),
      },
    ), context);
    expect(contentBearing.status).toBe(400);
    await expect(contentBearing.json()).resolves.toEqual({
      error: 'invalid_finance_operator_request',
    });

    const trusted = await POST(new NextRequest(
      `https://mc.example/api/connectors/${connectorId}/finance-operations`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer invented-operator-api-key',
          'content-type': 'application/json',
          'idempotency-key': key('route-enable'),
        },
        body: JSON.stringify({
          action: 'enable-insight-cutover',
          sourceGeneration: generation,
        }),
      },
    ), context);
    expect(trusted.status).toBe(200);
    await expect(trusted.json()).resolves.toMatchObject({ status: 'enabled' });
  });
});
