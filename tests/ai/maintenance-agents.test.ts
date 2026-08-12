import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeMaintenanceAgent,
  MAINTENANCE_AGENT_BUDGETS,
  MaintenanceAgentConflictError,
} from '@/lib/ai/agents/maintenance';

const NOW = new Date('2026-08-06T16:00:00.000Z');

let database: Database.Database;

beforeEach(() => {
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE maintenance_agent_runs (
      id TEXT PRIMARY KEY NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0,
      checkpoint_start TEXT,
      checkpoint_end TEXT,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      mutation_count INTEGER NOT NULL DEFAULT 0,
      has_more INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX idx_maintenance_agent_runs_active
      ON maintenance_agent_runs(agent_type)
      WHERE status = 'running';
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      read_state TEXT NOT NULL DEFAULT 'unread',
      disposition TEXT NOT NULL DEFAULT 'inbox',
      source_state TEXT NOT NULL DEFAULT 'active',
      snoozed_until TEXT,
      level TEXT NOT NULL,
      received_at TEXT NOT NULL,
      read_at TEXT,
      dismissed_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      due_date TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  database.close();
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    database,
    now: () => NOW,
    ...overrides,
  };
}

function insertNotifications(count: number): void {
  const insert = database.prepare(`
    INSERT INTO notifications (id, title, state, level, received_at)
    VALUES (?, ?, 'unread', 'fyi', '2026-07-01T00:00:00.000Z')
  `);
  const transaction = database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `notification-${index.toString().padStart(3, '0')}`;
      insert.run(id, `Notification ${index}`);
    }
  });
  transaction();
}

describe('bounded maintenance agents', () => {
  it('returns a successful empty batch without a checkpoint', () => {
    const result = executeMaintenanceAgent('cleanup-done', options());

    expect(result).toMatchObject({
      status: 'success',
      actionsPerformed: 0,
      checkpoint: null,
      hasMore: false,
      scanned: 0,
      remainingWork: 'none',
    });
  });

  it('keeps exact boundary batches and result details bounded', () => {
    insertNotifications(MAINTENANCE_AGENT_BUDGETS.mutationLimit);

    const result = executeMaintenanceAgent('dismiss-old-notifications', options());

    expect(result.status).toBe('success');
    expect(result.actionsPerformed).toBe(MAINTENANCE_AGENT_BUDGETS.mutationLimit);
    expect(result.details).toHaveLength(MAINTENANCE_AGENT_BUDGETS.detailLimit);
    expect(result.hasMore).toBe(false);
    const dismissed = database.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE state = 'dismissed'",
    ).get() as { count: number };
    expect(dismissed.count).toBe(MAINTENANCE_AGENT_BUDGETS.mutationLimit);
  });

  it('resumes a large workload from its durable checkpoint', () => {
    insertNotifications(MAINTENANCE_AGENT_BUDGETS.mutationLimit + 1);

    const first = executeMaintenanceAgent('dismiss-old-notifications', options());
    const second = executeMaintenanceAgent('dismiss-old-notifications', options());

    expect(first).toMatchObject({
      status: 'partial',
      actionsPerformed: MAINTENANCE_AGENT_BUDGETS.mutationLimit,
      hasMore: true,
      checkpoint: 'notification-099',
    });
    expect(second).toMatchObject({
      status: 'success',
      actionsPerformed: 1,
      hasMore: false,
      checkpoint: null,
    });
    const runs = database.prepare(`
      SELECT status, checkpoint_start AS checkpointStart, mutation_count AS mutationCount
      FROM maintenance_agent_runs
      ORDER BY started_at, rowid
    `).all();
    expect(runs).toEqual([
      { status: 'partial', checkpointStart: null, mutationCount: 100 },
      { status: 'succeeded', checkpointStart: 'notification-099', mutationCount: 1 },
    ]);
  });

  it('bounds source scanning even when most rows are ineligible', () => {
    const insert = database.prepare(`
      INSERT INTO notifications (id, title, state, read_state, level, received_at)
      VALUES (?, ?, ?, ?, 'fyi', '2026-07-01T00:00:00.000Z')
    `);
    const transaction = database.transaction(() => {
      for (let index = 0; index <= MAINTENANCE_AGENT_BUDGETS.mutationLimit; index += 1) {
        const id = `notification-${index.toString().padStart(3, '0')}`;
        insert.run(
          id,
          `Notification ${index}`,
          index === MAINTENANCE_AGENT_BUDGETS.mutationLimit ? 'unread' : 'read',
          index === MAINTENANCE_AGENT_BUDGETS.mutationLimit ? 'unread' : 'read',
        );
      }
    });
    transaction();

    const first = executeMaintenanceAgent('dismiss-old-notifications', options());
    const second = executeMaintenanceAgent('dismiss-old-notifications', options());

    expect(first).toMatchObject({
      status: 'partial',
      scanned: MAINTENANCE_AGENT_BUDGETS.scanLimit,
      actionsPerformed: 0,
      checkpoint: 'notification-099',
    });
    expect(second).toMatchObject({
      status: 'success',
      scanned: 1,
      actionsPerformed: 1,
    });
  });

  it('rejects an overlapping run of the same agent', () => {
    database.prepare(`
      INSERT INTO maintenance_agent_runs (
        id, agent_type, status, lease_expires_at, started_at
      ) VALUES ('active', 'cleanup-done', 'running', ?, ?)
    `).run('2026-08-06T16:00:10.000Z', NOW.toISOString());

    expect(() => executeMaintenanceAgent('cleanup-done', options()))
      .toThrow(MaintenanceAgentConflictError);
  });

  it('propagates cancellation without mutating eligible rows', () => {
    insertNotifications(1);
    const controller = new AbortController();
    controller.abort();

    const result = executeMaintenanceAgent(
      'dismiss-old-notifications',
      options({ signal: controller.signal }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'cancelled',
      actionsPerformed: 0,
      hasMore: true,
      remainingWork: 'unknown',
    });
    const notification = database.prepare(
      "SELECT state FROM notifications WHERE id = 'notification-000'",
    ).get();
    expect(notification).toEqual({ state: 'unread' });
  });

  it('reports a timeout before mutation', () => {
    insertNotifications(1);
    let tick = 0;
    const clock = () => {
      tick += MAINTENANCE_AGENT_BUDGETS.durationMs;
      return tick;
    };

    const result = executeMaintenanceAgent(
      'dismiss-old-notifications',
      options({ clock }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'timed_out',
      actionsPerformed: 0,
      remainingWork: 'unknown',
    });
  });

  it('rolls back mutations that exceed the duration budget', () => {
    insertNotifications(1);
    let checks = 0;
    const clock = () => {
      checks += 1;
      return checks >= 5 ? MAINTENANCE_AGENT_BUDGETS.durationMs : 0;
    };

    const result = executeMaintenanceAgent(
      'dismiss-old-notifications',
      options({ clock }),
    );

    expect(result).toMatchObject({
      status: 'failed',
      stopReason: 'timed_out',
      actionsPerformed: 0,
    });
    expect(database.prepare(
      "SELECT state FROM notifications WHERE id = 'notification-000'",
    ).get()).toEqual({ state: 'unread' });
  });

  it('records partial failure and retries idempotently from the same checkpoint', () => {
    insertNotifications(2);
    database.exec(`
      CREATE TRIGGER fail_notification_update
      BEFORE UPDATE OF state ON notifications
      BEGIN
        SELECT RAISE(FAIL, 'injected mutation failure');
      END;
    `);

    const failed = executeMaintenanceAgent('dismiss-old-notifications', options());
    expect(failed).toMatchObject({
      status: 'failed',
      actionsPerformed: 0,
      checkpoint: null,
      hasMore: true,
      remainingWork: 'unknown',
      stopReason: 'error',
    });
    database.exec('DROP TRIGGER fail_notification_update');

    const retried = executeMaintenanceAgent('dismiss-old-notifications', options());
    expect(retried).toMatchObject({
      status: 'success',
      actionsPerformed: 2,
      hasMore: false,
    });
  });

  it('pushes eligibility into SQL for every task maintenance agent', () => {
    const insert = database.prepare(`
      INSERT INTO tasks (id, title, status, priority, due_date, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('archive', 'Archive me', 'done', 'none', null, '2026-06-01T00:00:00.000Z', NOW.toISOString());
    insert.run('recent', 'Keep me', 'done', 'none', null, '2026-08-01T00:00:00.000Z', NOW.toISOString());
    insert.run('snooze', 'Snooze me', 'todo', 'low', '2026-08-01', null, NOW.toISOString());
    insert.run('urgent', 'Escalate me', 'todo', 'none', '2026-08-06', null, NOW.toISOString());
    insert.run('future', 'Leave me', 'todo', 'none', '2026-09-01', null, NOW.toISOString());

    const cleanup = executeMaintenanceAgent('cleanup-done', options());
    const snooze = executeMaintenanceAgent('snooze-low-priority', options());
    const prioritize = executeMaintenanceAgent('bulk-prioritize', options());

    expect(cleanup.actionsPerformed).toBe(1);
    expect(snooze.actionsPerformed).toBe(1);
    expect(prioritize.actionsPerformed).toBe(1);
    expect(database.prepare('SELECT status FROM tasks WHERE id = ?').get('recent'))
      .toEqual({ status: 'done' });
    expect(database.prepare('SELECT priority FROM tasks WHERE id = ?').get('future'))
      .toEqual({ priority: 'none' });
  });
});
