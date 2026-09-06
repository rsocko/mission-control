/**
 * Live PostgreSQL side of the operational-utility persistence contract.
 *
 * Skipped unless `MC_TEST_POSTGRES_URL` points at a disposable database, per
 * the established integration-test pattern.
 */
import { afterAll, describe, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@/db/postgres/schema';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describeOperationalUtilityPersistenceContract,
  type OperationalUtilityContractHarness,
  type SeedConnectorInput,
  type SeedSourceListInput,
  type SeedTagInput,
  type SeedTaskInput,
} from '../contracts/operational-utility-persistence.contract';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const TABLES = [
  'task_tags',
  'my_day_items',
  'task_projects',
  'project_auto_include_exclusions',
  'tasks',
  'tags',
  'source_lists',
  'sync_log',
  'connector_configs',
];

let sharedPool: Pool | null = null;

async function pool(): Promise<Pool> {
  if (!sharedPool) {
    assertSafeIntegrationTestTarget(connectionString!);
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString, max: 4 });
  }
  return sharedPool;
}

async function clear(database: Pool): Promise<void> {
  for (const table of TABLES) await database.query(`DELETE FROM "${table}"`);
  await database.query('DROP TABLE IF EXISTS public_demo_runtime');
}

afterAll(async () => {
  await sharedPool?.end();
  sharedPool = null;
});

function createHarness(
  database: Pool,
  persistence: OperationalUtilityContractHarness['persistence'],
): OperationalUtilityContractHarness {
  return {
    persistence,
    // The shipped PostgreSQL schema enforces the unique
    // (source_id, connector_instance_id) index, so legacy duplicates cannot be
    // reproduced here; the SQLite contract run covers that repair path.
    supportsDuplicateSourceRows: false,
    // `metadata` is jsonb, so the column cannot hold invalid JSON text.
    supportsCorruptMetadataText: false,
    reset: () => clear(database),
    async seedConnector(input: SeedConnectorInput) {
      await database.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, capabilities, credentials, settings,
           synced_lists, created_at, updated_at, deleted_at
         ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $8, $9)`,
        [
          input.id,
          input.type,
          input.name,
          input.enabled !== false,
          JSON.stringify(input.capabilities ?? {}),
          JSON.stringify(input.settings ?? {}),
          JSON.stringify(input.syncedLists ?? []),
          input.createdAt ?? '2026-09-01T00:00:00.000Z',
          input.deletedAt ?? null,
        ],
      );
    },
    async seedSourceList(input: SeedSourceListInput) {
      await database.query(
        `INSERT INTO source_lists (id, connector_instance_id, source_id, name, type)
         VALUES ($1, $2, $3, $4, 'repo')`,
        [input.id, input.connectorInstanceId, input.sourceId, input.name],
      );
    },
    async seedTask(input: SeedTaskInput) {
      await database.query(
        `INSERT INTO tasks (
           id, source_id, connector_type, connector_instance_id, title, status,
           priority, source_list_id, due_date, completed_at, created_at,
           updated_at, last_synced_at, metadata
         ) VALUES (
           $1, $2, 'github-issues', $3, $4, $5, 'none', $6, $7, $8,
           '2026-09-01T00:00:00.000Z', $9, $10, $11::jsonb
         )`,
        [
          input.id,
          input.sourceId,
          input.connectorInstanceId,
          input.title,
          input.status ?? 'todo',
          input.sourceListId ?? null,
          input.dueDate ?? null,
          input.completedAt ?? null,
          input.updatedAt ?? '2026-09-01T00:00:00.000Z',
          input.lastSyncedAt ?? '2026-09-01T00:00:00.000Z',
          input.rawMetadata ?? JSON.stringify(input.metadata ?? {}),
        ],
      );
    },
    async seedTag(input: SeedTagInput) {
      await database.query(
        `INSERT INTO tags (id, name, slug, type, created_at)
         VALUES ($1, $2, $3, 'hub', '2026-09-01T00:00:00.000Z')`,
        [input.id, input.name ?? input.slug, input.slug],
      );
    },
    async seedTaskTag(taskId: string, tagId: string) {
      await database.query(
        'INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)',
        [taskId, tagId],
      );
    },
    async seedSyncLogEntry(id: string) {
      await database.query(
        `INSERT INTO sync_log (id, connector_id, success, synced_at)
         VALUES ($1, 'connector-a', true, '2026-09-01T00:00:00.000Z')`,
        [id],
      );
    },
    async listTaskIds() {
      const { rows } = await database.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
      return rows.map((row) => row.id);
    },
    async listTaskTagPairs() {
      const { rows } = await database.query<{ taskId: string; tagId: string }>(
        `SELECT task_id AS "taskId", tag_id AS "tagId"
         FROM task_tags ORDER BY task_id, tag_id`,
      );
      return rows;
    },
    async listTags() {
      const { rows } = await database.query<{ id: string; slug: string }>(
        'SELECT id, slug FROM tags ORDER BY slug',
      );
      return rows;
    },
    async listSourceListIds() {
      const { rows } = await database.query<{ id: string }>(
        'SELECT id FROM source_lists ORDER BY id',
      );
      return rows.map((row) => row.id);
    },
    async readSeedMarker() {
      const exists = await database.query<{ present: boolean }>(
        "SELECT to_regclass('public.public_demo_runtime') IS NOT NULL AS present",
      );
      if (!exists.rows[0]?.present) return null;
      const { rows } = await database.query<{ id: string; seededAt: string }>(
        'SELECT id, seeded_at AS "seededAt" FROM public_demo_runtime',
      );
      return rows[0] ?? null;
    },
  };
}

if (connectionString) {
  describeOperationalUtilityPersistenceContract('PostgreSQL', async () => {
    const database = await pool();
    const { createPostgresOperationalUtilityRepository } = await import(
      '@/db/postgres/repositories/operational-utility-repository'
    );
    return createHarness(
      database,
      createPostgresOperationalUtilityRepository(drizzle(database, { schema }), database),
    );
  });
}

describe.skipIf(Boolean(connectionString))('PostgreSQL operational utility integration', () => {
  it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
});
