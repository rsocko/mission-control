import { describe, expect, it, vi } from 'vitest';
import { createPostgresPool } from '@/db/postgres/connection';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { runSqliteToPostgresImport } from '../../scripts/lib/sqlite-to-postgres-import';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const postgresUrl = process.env.MC_TEST_POSTGRES_IMPORT_URL;
const describePostgresImport = describe.skipIf(!postgresUrl);

describePostgresImport('SQLite-to-PostgreSQL import integration', () => {
  it('imports a synthetic persisted-state fixture and rebuilds derived search state', async () => {
    assertSafeIntegrationTestTarget(postgresUrl!);

    const result = await runSqliteToPostgresImport({
      fixtureId: 'v1-0047-durable-sync-queue',
      postgresUrl,
      rehearsal: true,
      resetDisposableRehearsalTarget: true,
    });

    expect(result.evidence.command.activationChanged).toBe(false);
    expect(result.evidence.verdict.ready_for_cutover_planning).toBe(true);
    expect(result.invariants).toMatchObject({
      allCopiedTableCountsMatch: true,
      orphanTaskProjects: 0,
      orphanTaskDependencies: 0,
      orphanSyncJobEvents: 0,
      orphanNotificationTasks: 0,
    });
    expect(result.invariants?.taskSearchDocuments).toBe(
      result.copiedTables.find((count) => count.table === 'tasks')?.sourceRows,
    );
    expect(result.invariants?.notificationSearchDocuments).toBe(
      result.copiedTables.find((count) => count.table === 'notifications')?.sourceRows,
    );

    const pool = createPostgresPool(resolvePostgresConfig({
      MC_POSTGRES_URL: postgresUrl,
      MC_POSTGRES_APPLICATION_NAME: 'mission-control-import-integration-test',
    }));
    try {
      const sequence = await pool.query<{ id: number }>(
        "INSERT INTO task_history_events (task_id, event_type, occurred_at, recorded_at, provenance) VALUES ('fixture-task-0047', 'integration_probe', '2026-01-15T12:00:00.000Z', '2026-01-15T12:00:00.000Z', 'test') RETURNING id",
      );
      expect(sequence.rows[0]?.id).toBeGreaterThan(0);
      const search = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM task_search_documents WHERE search_vector @@ websearch_to_tsquery('english', 'cobaltqueue')",
      );
      expect(Number(search.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
