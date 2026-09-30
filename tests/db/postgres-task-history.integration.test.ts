import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  const runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  pool = runtime.getPostgresPersistenceBackend().context.pool;
  return pool;
}

async function reset(database: Pool): Promise<void> {
  await database.query(`
    TRUNCATE TABLE
      project_phase_items,
      project_phases,
      task_projects,
      task_history_events,
      hub_projects,
      tasks,
      connector_configs
    RESTART IDENTITY CASCADE
  `);
}

afterAll(async () => {
  await pool?.end();
  pool = null;
});

describe.runIf(Boolean(connectionString))('PostgreSQL task-history triggers', () => {
  it.each([
    ['github-issues', 'github-live', 'connector'],
    ['microsoft-todo', 'todo-live', 'connector'],
    ['custom-rest', 'rest-live', 'connector'],
    ['local', 'local', 'local'],
  ])('captures task and scope history for %s writers', async (
    connectorType,
    connectorId,
    expectedProvenance,
  ) => {
    const database = await getPool();
    await reset(database);
    const now = '2026-09-30T01:00:00.000Z';

    await database.query(
      `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
       VALUES ($1, $2, $2, '{}', $3, $3)`,
      [connectorId, connectorType, now],
    );
    await database.query(
      `INSERT INTO hub_projects (id, name, created_at, updated_at)
       VALUES ('project-1', 'Project', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO tasks (
         id, source_id, connector_type, connector_instance_id, title,
         created_at, updated_at, last_synced_at
       ) VALUES ('task-1', 'source-1', $1, $2, 'Task', $3, $3, $3)`,
      [connectorType, connectorId, now],
    );
    await database.query(
      `INSERT INTO task_projects (task_id, project_id) VALUES ('task-1', 'project-1')`,
    );
    const baseline = await database.query<{ occurred_at: string }>(
      `SELECT occurred_at FROM task_history_events
       WHERE task_id = 'task-1' AND event_type = 'baseline'`,
    );
    const completedAt = new Date(
      new Date(baseline.rows[0]!.occurred_at).getTime() + 1_000,
    ).toISOString();
    await database.query(
      `UPDATE tasks
       SET status = 'done', completed_at = $1, updated_at = $1, sync_status = 'synced'
       WHERE id = 'task-1'`,
      [completedAt],
    );

    const result = await database.query<{
      event_type: string;
      occurred_at: string;
      provenance: string;
      project_id: string | null;
    }>(
      `SELECT event_type, occurred_at, provenance, project_id
       FROM task_history_events
       WHERE task_id = 'task-1'
       ORDER BY id`,
    );

    expect(result.rows.map(({ event_type }) => event_type)).toEqual([
      'baseline',
      'project_added',
      'status_changed',
    ]);
    expect(result.rows[0]?.provenance).toBe(expectedProvenance);
    expect(result.rows[1]).toMatchObject({
      event_type: 'project_added',
      project_id: 'project-1',
    });
    expect(result.rows[2]).toMatchObject({
      event_type: 'status_changed',
      occurred_at: completedAt,
      provenance: expectedProvenance,
    });
  });

  it('captures reopen, field, disposition, project, and phase transitions', async () => {
    const database = await getPool();
    await reset(database);
    const now = '2026-09-30T01:00:00.000Z';

    await database.query(
      `INSERT INTO connector_configs (id, type, name, capabilities, created_at, updated_at)
       VALUES ('local', 'local', 'Local', '{}', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO hub_projects (id, name, created_at, updated_at)
       VALUES ('project-1', 'Project', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO project_phases (
         id, project_id, name, created_at, updated_at
       ) VALUES ('phase-1', 'project-1', 'Phase', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO tasks (
         id, source_id, connector_type, connector_instance_id, title, status,
         created_at, updated_at, completed_at, last_synced_at
       ) VALUES (
         'task-1', 'local:task-1', 'local', 'local', 'Task', 'done',
         $1, $1, $1, $1
       )`,
      [now],
    );
    await database.query(
      `INSERT INTO task_projects (task_id, project_id) VALUES ('task-1', 'project-1')`,
    );
    await database.query(
      `INSERT INTO project_phase_items (id, phase_id, task_id, created_at)
       VALUES ('item-1', 'phase-1', 'task-1', $1)`,
      [now],
    );
    await database.query(
      `UPDATE tasks
       SET status = 'todo', completed_at = NULL, micro_status = 'blocked',
           kanban_column = 'doing', effort = 3, local_disposition = 'handled',
           due_date = '2026-10-01', snoozed_until = '2026-10-01T01:00:00.000Z',
           updated_at = $1
       WHERE id = 'task-1'`,
      [now],
    );
    await database.query(
      `UPDATE tasks
       SET due_date = '2026-10-04',
           snoozed_until = '2026-10-01T13:00:00.000Z',
           updated_at = $1
       WHERE id = 'task-1'`,
      [now],
    );
    await database.query(`DELETE FROM task_projects WHERE task_id = 'task-1'`);

    const result = await database.query<{
      event_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, metadata FROM task_history_events
       WHERE task_id = 'task-1' ORDER BY id`,
    );
    expect(result.rows.map(({ event_type }) => event_type)).toEqual(expect.arrayContaining([
      'baseline',
      'project_added',
      'phase_added',
      'status_changed',
      'reopened',
      'micro_status_changed',
      'kanban_column_changed',
      'effort_changed',
      'local_disposition_changed',
      'due_date_pushed',
      'snooze_extended',
      'phase_removed',
      'project_removed',
    ]));
    expect(result.rows.find(({ event_type }) => event_type === 'due_date_pushed')?.metadata)
      .toEqual({ delayDays: 3 });
    expect(result.rows.find(({ event_type }) => event_type === 'snooze_extended')?.metadata)
      .toEqual({ delayHours: 12 });

    const historyId = await database.query<{ id: number }>(
      `SELECT id FROM task_history_events WHERE task_id = 'task-1' ORDER BY id LIMIT 1`,
    );
    await expect(database.query(
      `UPDATE task_history_events SET metadata = '{}' WHERE id = $1`,
      [historyId.rows[0]?.id],
    )).rejects.toThrow(/append-only/);
    await expect(database.query(
      `DELETE FROM task_history_events WHERE id = $1`,
      [historyId.rows[0]?.id],
    )).rejects.toThrow(/append-only/);
  });
});

describe.skipIf(Boolean(connectionString))('PostgreSQL task-history triggers', () => {
  it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
});
