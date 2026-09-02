import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresPlanningSignalRepository,
  createPostgresProjectAutomationRepository,
} from '@/db/postgres/repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL planning and project automation integration', () => {
  const suffix = randomUUID();
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-planning-project-test',
          }),
        }
      : {}),
  });
  const planningTaskId = `planning-${suffix}`;
  const projectId = `project-${suffix}`;
  const bulkConnectorId = `bulk-${suffix}`;
  const projectTaskIds = Array.from({ length: 501 }, (_, index) => `project-${suffix}-${index}`);

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    const { pool } = backend.context;
    const now = new Date().toISOString();
    await pool.query(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        priority, due_date, created_at, updated_at, last_synced_at
      ) VALUES ($1, $2, 'local', 'local', 'Planning task', 'todo', 'none',
                '2026-08-18', $3, $3, $3)
    `, [planningTaskId, `local:${planningTaskId}`, now]);
    await pool.query(`
      INSERT INTO my_day_items (
        id, task_id, date, added_at, is_auto_included, "order"
      ) VALUES ($1, $2, '2026-08-19', '2026-08-19T12:00:00.000Z', FALSE, 1)
    `, [`my-day-${suffix}`, planningTaskId]);
    await pool.query(`
      INSERT INTO hub_projects (
        id, name, color, source_bindings, auto_include_rules, kanban_columns,
        default_view, status, hidden, sort_order, hierarchy_revision, metadata,
        created_at, updated_at
      ) VALUES (
        $1, 'Automation project', '#3b82f6', '[]'::jsonb, $2::jsonb, '[]'::jsonb,
        'list', 'active', FALSE, 0, 0, '{}'::jsonb, $3, $3
      )
    `, [
      projectId,
      JSON.stringify([{ type: 'connector', value: bulkConnectorId }]),
      now,
    ]);
    for (let index = 0; index < projectTaskIds.length; index += 500) {
      const ids = projectTaskIds.slice(index, index + 500);
      await pool.query(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          priority, created_at, updated_at, last_synced_at
        )
        SELECT id, 'local:' || id, 'local', $1, 'Bulk task ' || ordinal,
               'todo', 'none', $2, $2, $2
        FROM unnest($3::text[]) WITH ORDINALITY AS candidate(id, ordinal)
      `, [bulkConnectorId, now, ids]);
    }
  }, 120_000);

  afterAll(async () => {
    const { pool } = backend.context;
    await pool.query(`DELETE FROM project_auto_include_exclusions WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM task_projects WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM hub_projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM my_day_items WHERE task_id = $1`, [planningTaskId]);
    await pool.query(`
      DELETE FROM task_history_events
      WHERE task_id = $1
         OR (
           task_id = '__planning-signal-finalizer__'
           AND new_value IN (
             '2026-08-20T12:00:00.000Z',
             '2026-08-20T12:05:00.000Z'
           )
         )
    `, [planningTaskId]);
    await pool.query(`DELETE FROM tasks WHERE id = $1 OR id = ANY($2::text[])`, [
      planningTaskId,
      projectTaskIds,
    ]);
    await pool.query(`DROP TRIGGER IF EXISTS planning_signal_recovery_test ON task_history_events`);
    await pool.query(`DROP FUNCTION IF EXISTS planning_signal_recovery_test()`);
    await backend.shutdown();
  });

  it('coordinates replicas and retries a failed finalizer window', async () => {
    const { pool } = backend.context;
    const repositoryA = createPostgresPlanningSignalRepository(pool);
    const repositoryB = createPostgresPlanningSignalRepository(pool);
    const now = new Date('2026-08-20T12:02:00.000Z');

    const replicaResults = await Promise.all([
      repositoryA.finalizeIfDue({ today: '2026-08-20', now }),
      repositoryB.finalizeIfDue({ today: '2026-08-20', now }),
    ]);
    expect(replicaResults.filter((result) => result !== null)).toHaveLength(1);
    expect(replicaResults.filter((result) => result === null)).toHaveLength(1);

    await pool.query(`
      CREATE OR REPLACE FUNCTION planning_signal_recovery_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.task_id = '${planningTaskId}' AND NEW.event_type = 'became_overdue' THEN
          RAISE EXCEPTION 'injected finalizer failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER planning_signal_recovery_test
      BEFORE INSERT ON task_history_events
      FOR EACH ROW EXECUTE FUNCTION planning_signal_recovery_test()
    `);
    await pool.query(`
      DELETE FROM task_history_events
      WHERE task_id = $1
         OR (
           task_id = '__planning-signal-finalizer__'
           AND new_value = '2026-08-20T12:05:00.000Z'
         )
    `, [planningTaskId]);
    const retryWindow = new Date('2026-08-20T12:06:00.000Z');
    await expect(repositoryA.finalizeIfDue({
      today: '2026-08-20',
      now: retryWindow,
    })).rejects.toThrow('injected finalizer failure');

    await pool.query(`DROP TRIGGER planning_signal_recovery_test ON task_history_events`);
    await pool.query(`DROP FUNCTION planning_signal_recovery_test()`);
    await expect(repositoryB.finalizeIfDue({
      today: '2026-08-20',
      now: retryWindow,
    })).resolves.toMatchObject({ overdueTransitions: 1 });
  });

  it('batches, serializes replicas, rechecks exclusions, and stays idempotent', async () => {
    const { pool } = backend.context;
    const repositoryA = createPostgresProjectAutomationRepository(pool);
    const repositoryB = createPostgresProjectAutomationRepository(pool);
    const excludedTaskId = projectTaskIds[500];
    const lockClient = await pool.connect();
    let committed = false;
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      await lockClient.query(`
        INSERT INTO project_auto_include_exclusions (project_id, task_id, excluded_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (project_id, task_id)
        DO UPDATE SET excluded_at = EXCLUDED.excluded_at
      `, [projectId, excludedTaskId, new Date().toISOString()]);

      const pendingEvaluation = repositoryA.evaluateProject(projectId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await lockClient.query('COMMIT');
      committed = true;
      const first = await pendingEvaluation;
      expect(first).toMatchObject({ added: 500, matched: 501 });
      expect(first.matches.find((match) => match.taskId === excludedTaskId))
        .toMatchObject({ excluded: true, alreadyAssigned: false });
    } finally {
      if (!committed) await lockClient.query('ROLLBACK');
      lockClient.release();
    }

    const replicaResults = await Promise.all([
      repositoryA.evaluateProject(projectId),
      repositoryB.evaluateProject(projectId),
    ]);
    expect(replicaResults.every((result) => result.added === 0)).toBe(true);
    const memberships = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM task_projects WHERE project_id = $1`,
      [projectId],
    );
    expect(Number(memberships.rows[0]?.count)).toBe(500);
  });
});
