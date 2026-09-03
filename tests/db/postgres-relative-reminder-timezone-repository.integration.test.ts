import { afterAll, describe, vi } from 'vitest';
import {
  describeRelativeReminderTimezoneContract,
} from '../contracts/relative-reminder-timezone-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

// This suite runs real and()/inArray()/gt()/sql`` query building against a
// live PostgreSQL database. tests/setup.ts globally mocks 'drizzle-orm' for
// unit tests; unmock it here so the repository's query builder calls produce
// real SQL instead of test-double objects (matching every other
// tests/db/postgres-*.integration.test.ts file).
vi.unmock('drizzle-orm');

vi.mock('@/db', () => {
  throw new Error(
    'SQLite database module must not be evaluated by the PostgreSQL relative reminder timezone repository',
  );
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;
let runtime: typeof import('@/db/runtime') | null = null;
let initialized = false;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-relative-reminder-timezone-test';
  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  initialized = true;
}

const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL relative reminder timezone repository integration', () => {
  afterAll(async () => {
    if (runtime) await runtime.shutdownRuntimeDatabase();
    restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
    restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
    restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
    restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  });

  describeRelativeReminderTimezoneContract('PostgreSQL', async () => {
    await initialize();
    if (!runtime) throw new Error('PostgreSQL relative reminder timezone runtime is not initialized');
    const { db, pool } = runtime.getPostgresPersistenceBackend().context;
    const { createPostgresRelativeReminderTimezoneRepository } = await import(
      '@/db/postgres/repositories/relative-reminder-timezone-repository'
    );

    const taskIds = new Set<string>();
    const timestamp = '2026-01-01T00:00:00.000Z';

    return {
      repository: createPostgresRelativeReminderTimezoneRepository(db),
      seedTask: async (input) => {
        taskIds.add(input.id);
        await pool.query(
          `INSERT INTO tasks (
             id, source_id, connector_type, connector_instance_id, title, status,
             due_date, reminder_at, reminder_relative, reminder_due_time,
             created_at, updated_at, last_synced_at
           ) VALUES (
             $1, $1, 'seed', 'seed', 'Relative reminder timezone contract', $2,
             $3, $4, $5, $6, $7, $7, $7
           )`,
          [
            input.id,
            input.status ?? 'todo',
            input.dueDate ?? null,
            input.reminderAt ?? null,
            input.reminderRelative ?? null,
            input.reminderDueTime ?? null,
            timestamp,
          ],
        );
      },
      getTask: async (id) => {
        const result = await pool.query<{
          id: string;
          dueDate: string | null;
          reminderAt: string | null;
          reminderRelative: string | null;
          reminderDueTime: string | null;
          updatedAt: string;
        }>(
          `SELECT id, due_date AS "dueDate", reminder_at AS "reminderAt",
                  reminder_relative AS "reminderRelative", reminder_due_time AS "reminderDueTime",
                  updated_at AS "updatedAt"
           FROM tasks WHERE id = $1`,
          [id],
        );
        return result.rows[0] ?? null;
      },
      close: async () => {
        for (const id of taskIds) {
          await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
        }
      },
    };
  });
});
