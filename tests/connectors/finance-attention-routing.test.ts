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

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-attention-'));
const databasePath = join(tempDirectory, 'attention.db');
const connectorId = 'finance-attention-invented';
const now = new Date('2026-08-11T12:00:00.000Z');

let sqlite: Database.Database;
let reconcileFinanceAttention:
  typeof import('@/lib/finance/attention-routing')['reconcileFinanceAttention'];
let selectFinanceAttentionRoute:
  typeof import('@/lib/finance/attention-routing')['selectFinanceAttentionRoute'];
let financeAttentionSourceId:
  typeof import('@/lib/finance/attention-routing')['financeAttentionSourceId'];
let financeAttentionTaskId:
  typeof import('@/lib/finance/attention-routing')['financeAttentionTaskId'];
let FINANCE_TASK_PROMOTION_DAILY_CAP:
  typeof import('@/lib/finance/attention-routing')['FINANCE_TASK_PROMOTION_DAILY_CAP'];
let FINANCE_MY_DAY_DAILY_CAP:
  typeof import('@/lib/finance/attention-routing')['FINANCE_MY_DAY_DAILY_CAP'];

function iso(hoursAgo: number): string {
  return new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function seedConnector(): void {
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (?, 'finance-manager', 'Invented Finance', 1, 'poll', '{}', '{}', '{}', '[]', ?, ?)
  `).run(connectorId, now.toISOString(), now.toISOString());
}

function seedAttribution({
  id = 'exception-attribution-one',
  hoursAgo = 2,
  sourceHoursAgo = hoursAgo,
  status = 'open',
}: {
  id?: string;
  hoursAgo?: number;
  sourceHoursAgo?: number;
  status?: string;
} = {}): void {
  sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, source_ref, status, reason_code,
      retryable, review_state, source_fingerprint, policy_version,
      occurrence_count, created_at, first_observed_at, last_observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'attribution_ambiguous', 0, 'pending',
      'fingerprint-invented', 1, 1, ?, ?, ?, ?)
  `).run(
    id,
    connectorId,
    `transaction-${id}`,
    `source-${id}`,
    status,
    iso(hoursAgo),
    iso(hoursAgo),
    iso(sourceHoursAgo),
    iso(sourceHoursAgo),
  );
}

function seedAttributionBatch({
  count,
  status = 'open',
  firstObservedHoursAgo = 2,
  lastObservedHoursAgo = 1,
}: {
  count: number;
  status?: 'open' | 'resolved';
  firstObservedHoursAgo?: number;
  lastObservedHoursAgo?: number;
}): void {
  const insert = sqlite.prepare(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, source_ref, status, reason_code,
      retryable, review_state, source_fingerprint, policy_version,
      occurrence_count, created_at, first_observed_at, last_observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'attribution_ambiguous', 0, ?,
      ?, 1, 1, ?, ?, ?, ?)
  `);
  sqlite.transaction(() => {
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(5, '0');
      const id = `exception-bulk-${suffix}`;
      insert.run(
        id,
        connectorId,
        `transaction-bulk-${suffix}`,
        `source-bulk-${suffix}`,
        status,
        status === 'resolved' ? 'resolved' : 'pending',
        `fingerprint-bulk-${suffix}`,
        iso(firstObservedHoursAgo),
        iso(firstObservedHoursAgo),
        iso(lastObservedHoursAgo),
        now.toISOString(),
      );
    }
  })();
}

function seedWriteBack({
  id = 'audit-one',
  hoursAgo = 0.25,
  status = 'failed',
  attemptCount = 3,
  errorMessage = 'Private upstream message must not escape',
}: {
  id?: string;
  hoursAgo?: number;
  status?: string;
  attemptCount?: number;
  errorMessage?: string;
} = {}): void {
  sqlite.prepare(`
    INSERT INTO finance_mutation_audit (
      id, idempotency_key, connector_id, transaction_id, upstream_transaction_id,
      operation, requested_value, status, attempt_count, last_error_code,
      last_error_message, created_at, updated_at
    ) VALUES (?, ?, ?, 'transaction-writeback-one', 'upstream-sensitive-one',
      'set_category', '"invented-category"', ?, ?, 'WRITE_FAILED', ?, ?, ?)
  `).run(
    id,
    `idempotency-${id}`,
    connectorId,
    status,
    attemptCount,
    errorMessage,
    iso(hoursAgo),
    iso(hoursAgo),
  );
}

function count(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function clearDatabase(): void {
  for (const table of [
    'my_day_items',
    'my_day_exclusions',
    'task_tags',
    'notification_delivery_events',
    'notification_actions',
    'notifications',
    'tasks',
    'finance_mutation_audit',
    'finance_attribution_exceptions',
    'finance_transactions',
    'connector_configs',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  seedConnector();
}

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  ({ sqlite } = await import('@/db'));
  ({
    financeAttentionSourceId,
    financeAttentionTaskId,
    FINANCE_TASK_PROMOTION_DAILY_CAP,
    FINANCE_MY_DAY_DAILY_CAP,
    reconcileFinanceAttention,
    selectFinanceAttentionRoute,
  } = await import('@/lib/finance/attention-routing'));
}, 30_000);

beforeEach(clearDatabase);

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe.sequential('finance attention routing', () => {
  it('selects every routing matrix outcome deterministically', () => {
    const signal = {
      connectorId,
      signalKind: 'attributionReviewRequired' as const,
      sourceRef: 'exception-one',
      sourceLifecycle: 'open' as const,
      conditionSince: iso(2),
      sourceAsOf: iso(2),
      activityKey: 'activity-one',
      actionable: true,
      settlementReason: null,
    };

    expect(selectFinanceAttentionRoute(signal, now)).toBe('actionableNotification');
    expect(selectFinanceAttentionRoute({
      ...signal,
      conditionSince: iso(25),
      sourceAsOf: iso(1),
    }, now)).toBe('task');
    expect(selectFinanceAttentionRoute({
      ...signal,
      signalKind: 'writeBackFailed',
      conditionSince: iso(0.25),
      sourceAsOf: iso(0.25),
    }, now)).toBe('task');
    expect(selectFinanceAttentionRoute({ ...signal, actionable: false }, now)).toBe('statusOnly');
    expect(selectFinanceAttentionRoute({
      ...signal,
      sourceLifecycle: 'resolved',
    }, now)).toBe('settled');
    expect(selectFinanceAttentionRoute({
      ...signal,
      sourceAsOf: iso(73),
      conditionSince: iso(73),
    }, now)).toBe('stale');
    expect(selectFinanceAttentionRoute({
      ...signal,
      signalKind: 'writeBackFailed',
      sourceAsOf: iso(2),
      conditionSince: iso(2),
    }, now)).toBe('stale');
  });

  it('keeps a fresh attribution ambiguity in notifications before promotion', async () => {
    seedAttribution();

    const first = await reconcileFinanceAttention({ connectorId, now });
    const replay = await reconcileFinanceAttention({ connectorId, now });

    expect(first).toMatchObject({
      evaluated: 1,
      notificationsCreated: 1,
      tasksCreated: 0,
    });
    expect(replay).toMatchObject({
      evaluated: 1,
      notificationsCreated: 0,
      tasksCreated: 0,
    });
    expect(count('notifications')).toBe(1);
    expect(count('tasks')).toBe(0);
    expect(count('my_day_items')).toBe(0);
    expect(sqlite.prepare(`
      SELECT navigation_target AS target FROM notifications
    `).get()).toEqual({ target: '/finance/review' });
  });

  it('promotes attribution exactly at the 24-hour boundary', async () => {
    seedAttribution({ hoursAgo: 24, sourceHoursAgo: 0 });

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result).toMatchObject({
      taskPromoted: 1,
      tasksCreated: 1,
      autoIncluded: 0,
      deferred: 0,
    });
  });

  it('drains actionable attention across source batches without duplicate replay', async () => {
    seedAttributionBatch({ count: 501 });

    const first = await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      DELETE FROM finance_attribution_exceptions
      WHERE id != 'exception-bulk-00500'
    `).run();
    const replay = await reconcileFinanceAttention({ connectorId, now });

    expect(first).toMatchObject({
      evaluated: 501,
      notificationsCreated: 501,
      tasksCreated: 0,
    });
    expect(replay).toMatchObject({
      evaluated: 1,
      notificationsCreated: 0,
      tasksCreated: 0,
    });
    expect(count('notifications')).toBe(501);
    expect(count('tasks')).toBe(0);
  });

  it('does not let historical rows above the former cap block new attention', async () => {
    seedAttributionBatch({ count: 5_001, status: 'resolved' });
    seedAttribution({ id: 'exception-new-actionable' });

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result).toMatchObject({
      evaluated: 5_002,
      notificationsCreated: 1,
      tasksCreated: 0,
    });
    expect(count('notifications')).toBe(1);
  });

  it('bounds a freshly re-observed 90-day attribution backlog across reruns', async () => {
    const backlogSize = 501;
    const firstDeferred = backlogSize - FINANCE_TASK_PROMOTION_DAILY_CAP;
    seedAttributionBatch({
      count: backlogSize,
      firstObservedHoursAgo: 89 * 24,
      lastObservedHoursAgo: 1,
    });

    const first = await reconcileFinanceAttention({ connectorId, now });
    const replay = await reconcileFinanceAttention({ connectorId, now });

    expect(first).toMatchObject({
      evaluated: backlogSize,
      taskPromoted: FINANCE_TASK_PROMOTION_DAILY_CAP,
      tasksCreated: FINANCE_TASK_PROMOTION_DAILY_CAP,
      autoIncluded: 0,
      deferred: firstDeferred,
    });
    expect(replay).toMatchObject({
      taskPromoted: 0,
      tasksCreated: 0,
      deferred: firstDeferred,
    });
    expect(count('tasks')).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP);
    expect(count('my_day_items')).toBe(0);

    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET last_observed_at = ?, updated_at = ?
      WHERE connector_id = ?
    `).run(tomorrow.toISOString(), tomorrow.toISOString(), connectorId);
    const carryForward = await reconcileFinanceAttention({ connectorId, now: tomorrow });
    expect(carryForward).toMatchObject({
      taskPromoted: FINANCE_TASK_PROMOTION_DAILY_CAP,
      tasksCreated: FINANCE_TASK_PROMOTION_DAILY_CAP,
      deferred: firstDeferred - FINANCE_TASK_PROMOTION_DAILY_CAP,
    });
    expect(count('tasks')).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP * 2);
  });

  it('prioritizes exhausted write-backs before medium attribution promotion', async () => {
    seedAttributionBatch({
      count: FINANCE_TASK_PROMOTION_DAILY_CAP,
      firstObservedHoursAgo: 48,
      lastObservedHoursAgo: 1,
    });
    seedWriteBack({ id: 'audit-priority' });

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.taskPromoted).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP);
    expect(result.deferred).toBe(1);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE title = 'Resolve a failed finance write-back'
    `).get()).toEqual({ count: 1 });
    expect(count('my_day_items')).toBe(1);
  });

  it('does not charge routine legacy-task syncs against today promotion cap', async () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    seedAttribution({ hoursAgo: 48, sourceHoursAgo: 25 });
    await reconcileFinanceAttention({ connectorId, now: yesterday });
    sqlite.prepare(`
      UPDATE tasks
      SET metadata = json_remove(metadata, '$.financeAttention.promotedAt')
    `).run();
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET last_observed_at = ?, updated_at = ?
      WHERE id = 'exception-attribution-one'
    `).run(iso(2), iso(2));
    await reconcileFinanceAttention({
      connectorId,
      now: new Date(now.getTime() - 60 * 60 * 1_000),
    });
    seedAttributionBatch({
      count: FINANCE_TASK_PROMOTION_DAILY_CAP,
      firstObservedHoursAgo: 48,
      lastObservedHoursAgo: 1,
    });

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.taskPromoted).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP);
    expect(result.deferred).toBe(0);
    expect(count('tasks')).toBe(FINANCE_TASK_PROMOTION_DAILY_CAP + 1);
  });

  it('rolls back every source batch when later routing fails', async () => {
    seedAttributionBatch({ count: 501 });
    sqlite.exec(`
      CREATE TRIGGER abort_finance_attention_test
      BEFORE INSERT ON notifications
      WHEN NEW.related_entity_id = 'exception-bulk-00500'
      BEGIN
        SELECT RAISE(ABORT, 'invented routing failure');
      END;
    `);

    await expect(reconcileFinanceAttention({ connectorId, now })).rejects.toThrow(
      'Finance attention routing failed (finance_attention_routing_failed)',
    );
    expect(count('notifications')).toBe(0);

    sqlite.exec(`DROP TRIGGER abort_finance_attention_test`);
    const retry = await reconcileFinanceAttention({ connectorId, now });
    expect(retry.notificationsCreated).toBe(501);
    expect(count('notifications')).toBe(501);
  });

  it('promotes a prolonged ambiguity without automatically scheduling medium backlog', async () => {
    seedAttribution({ hoursAgo: 25, sourceHoursAgo: 1 });

    const results = await Promise.all([
      reconcileFinanceAttention({ connectorId, now }),
      reconcileFinanceAttention({ connectorId, now }),
      reconcileFinanceAttention({ connectorId, now }),
    ]);

    expect(results[0].tasksCreated).toBe(1);
    expect(count('tasks')).toBe(1);
    expect(count('my_day_items')).toBe(0);
    expect(count('notifications')).toBe(0);
    const taskSignal = {
      connectorId,
      signalKind: 'attributionReviewRequired' as const,
      sourceRef: 'exception-attribution-one',
    };
    expect(sqlite.prepare(`
      SELECT id, source_id AS sourceId, connector_type AS connectorType,
             connector_instance_id AS connectorInstanceId, status, metadata
      FROM tasks
    `).get()).toMatchObject({
      id: financeAttentionTaskId(taskSignal),
      sourceId: financeAttentionSourceId(taskSignal),
      connectorType: 'mission-control',
      connectorInstanceId: 'mission-control',
      status: 'todo',
    });
    const taskId = (sqlite.prepare(`SELECT id FROM tasks`).get() as { id: string }).id;
    sqlite.exec(`DELETE FROM my_day_items`);
    sqlite.prepare(`
      INSERT INTO my_day_exclusions (id, task_id, date, removed_at)
      VALUES ('exclusion-one', ?, '2026-08-11', ?)
    `).run(taskId, now.toISOString());
    await reconcileFinanceAttention({ connectorId, now });
    expect(count('my_day_items')).toBe(0);
  });

  it('retires the notification lifecycle when an ambiguity promotes to a task', async () => {
    seedAttribution();
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET first_observed_at = ?, last_observed_at = ?, updated_at = ?
      WHERE connector_id = ?
    `).run(iso(25), iso(1), iso(1), connectorId);

    await reconcileFinanceAttention({ connectorId, now });

    expect(count('tasks')).toBe(1);
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable,
             related_task_id AS relatedTaskId
      FROM notifications
    `).get()).toMatchObject({
      sourceState: 'resolved',
      isActionable: 0,
      relatedTaskId: expect.any(String),
    });
  });

  it('projects an exhausted write-back immediately without exposing audit errors', async () => {
    seedWriteBack();

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.tasksCreated).toBe(1);
    const task = sqlite.prepare(`
      SELECT title, description, metadata FROM tasks
    `).get() as { title: string; description: string; metadata: string };
    expect(task.title).toBe('Resolve a failed finance write-back');
    expect(task.description).toBe('A confirmed Finance change could not be verified. Review it in Finance.');
    expect(task.description).not.toContain('Private upstream');
    expect(task.metadata).not.toContain('upstream-sensitive-one');
    expect(sqlite.prepare(`SELECT due_date AS dueDate FROM tasks`).get()).toEqual({
      dueDate: null,
    });
    expect(count('my_day_items')).toBe(1);
  });

  it('caps My Day, repairs prior auto-inclusions, and preserves manual choices', async () => {
    for (let index = 0; index < FINANCE_MY_DAY_DAILY_CAP + 2; index++) {
      seedWriteBack({ id: `audit-my-day-${index}` });
    }
    seedAttribution({ hoursAgo: 25, sourceHoursAgo: 1 });
    seedAttribution({
      id: 'exception-attribution-manual',
      hoursAgo: 25,
      sourceHoursAgo: 1,
    });
    await reconcileFinanceAttention({ connectorId, now });
    const attributionTasks = sqlite.prepare(`
      SELECT id FROM tasks
      WHERE title = 'Review a finance attribution exception'
      ORDER BY id
    `).all() as Array<{ id: string }>;
    sqlite.prepare(`
      INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
      VALUES ('incorrect-finance-auto', ?, '2026-08-11', ?, 1, 99)
    `).run(attributionTasks[0]!.id, now.toISOString());
    sqlite.prepare(`
      INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
      VALUES ('manual-finance-choice', ?, '2026-08-11', ?, 0, 100)
    `).run(attributionTasks[1]!.id, now.toISOString());

    const replay = await reconcileFinanceAttention({ connectorId, now });

    expect(replay.autoIncluded).toBe(FINANCE_MY_DAY_DAILY_CAP);
    expect(replay.deferred).toBe(2);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM my_day_items
      WHERE date = '2026-08-11' AND is_auto_included = 1
    `).get()).toEqual({ count: FINANCE_MY_DAY_DAILY_CAP });
    expect(sqlite.prepare(`
      SELECT id, is_auto_included AS isAutoIncluded
      FROM my_day_items WHERE id = 'manual-finance-choice'
    `).get()).toEqual({ id: 'manual-finance-choice', isAutoIncluded: 0 });
    expect(sqlite.prepare(`
      SELECT id FROM my_day_items WHERE id = 'incorrect-finance-auto'
    `).get()).toBeUndefined();
  });

  it('settles projected attention when the authoritative source resolves', async () => {
    seedAttribution({ hoursAgo: 25, sourceHoursAgo: 1 });
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'resolved', review_state = 'resolved', resolved_at = ?,
          last_observed_at = ?, updated_at = ?
      WHERE connector_id = ?
    `).run(now.toISOString(), now.toISOString(), now.toISOString(), connectorId);

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.tasksSettled).toBe(1);
    expect(sqlite.prepare(`SELECT status FROM tasks`).get()).toEqual({ status: 'done' });
    expect(count('my_day_items')).toBe(0);
  });

  it('preserves user completion while unresolved and resurfaces after source settlement', async () => {
    seedAttribution({ hoursAgo: 25, sourceHoursAgo: 1 });
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`UPDATE tasks SET status = 'done', completed_at = ?`).run(now.toISOString());
    sqlite.exec(`DELETE FROM my_day_items`);

    await reconcileFinanceAttention({ connectorId, now });
    const pending = sqlite.prepare(`SELECT status, metadata FROM tasks`).get() as {
      status: string;
      metadata: string;
    };
    expect(pending.status).toBe('done');
    expect(JSON.parse(pending.metadata).verificationPending).toBe(true);
    expect(count('my_day_items')).toBe(0);

    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'resolved', review_state = 'resolved', resolved_at = ?,
          last_observed_at = ?, updated_at = ?
    `).run(now.toISOString(), now.toISOString(), now.toISOString());
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET status = 'open', review_state = 'pending', resolved_at = NULL,
          first_observed_at = ?, last_observed_at = ?, updated_at = ?
    `).run(iso(25), iso(1), iso(1));

    await reconcileFinanceAttention({ connectorId, now });
    expect(sqlite.prepare(`SELECT status FROM tasks`).get()).toEqual({ status: 'todo' });
    expect(count('my_day_items')).toBe(0);
  });

  it('does not create or reopen attention from stale source state', async () => {
    seedAttribution({ hoursAgo: 80, sourceHoursAgo: 25 });
    seedWriteBack({ id: 'audit-stale', hoursAgo: 2 });

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result).toMatchObject({
      evaluated: 2,
      notificationsCreated: 0,
      tasksCreated: 0,
      stalePreserved: 2,
    });
    expect(count('notifications')).toBe(0);
    expect(count('tasks')).toBe(0);
  });

  it('retires a prior notification when its authoritative observation becomes stale', async () => {
    seedAttribution();
    await reconcileFinanceAttention({ connectorId, now });
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    await reconcileFinanceAttention({ connectorId, now: later });

    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable
      FROM notifications
    `).get()).toEqual({ sourceState: 'resolved', isActionable: 0 });
    expect(count('notification_actions')).toBe(0);
  });

  it('disables prior attention while the authoritative exception is status-only', async () => {
    seedAttribution();
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      UPDATE finance_attribution_exceptions
      SET retryable = 1, last_observed_at = ?, updated_at = ?
    `).run(now.toISOString(), now.toISOString());

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.statusOnly).toBe(1);
    expect(sqlite.prepare(`
      SELECT is_actionable AS isActionable, source_state AS sourceState
      FROM notifications
    `).get()).toEqual({ isActionable: 0, sourceState: 'resolved' });
    expect(count('notification_actions')).toBe(0);
  });

  it('creates attention only after the write-back attempt policy is exhausted', async () => {
    seedWriteBack({ attemptCount: 1 });
    await reconcileFinanceAttention({ connectorId, now });
    expect(count('tasks')).toBe(0);
    sqlite.prepare(`
      UPDATE finance_mutation_audit
      SET attempt_count = 3, updated_at = ?
      WHERE connector_id = ?
    `).run(now.toISOString(), connectorId);

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.tasksCreated).toBe(1);
    expect(count('tasks')).toBe(1);
  });

  it('settles a failed write-back task after the audit completes', async () => {
    seedWriteBack();
    await reconcileFinanceAttention({ connectorId, now });
    sqlite.prepare(`
      UPDATE finance_mutation_audit
      SET status = 'succeeded', completed_at = ?, updated_at = ?
      WHERE connector_id = ?
    `).run(now.toISOString(), now.toISOString(), connectorId);

    const result = await reconcileFinanceAttention({ connectorId, now });

    expect(result.tasksSettled).toBe(1);
    expect(sqlite.prepare(`SELECT status FROM tasks`).get()).toEqual({ status: 'done' });
    expect(count('my_day_items')).toBe(0);
  });
});
