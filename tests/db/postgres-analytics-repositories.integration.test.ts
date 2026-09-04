import { afterAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { describeAnalyticsRepositoriesContract } from '../contracts/analytics-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

/**
 * PostgreSQL driver for the shared analytics contract, plus the two
 * PostgreSQL-only guarantees the contract cannot express: the read surface
 * never opens a transaction or takes a row lock, and every method releases its
 * pooled client even across the widest fan-out.
 */

const connectionString = process.env.MC_TEST_POSTGRES_URL;

/** Child-before-parent, so FK-constrained deletes always succeed. */
const TABLES = [
  'project_phase_items',
  'project_phases',
  'task_projects',
  'task_tags',
  'task_history_events',
  'my_day_items',
  'focus_items',
  'routine_completions',
  'routines',
  'triage_items',
  'notifications',
  'tags',
  'hub_projects',
  'tasks',
  'connector_configs',
];

let sharedPool: Pool | null = null;

async function getSharedPool(): Promise<Pool> {
  if (!sharedPool) {
    assertSafeIntegrationTestTarget(connectionString!);
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString, max: 4 });
  }
  return sharedPool;
}

async function truncate(pool: Pool) {
  for (const table of TABLES) await pool.query(`DELETE FROM ${table}`);
}

afterAll(async () => {
  await sharedPool?.end();
  sharedPool = null;
});

// The shared contract runs against a live PostgreSQL adapter. It is registered
// only when an integration target is configured, mirroring `describe.skipIf`
// for a helper that owns its own `describe` block.
if (connectionString) {
  describeAnalyticsRepositoriesContract('PostgreSQL', async () => {
    const pool = await getSharedPool();
    const { createPostgresAnalyticsPersistence } = await import(
      '@/db/postgres/repositories/analytics-repositories'
    );
    await truncate(pool);
    return {
      repository: createPostgresAnalyticsPersistence(pool),
      async insert(table, row) {
        const columns = Object.keys(row);
        await pool.query(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
           VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
          columns.map((column) => row[column] ?? null),
        );
      },
      close: () => truncate(pool),
    };
  });
}

describe.skipIf(!connectionString)('PostgreSQL analytics runtime behaviour', () => {
  it('never opens a transaction or takes a row lock', async () => {
    const pool = await getSharedPool();
    const { createPostgresAnalyticsPersistence } = await import(
      '@/db/postgres/repositories/analytics-repositories'
    );
    await truncate(pool);
    const statements: string[] = [];
    const client = await pool.connect();
    try {
      const instrumented = {
        query: (...args: Parameters<PoolClient['query']>) => {
          const [first] = args;
          statements.push(typeof first === 'string' ? first : String((first as { text: string }).text));
          return (client.query as (...inner: unknown[]) => unknown)(...args);
        },
      } as unknown as Pool;

      const repository = createPostgresAnalyticsPersistence(instrumented);
      await repository.kpis.countOpenTasks();
      await repository.insights.sourceBreakdownIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      });
      await repository.flow.listFlowTasks();
      await repository.tagInsights.listSyntheticTagCandidates();
      await repository.wordInsights.listTasksWithLiveConnector(5);

      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i);
        expect(statement).not.toMatch(/FOR UPDATE|FOR SHARE|pg_advisory/i);
        expect(statement).not.toMatch(/SET TRANSACTION|ISOLATION LEVEL/i);
      }
    } finally {
      client.release();
    }
  });

  it('releases pooled clients across the widest read fan-out', async () => {
    const pool = await getSharedPool();
    const { createPostgresAnalyticsPersistence } = await import(
      '@/db/postgres/repositories/analytics-repositories'
    );
    await truncate(pool);
    const repository = createPostgresAnalyticsPersistence(pool);
    const range = {
      startInclusive: '2026-03-10T00:00:00.000Z',
      endExclusive: '2026-03-11T00:00:00.000Z',
    };

    // Wider than the pool: this deadlocks if any method holds its client.
    for (let round = 0; round < 3; round += 1) {
      await Promise.all([
        repository.insights.countTasksCompletedIn(range),
        repository.insights.countTopLevelTasksCreatedIn(range),
        repository.insights.listCompletedTimestampsIn(range),
        repository.insights.listCreatedTimestampsIn(range),
        repository.insights.listCompletionSpansIn(range),
        repository.insights.listCompletedTimestampsSince(range.startInclusive),
        repository.insights.sourceBreakdownIn(range),
        repository.insights.listOpenTaskCreatedTimestamps(),
        repository.insights.listPlanningFrictionEvents(['due_date_pushed'], range),
        repository.insights.listActiveProjects(),
        repository.insights.deliveryFilterOptions(),
      ]);
    }

    expect(pool.idleCount).toBeGreaterThan(0);
    expect(pool.waitingCount).toBe(0);
  });
});
