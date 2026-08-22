import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.unmock('drizzle-orm');

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-repair-'));
const databasePath = join(tempDirectory, 'repair.db');
const connectorId = 'tyrion-disabled';
const otherConnectorId = 'finance-other';
const now = '2026-08-22T17:00:00.000Z';
const incidentAt = '2026-08-12T17:00:00.000Z';

let sqlite: Database.Database;
let POST: typeof import(
  '@/app/api/connectors/[id]/finance/attention-repair/route'
)['POST'];
let financeAttentionSourceId:
  typeof import('@/lib/finance/attention-routing')['financeAttentionSourceId'];
let financeAttentionTaskId:
  typeof import('@/lib/finance/attention-routing')['financeAttentionTaskId'];

function headers(idempotencyKey: string): HeadersInit {
  return {
    host: 'mc.example',
    origin: 'https://mc.example',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-mc-api-key': 'repair-test-key',
    'idempotency-key': idempotencyKey,
  };
}

function request(
  body: Record<string, unknown>,
  idempotencyKey: string,
  trusted = true,
): Request {
  return new Request(
    `https://mc.example/api/connectors/${connectorId}/finance/attention-repair`,
    {
      method: 'POST',
      headers: trusted
        ? headers(idempotencyKey)
        : {
            host: 'mc.example',
            origin: 'https://attacker.example',
            'sec-fetch-site': 'cross-site',
            'content-type': 'application/json',
          },
      body: JSON.stringify(body),
    },
  );
}

function seedConnector(id: string, enabled: number): void {
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', 'Tyrion test', ?, 'poll', '{}', '{}', '{}', '[]', ?, ?)
  `).run(id, enabled, now, now);
}

function seedProjection(input: {
  exceptionId: string;
  connector?: string;
  reasonCode?: string;
  templateKey?: string;
  withNotification?: boolean;
  withTask?: boolean;
}): void {
  const scopedConnector = input.connector ?? connectorId;
  const reasonCode = input.reasonCode ?? 'attribution_not_configured';
  const signal = {
    connectorId: scopedConnector,
    signalKind: 'attributionReviewRequired' as const,
    sourceRef: input.exceptionId,
  };
  const sourceId = financeAttentionSourceId(signal);
  const taskId = financeAttentionTaskId(signal);
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, occurrence_count, created_at,
      first_observed_at, last_observed_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, 0, 'pending', ?, 1, ?, ?, ?, ?)
  `).run(
    input.exceptionId,
    scopedConnector,
    `transaction-${input.exceptionId}`,
    reasonCode,
    `fingerprint-${input.exceptionId}`,
    incidentAt,
    incidentAt,
    incidentAt,
    incidentAt,
  );
  if (input.withNotification !== false) {
    const notificationId = `notification-${input.exceptionId}`;
    const actionId = `action-${input.exceptionId}`;
    sqlite.prepare(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, body,
        level, level_rank, category, template_key, state, read_state,
        disposition, source_state, sync_state, is_actionable, primary_action_id,
        received_at, sort_at, related_entity_type, related_entity_id,
        metadata, presentation
      ) VALUES (
        ?, ?, 'finance-manager', ?, 'Review finance attribution',
        'Content must never be returned', 'heads_up', 3, 'finance', ?,
        'unread', 'unread', 'inbox', 'active', 'synced', 1, ?, ?, ?,
        'finance-attribution-exception', ?, ?, '{}'
      )
    `).run(
      notificationId,
      sourceId,
      scopedConnector,
      input.templateKey ?? 'finance-attribution-review',
      actionId,
      incidentAt,
      incidentAt,
      input.exceptionId,
      JSON.stringify({
        notificationType: 'financeAttributionReview',
        financeAttention: {
          connectorRef: scopedConnector,
          sourceRef: input.exceptionId,
          signalKind: 'attributionReviewRequired',
          route: 'actionableNotification',
        },
      }),
    );
    sqlite.prepare(`
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, created_by, execution_state
      ) VALUES (?, ?, 'navigate', 'Review', 'connector', 'pending')
    `).run(actionId, notificationId);
    sqlite.prepare(`
      INSERT INTO notification_delivery_events (
        id, notification_id, channel, dedupe_key, status, policy_snapshot,
        payload_snapshot, created_at
      ) VALUES (?, ?, 'web_push', ?, 'pending', '{}', '{}', ?)
    `).run(
      `delivery-${input.exceptionId}`,
      notificationId,
      `web_push:${notificationId}:initial`,
      incidentAt,
    );
  }
  if (input.withTask) {
    sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        local_disposition, priority, created_at, updated_at, metadata,
        sync_status, last_synced_at
      ) VALUES (
        ?, ?, 'mission-control', 'mission-control',
        'Review a finance attribution exception', 'todo', 'active', 'medium',
        ?, ?, ?, 'synced', ?
      )
    `).run(
      taskId,
      sourceId,
      incidentAt,
      incidentAt,
      JSON.stringify({
        financeAttention: {
          connectorRef: scopedConnector,
          sourceRef: input.exceptionId,
          signalKind: 'attributionReviewRequired',
          route: 'task',
        },
      }),
      incidentAt,
    );
    sqlite.prepare(`
      INSERT INTO my_day_items (
        id, task_id, date, added_at, is_auto_included, "order"
      ) VALUES (?, ?, '2026-08-22', ?, 1, 1)
    `).run(`my-day-${input.exceptionId}`, taskId, now);
  }
}

async function post(
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await POST(request(body, idempotencyKey), {
    params: Promise.resolve({ id: connectorId }),
  });
  return { response, body: await response.json() };
}

function count(table: string, where = ''): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as {
    count: number;
  }).count;
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  process.env.MC_API_KEY = 'repair-test-key';
  vi.resetModules();
  ({ sqlite } = await import('@/db'));
  ({ financeAttentionSourceId, financeAttentionTaskId } = await import(
    '@/lib/finance/attention-routing'
  ));
  ({ POST } = await import(
    '@/app/api/connectors/[id]/finance/attention-repair/route'
  ));
}, 30_000);

beforeEach(() => {
  for (const table of [
    'finance_attention_repair_audit',
    'my_day_items',
    'notification_delivery_events',
    'notification_actions',
    'notifications',
    'tasks',
    'finance_attribution_exceptions',
    'connector_configs',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  seedConnector(connectorId, 0);
  seedConnector(otherConnectorId, 1);
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance attention projection repair API', () => {
  it('dry-runs exact connector-scoped targets without returning financial content', async () => {
    seedProjection({ exceptionId: 'affected', withTask: true });
    seedProjection({
      exceptionId: 'legitimate-ambiguity',
      reasonCode: 'low-confidence',
      withTask: true,
    });
    seedProjection({
      exceptionId: 'wrong-template',
      templateKey: 'finance-large-transaction',
    });
    seedProjection({
      exceptionId: 'other-connector',
      connector: otherConnectorId,
      withTask: true,
    });
    seedProjection({ exceptionId: 'after-cutover' });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET first_observed_at = ?, last_observed_at = ?, updated_at = ?
      WHERE id = 'after-cutover'
    `).run(now, now, now);
    sqlite.prepare(`
      UPDATE notifications SET received_at = ?, sort_at = ?
      WHERE related_entity_id = 'after-cutover'
    `).run(now, now);

    const { response, body } = await post({ mode: 'dry-run' }, 'repair-dry-0001');

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: 'dry-run',
      connectorId,
      connectorEnabled: false,
      reasonCode: 'attribution_not_configured',
      applied: false,
      replayed: false,
      counts: {
        occurrences: 1,
        notifications: 1,
        connectorActions: 1,
        pendingDeliveries: 1,
        tasks: 1,
        myDayItems: 1,
      },
    });
    expect(JSON.stringify(body)).not.toContain('Content must never be returned');
    expect(count('notifications', `WHERE source_state = 'active'`)).toBe(5);
    expect(count('finance_attention_repair_audit')).toBe(1);
  });

  it('fully previews the 4,632-occurrence incident inside the bounded scope', async () => {
    sqlite.transaction(() => {
      for (let index = 0; index < 4_632; index++) {
        seedProjection({
          exceptionId: `incident-${String(index).padStart(4, '0')}`,
        });
      }
    })();

    const { response, body } = await post(
      { mode: 'dry-run' },
      'repair-full-incident-dry-0001',
    );

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      counts: {
        occurrences: 4_632,
        notifications: 4_632,
        connectorActions: 4_632,
        pendingDeliveries: 4_632,
        tasks: 0,
        myDayItems: 0,
      },
    });
    expect(count('notifications', `WHERE source_state = 'active'`)).toBe(4_632);
  }, 30_000);

  it('applies atomically on a disabled connector, preserves exceptions, and replays', async () => {
    seedProjection({ exceptionId: 'affected-apply', withTask: true });
    const dryRun = await post({ mode: 'dry-run' }, 'repair-dry-apply-0001');
    const dryRunId = dryRun.body.runId as string;
    const applyBody = {
      mode: 'apply',
      dryRunId,
      confirmation: 'repair-attribution-not-configured-projections',
    };

    const applied = await post(applyBody, 'repair-apply-0001');
    const replay = await post(applyBody, 'repair-apply-0001');

    expect(applied.response.status).toBe(200);
    expect(applied.body).toMatchObject({
      mode: 'apply',
      connectorEnabled: false,
      dryRunId,
      applied: true,
      replayed: false,
    });
    expect(replay.body).toMatchObject({
      runId: applied.body.runId,
      replayed: true,
      counts: applied.body.counts,
    });
    expect(sqlite.prepare(`
      SELECT state, source_state AS sourceState, is_actionable AS isActionable,
             primary_action_id AS primaryActionId,
             auto_resolve_reason AS autoResolveReason
      FROM notifications
    `).get()).toEqual({
      state: 'archived',
      sourceState: 'resolved',
      isActionable: 0,
      primaryActionId: null,
      autoResolveReason: 'status_only',
    });
    expect(count('notification_actions')).toBe(0);
    expect(sqlite.prepare(`
      SELECT status, suppression_reason AS suppressionReason
      FROM notification_delivery_events
    `).get()).toEqual({
      status: 'suppressed',
      suppressionReason: 'finance_attention_projection_repair',
    });
    expect(sqlite.prepare(`
      SELECT status, status_reason AS statusReason FROM tasks
    `).get()).toEqual({ status: 'cancelled', statusReason: 'not_planned' });
    expect(count('my_day_items')).toBe(0);
    expect(sqlite.prepare(`
      SELECT status, review_state AS reviewState, reason_code AS reasonCode
      FROM finance_attribution_exceptions
    `).get()).toEqual({
      status: 'open',
      reviewState: 'pending',
      reasonCode: 'attribution_not_configured',
    });
    expect(count('finance_attention_repair_audit')).toBe(2);

    sqlite.prepare(`
      UPDATE tasks SET local_disposition = 'dismissed'
    `).run();
    const cleanReplay = await post({ mode: 'dry-run' }, 'repair-clean-dry-0001');
    expect(cleanReplay.body).toMatchObject({
      counts: {
        occurrences: 0,
        notifications: 0,
        connectorActions: 0,
        pendingDeliveries: 0,
        tasks: 0,
        myDayItems: 0,
      },
    });
  });

  it('preserves local notification dismissal without suppressing the source exception', async () => {
    seedProjection({ exceptionId: 'affected-dismissed' });
    sqlite.prepare(`
      UPDATE notifications
      SET state = 'dismissed', disposition = 'dismissed', dismissed_at = ?
    `).run(incidentAt);
    const dryRun = await post({ mode: 'dry-run' }, 'repair-dismissed-dry-0001');

    const applied = await post({
      mode: 'apply',
      dryRunId: dryRun.body.runId,
      confirmation: 'repair-attribution-not-configured-projections',
    }, 'repair-dismissed-apply-0001');

    expect(applied.response.status).toBe(200);
    expect(sqlite.prepare(`
      SELECT state, disposition, source_state AS sourceState
      FROM notifications
    `).get()).toEqual({
      state: 'dismissed',
      disposition: 'dismissed',
      sourceState: 'resolved',
    });
    expect(sqlite.prepare(`
      SELECT status, review_state AS reviewState
      FROM finance_attribution_exceptions
    `).get()).toEqual({ status: 'open', reviewState: 'pending' });
  });

  it('fails closed while a targeted push delivery is in flight', async () => {
    seedProjection({ exceptionId: 'affected-in-flight' });
    const dryRun = await post({ mode: 'dry-run' }, 'repair-in-flight-dry-0001');
    sqlite.prepare(`
      UPDATE notification_delivery_events
      SET status = 'sending', lease_expires_at = ?
    `).run('2026-08-22T17:05:00.000Z');

    const failed = await post({
      mode: 'apply',
      dryRunId: dryRun.body.runId,
      confirmation: 'repair-attribution-not-configured-projections',
    }, 'repair-in-flight-apply-0001');

    expect(failed.response.status).toBe(409);
    expect(failed.body).toMatchObject({ code: 'repair_delivery_in_flight' });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable
      FROM notifications
    `).get()).toEqual({ sourceState: 'active', isActionable: 1 });
    expect(sqlite.prepare(`
      SELECT status, lease_expires_at AS leaseExpiresAt
      FROM notification_delivery_events
    `).get()).toEqual({
      status: 'sending',
      leaseExpiresAt: '2026-08-22T17:05:00.000Z',
    });
    expect(count(
      'finance_attention_repair_audit',
      `WHERE mode = 'apply'`,
    )).toBe(0);
  });

  it('requires trusted finance mutation authorization and an exact dry-run', async () => {
    seedProjection({ exceptionId: 'affected-auth' });
    const forbidden = await POST(request({ mode: 'dry-run' }, 'repair-auth-0001', false), {
      params: Promise.resolve({ id: connectorId }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'forbidden' });

    const missingDryRun = await post({
      mode: 'apply',
      dryRunId: '00000000-0000-4000-8000-000000000000',
      confirmation: 'repair-attribution-not-configured-projections',
    }, 'repair-no-dry-0001');
    expect(missingDryRun.response.status).toBe(409);
    expect(missingDryRun.body).toMatchObject({ code: 'repair_dry_run_not_found' });

    const dryRun = await post({ mode: 'dry-run' }, 'repair-scope-dry-0001');
    seedProjection({ exceptionId: 'scope-changed' });
    const changed = await post({
      mode: 'apply',
      dryRunId: dryRun.body.runId,
      confirmation: 'repair-attribution-not-configured-projections',
    }, 'repair-scope-apply-0001');
    expect(changed.response.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'repair_scope_changed' });
  });

  it('rolls back projections and apply audit when any repair write fails', async () => {
    seedProjection({ exceptionId: 'affected-rollback', withTask: true });
    const dryRun = await post({ mode: 'dry-run' }, 'repair-rollback-dry-0001');
    sqlite.exec(`
      CREATE TRIGGER abort_finance_attention_repair_test
      BEFORE UPDATE ON notifications
      WHEN NEW.auto_resolve_reason = 'status_only'
      BEGIN
        SELECT RAISE(ABORT, 'invented repair failure');
      END;
    `);
    try {
      const failed = await post({
        mode: 'apply',
        dryRunId: dryRun.body.runId,
        confirmation: 'repair-attribution-not-configured-projections',
      }, 'repair-rollback-apply-0001');
      expect(failed.response.status).toBe(500);
      expect(failed.body).toMatchObject({ code: 'finance_attention_repair_failed' });
      expect(sqlite.prepare(`
        SELECT source_state AS sourceState, is_actionable AS isActionable
        FROM notifications
      `).get()).toEqual({ sourceState: 'active', isActionable: 1 });
      expect(count('notification_actions')).toBe(1);
      expect(sqlite.prepare(`
        SELECT status FROM notification_delivery_events
      `).get()).toEqual({ status: 'pending' });
      expect(sqlite.prepare(`SELECT status FROM tasks`).get()).toEqual({ status: 'todo' });
      expect(count('my_day_items')).toBe(1);
      expect(count(
        'finance_attention_repair_audit',
        `WHERE mode = 'apply'`,
      )).toBe(0);
    } finally {
      sqlite.exec(`DROP TRIGGER abort_finance_attention_repair_test`);
    }
  });
});
