import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { GitHubParentMetadata } from '@/lib/connectors/github-issues/issue-transformer';

type DbModule = typeof import('@/db');
type SchemaModule = typeof import('@/db/schema');
type HierarchyModule = typeof import('@/lib/sync/github-hierarchy-reconciliation');

const dbPath = join(tmpdir(), `mc-github-hierarchy-${process.pid}.db`);
const connectorId = 'github-hierarchy';
const now = '2026-08-09T00:00:00.000Z';
const baselineSourceIds = [
  'acme/app:1',
  'other/repo:2',
  'acme/app:10',
  'acme/app:11',
  'acme/app:12',
  'acme/app:13',
];
let dbModule: DbModule;
let schema: SchemaModule;
let hierarchy: HierarchyModule;

function parent(
  repository: string,
  issueNumber: number,
): GitHubParentMetadata {
  return {
    sourceId: `${repository}:${issueNumber}`,
    repository,
    issueNumber,
    nodeId: `I_${repository}_${issueNumber}`,
    title: `${repository} issue ${issueNumber}`,
    url: `https://github.com/${repository}/issues/${issueNumber}`,
  };
}

function metadata(row: { metadata: unknown }): Record<string, unknown> {
  return typeof row.metadata === 'string'
    ? JSON.parse(row.metadata) as Record<string, unknown>
    : row.metadata as Record<string, unknown>;
}

function completeGeneration(
  observations: ReadonlyMap<string, GitHubParentMetadata | null>,
  additionalSourceIds: readonly string[] = [],
): Map<string, GitHubParentMetadata | null> {
  const complete = new Map<string, GitHubParentMetadata | null>(
    [...baselineSourceIds, ...additionalSourceIds].map((sourceId) => [sourceId, null]),
  );
  for (const [sourceId, observation] of observations) complete.set(sourceId, observation);
  return complete;
}

async function insertTask(id: string, sourceId: string, parentId?: string) {
  const issueNumber = Number(sourceId.slice(sourceId.lastIndexOf(':') + 1));
  await dbModule.default.insert(schema.tasks).values({
    id,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: sourceId,
    createdAt: now,
    updatedAt: now,
    parentId,
    depth: parentId ? 1 : 0,
    metadata: { issueNumber },
    lastSyncedAt: now,
  });
}

beforeAll(async () => {
  if (existsSync(dbPath)) rmSync(dbPath);
  process.env.MC_DB_PATH = dbPath;
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
  [dbModule, schema, hierarchy] = await Promise.all([
    importInitializedSqliteDatabase(),
    import('@/db/schema'),
    import('@/lib/sync/github-hierarchy-reconciliation'),
  ]);

  await insertTask('parent-a', 'acme/app:1');
  await insertTask('parent-b', 'other/repo:2');
  await insertTask('child-same', 'acme/app:10');
  await insertTask('child-cross', 'acme/app:11');
  await insertTask('child-external', 'acme/app:12');
  await insertTask('grandchild', 'acme/app:13', 'child-same');
  await dbModule.default.update(schema.tasks).set({ depth: 2 })
    .where((await import('drizzle-orm')).eq(schema.tasks.id, 'grandchild'));
});

afterAll(() => {
  dbModule.sqlite.close();
  delete process.env.MC_DB_PATH;
  if (existsSync(dbPath)) rmSync(dbPath);
});

describe('GitHub hierarchy reconciliation', () => {
  it('applies same-repo and cross-repo parents while preserving external-only metadata', async () => {
    const result = await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([
        ['acme/app:10', parent('acme/app', 1)],
        ['acme/app:11', parent('other/repo', 2)],
        ['acme/app:12', parent('private/repo', 99)],
      ])),
      new Set(['acme/app', 'other/repo']),
      true,
    );
    const rows = await dbModule.default.select().from(schema.tasks);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(result).toEqual({ applied: true, updated: 6 });
    expect(byId.get('child-same')).toMatchObject({ parentId: 'parent-a', depth: 1 });
    expect(byId.get('child-cross')).toMatchObject({ parentId: 'parent-b', depth: 1 });
    expect(byId.get('child-external')?.parentId).toBeNull();
    expect(metadata(byId.get('child-external')!)).toMatchObject({
      githubParent: {
        sourceId: 'private/repo:99',
        repository: 'private/repo',
      },
    });
    expect(rows).toHaveLength(6);
  });

  it('converges moves and removals and replays without duplicates', async () => {
    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:10', parent('other/repo', 2)]])),
      new Set(['acme/app', 'other/repo']),
      true,
    );
    let [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'child-same'));
    expect(child).toMatchObject({ parentId: 'parent-b', depth: 1 });

    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:10', null]])),
      new Set(['acme/app', 'other/repo']),
      true,
    );
    [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'child-same'));
    expect(child).toMatchObject({ parentId: null, depth: 0 });
    expect(metadata(child)).toMatchObject({ githubParent: null });
    const [grandchild] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'grandchild'));
    expect(grandchild).toMatchObject({ parentId: null, depth: 0 });

    const replay = await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:10', null]])),
      new Set(['acme/app', 'other/repo']),
      true,
    );
    expect(replay).toEqual({ applied: true, updated: 0 });
    expect(await dbModule.default.select().from(schema.tasks)).toHaveLength(6);
  });

  it('refuses every hierarchy change until the generation is complete', async () => {
    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:11', parent('other/repo', 2)]])),
      new Set(['acme/app', 'other/repo']),
      true,
    );
    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:11', null]])),
      new Set(['acme/app', 'other/repo']),
      false,
    );
    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'child-cross'));

    expect(child).toMatchObject({ parentId: 'parent-b', depth: 1 });
  });

  it('resolves canonical parent names through configured repository aliases', async () => {
    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(new Map([['acme/app:12', parent('renamed/repository', 2)]])),
      new Set(['acme/app', 'other/repo']),
      true,
      new Map([['other/repo', 'renamed/repository']]),
    );
    const [child] = await dbModule.default.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'child-external'));

    expect(child).toMatchObject({ parentId: 'parent-b', depth: 1 });
    expect(metadata(child)).toMatchObject({
      githubParent: { sourceId: 'renamed/repository:2' },
    });
  });

  it('never restores a reference to a parent deleted before reconciliation', async () => {
    const { eq } = await import('drizzle-orm');
    await insertTask('deleted-parent', 'acme/app:20');
    await insertTask('orphaned-child', 'acme/app:21', 'deleted-parent');
    await dbModule.default.delete(schema.tasks).where(eq(schema.tasks.id, 'deleted-parent'));

    await hierarchy.reconcileGitHubTaskHierarchy(
      connectorId,
      completeGeneration(
        new Map([['acme/app:21', parent('acme/app', 20)]]),
        ['acme/app:21'],
      ),
      new Set(['acme/app']),
      true,
    );
    const [child] = await dbModule.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'orphaned-child'));

    expect(child).toMatchObject({ parentId: null, depth: 0 });
    expect(metadata(child)).toMatchObject({
      githubParent: { sourceId: 'acme/app:20' },
    });
  });
});
