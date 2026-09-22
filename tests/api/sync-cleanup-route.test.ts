/**
 * POST /api/sync/cleanup and the SQLite side of the operational-utility
 * persistence contract.
 *
 * The shared contract is exercised here (rather than under `tests/db/`) so the
 * route that depends on the maintenance subport and the SQLite adapter that
 * implements it are proven by the same initialized in-memory database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import {
  describeOperationalUtilityPersistenceContract,
  type OperationalUtilityContractHarness,
  type SeedConnectorInput,
  type SeedSourceListInput,
  type SeedTagInput,
  type SeedTaskInput,
} from '../contracts/operational-utility-persistence.contract';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');
vi.unmock('crypto');

let sqlite: Database.Database;
let harness: OperationalUtilityContractHarness;
let cleanup: typeof import('@/app/api/sync/cleanup/route').POST;

const SEED_TABLES = [
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

function metadataText(input: SeedTaskInput): string {
  if (input.rawMetadata !== undefined) return input.rawMetadata;
  return JSON.stringify(input.metadata ?? {});
}

function createHarness(): OperationalUtilityContractHarness {
  return {
    persistence: undefined as never,
    supportsDuplicateSourceRows: true,
    // better-sqlite3 stores metadata as text, so legacy rows can hold
    // syntactically invalid JSON.
    supportsCorruptMetadataText: true,
    async reset() {
      for (const table of SEED_TABLES) sqlite.prepare(`DELETE FROM ${table}`).run();
      sqlite.prepare('DELETE FROM public_demo_runtime').run();
    },
    async seedConnector(input: SeedConnectorInput) {
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, capabilities, credentials, settings,
          synced_lists, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.type,
        input.name,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.capabilities ?? {}),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(input.syncedLists ?? []),
        input.createdAt ?? '2026-09-01T00:00:00.000Z',
        input.createdAt ?? '2026-09-01T00:00:00.000Z',
        input.deletedAt ?? null,
      );
    },
    async seedSourceList(input: SeedSourceListInput) {
      sqlite.prepare(`
        INSERT INTO source_lists (id, connector_instance_id, source_id, name, type)
        VALUES (?, ?, ?, ?, 'repo')
      `).run(input.id, input.connectorInstanceId, input.sourceId, input.name);
    },
    async seedTask(input: SeedTaskInput) {
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          priority, source_list_id, due_date, completed_at, created_at,
          updated_at, last_synced_at, metadata
        ) VALUES (?, ?, 'github-issues', ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sourceId,
        input.connectorInstanceId,
        input.title,
        input.status ?? 'todo',
        input.sourceListId ?? null,
        input.dueDate ?? null,
        input.completedAt ?? null,
        '2026-09-01T00:00:00.000Z',
        input.updatedAt ?? '2026-09-01T00:00:00.000Z',
        input.lastSyncedAt ?? '2026-09-01T00:00:00.000Z',
        metadataText(input),
      );
    },
    async seedTag(input: SeedTagInput) {
      sqlite.prepare(`
        INSERT INTO tags (id, name, slug, type, created_at)
        VALUES (?, ?, ?, 'hub', '2026-09-01T00:00:00.000Z')
      `).run(input.id, input.name ?? input.slug, input.slug);
    },
    async seedTaskTag(taskId: string, tagId: string) {
      sqlite.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(taskId, tagId);
    },
    async seedSyncLogEntry(id: string) {
      sqlite.prepare(`
        INSERT INTO sync_log (id, connector_id, success, synced_at)
        VALUES (?, 'connector-a', 1, '2026-09-01T00:00:00.000Z')
      `).run(id);
    },
    async listTaskIds() {
      return (sqlite.prepare('SELECT id FROM tasks ORDER BY id').all() as Array<{ id: string }>)
        .map((row) => row.id);
    },
    async listTaskTagPairs() {
      return sqlite.prepare(
        'SELECT task_id AS taskId, tag_id AS tagId FROM task_tags ORDER BY task_id, tag_id',
      ).all() as Array<{ taskId: string; tagId: string }>;
    },
    async listTags() {
      return sqlite.prepare('SELECT id, slug FROM tags ORDER BY slug')
        .all() as Array<{ id: string; slug: string }>;
    },
    async listSourceListIds() {
      return (sqlite.prepare('SELECT id FROM source_lists ORDER BY id')
        .all() as Array<{ id: string }>).map((row) => row.id);
    },
    async readSeedMarker() {
      return (sqlite.prepare('SELECT id, seeded_at AS seededAt FROM public_demo_runtime')
        .get() as { id: string; seededAt: string } | undefined) ?? null;
    },
  };
}

beforeAll(async () => {
  const database = await importInitializedSqliteDatabase();
  sqlite = database.sqlite;
  // Both shipped schemas forbid duplicate source rows, so legacy duplicates are
  // reproduced by dropping the guard the cleanup command exists to repair.
  sqlite.exec('DROP INDEX IF EXISTS idx_tasks_source_connector');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS public_demo_runtime (
      id TEXT PRIMARY KEY,
      seeded_at TEXT NOT NULL
    )
  `);

  const [{ createSqliteOperationalUtilityRepository }, { POST }] = await Promise.all([
    import('@/db/persistence/sqlite-operational-utility-repository'),
    import('@/app/api/sync/cleanup/route'),
  ]);
  cleanup = POST;
  harness = createHarness();
  (harness as { persistence: unknown }).persistence =
    createSqliteOperationalUtilityRepository(sqlite, database.default);
}, 60_000);

describeOperationalUtilityPersistenceContract('SQLite', async () => harness);

describe('POST /api/sync/cleanup', () => {
  beforeEach(async () => {
    await harness.reset();
  });

  it('reports exact counts and performs no schema DDL', async () => {
    const indexesBefore = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    ).all();
    await harness.seedTask({
      id: 'dupe-loser',
      sourceId: 'issue-1',
      connectorInstanceId: 'connector-1',
      title: 'Duplicate',
      lastSyncedAt: '2026-09-01T00:00:00.000Z',
    });
    await harness.seedTask({
      id: 'dupe-winner',
      sourceId: 'issue-1',
      connectorInstanceId: 'connector-1',
      title: 'Duplicate',
      lastSyncedAt: '2026-09-05T00:00:00.000Z',
    });
    await harness.seedTask({
      id: 'recurring-old',
      sourceId: 'rec-1',
      connectorInstanceId: 'connector-1',
      title: 'Recurring',
      status: 'done',
      completedAt: '2026-09-01T00:00:00.000Z',
      metadata: { recurrence: { pattern: 'daily' } },
    });
    await harness.seedTask({
      id: 'recurring-new',
      sourceId: 'rec-2',
      connectorInstanceId: 'connector-1',
      title: 'Recurring',
      status: 'done',
      completedAt: '2026-09-06T00:00:00.000Z',
      metadata: { recurrence: { pattern: 'daily' } },
    });

    const response = await cleanup();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      duplicateGroupsFound: 1,
      tasksRemoved: 1,
      recurringInstancesRemoved: 1,
      openRecurringInstancesRemoved: 0,
    });
    expect(await harness.listTaskIds()).toEqual(['dupe-winner', 'recurring-new']);
    expect(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    ).all()).toEqual(indexesBefore);
  });

  it('succeeds with zeroed counts when there is nothing to clean up', async () => {
    const response = await cleanup();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      duplicateGroupsFound: 0,
      tasksRemoved: 0,
    });
  });
});
