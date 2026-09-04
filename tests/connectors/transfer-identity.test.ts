import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('@/db');
vi.unmock('@/db/schema');
vi.unmock('drizzle-orm');

describe('task transfer identity persistence', () => {
  beforeAll(() => {
    vi.resetModules();
  });

  it('atomically refreshes a task and binds both repositories without a full sync', async () => {
    const [
      { default: db },
      schema,
      { reconcileTransferIdentity },
      { canTransferGitHubIssueSafely },
    ] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
      import('@/lib/connectors/github-issues/repoint-service'),
    ]);
    const now = '2026-08-09T20:00:00.000Z';
    await insertConnector(db, schema, 'github-targeted', now);
    await db.insert(schema.sourceLists).values([
      {
        id: 'source-list',
        connectorInstanceId: 'github-targeted',
        sourceId: 'acme/source',
        name: 'acme/source',
        type: 'repo',
      },
      {
        id: 'target-list',
        connectorInstanceId: 'github-targeted',
        sourceId: 'acme/target',
        name: 'acme/target',
        type: 'repo',
      },
    ]);
    await db.insert(schema.tasks).values({
      id: 'fresh-issue',
      sourceId: 'acme/source:7',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-targeted',
      title: 'Fresh issue',
      sourceListId: 'acme/source',
      sourceListName: 'acme/source',
      metadata: { preserved: true },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });

    const sourceRepository = repositoryEvidence('R_source', 'acme', 'source', now);
    const targetRepository = repositoryEvidence('R_target', 'acme', 'target', now);
    await reconcileTransferIdentity('fresh-issue', 'github-targeted', {
      task: transferTask({
        connectorInstanceId: 'github-targeted',
        sourceId: 'acme/source:7',
        sourceListId: 'acme/source',
        sourceListName: 'acme/source',
        title: 'Fresh issue, refreshed',
        metadata: { refreshed: true },
        externalIdentity: issueEvidence(
          'I_fresh',
          'acme',
          'source',
          7,
          now,
          sourceRepository,
        ),
        now,
      }),
      sourceLists: [
        { sourceId: 'acme/source', evidence: { entity: sourceRepository } },
        { sourceId: 'acme/target', evidence: { entity: targetRepository } },
      ],
    });

    expect(await canTransferGitHubIssueSafely(
      'github-targeted',
      'acme/source:7',
      'acme/target',
    )).toBe(true);
    const [task] = await db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, 'fresh-issue'));
    expect(task).toMatchObject({
      title: 'Fresh issue, refreshed',
      sourceId: 'acme/source:7',
    });
    expect(task.metadata).toEqual({
      preserved: true,
      refreshed: true,
    });
  });

  it('reconciles task-only refreshes when external identity evidence is absent', async () => {
    const [{ default: db }, schema, { reconcileTransferIdentity }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
    ]);
    const { eq } = await import('drizzle-orm');
    const now = '2026-08-10T20:00:00.000Z';
    await insertConnector(db, schema, 'github-task-only', now);
    await db.insert(schema.tasks).values({
      id: 'task-only',
      sourceId: 'acme/original:2',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-task-only',
      title: 'Before',
      metadata: { preserved: true },
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    const identitiesBefore = await db.select().from(schema.externalEntities);

    await reconcileTransferIdentity('task-only', 'github-task-only', {
      task: transferTask({
        connectorInstanceId: 'github-task-only',
        sourceId: 'acme/renamed:2',
        title: 'After',
        metadata: { refreshed: true },
        now,
      }),
      sourceLists: [],
    });

    const [task] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'task-only'));
    expect(task).toMatchObject({
      title: 'After',
      sourceId: 'acme/renamed:2',
    });
    expect(task.metadata).toEqual({
      preserved: true,
      refreshed: true,
    });
    expect(await db.select().from(schema.externalEntities)).toHaveLength(
      identitiesBefore.length,
    );
  });

  it('rolls back source-list, identity, and task effects after a late task failure', async () => {
    const [{ default: db }, schema, { reconcileTransferIdentity }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
    ]);
    const { eq } = await import('drizzle-orm');
    const now = '2026-08-11T20:00:00.000Z';
    await insertConnector(db, schema, 'github-rollback', now);
    await db.insert(schema.sourceLists).values({
      id: 'rollback-list',
      connectorInstanceId: 'github-rollback',
      sourceId: 'acme/rollback',
      name: 'acme/rollback',
      type: 'repo',
    });
    await db.insert(schema.tasks).values({
      id: 'rollback-task',
      sourceId: 'acme/original:9',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-rollback',
      title: 'Before rollback',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: 'rollback-source-conflict',
      sourceId: 'acme/rollback:9',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-rollback',
      title: 'Conflicting task',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    const repository = repositoryEvidence('R_rollback', 'acme', 'rollback', now);

    await expect(reconcileTransferIdentity(
      'rollback-task',
      'github-rollback',
      {
        task: transferTask({
          connectorInstanceId: 'github-rollback',
          sourceId: 'acme/rollback:9',
          sourceListId: 'acme/rollback',
          sourceListName: 'acme/rollback',
          title: 'Must roll back',
          externalIdentity: issueEvidence(
            'I_rollback',
            'acme',
            'rollback',
            9,
            now,
            repository,
          ),
          now,
        }),
        sourceLists: [{
          sourceId: 'acme/rollback',
          evidence: { entity: repository },
        }],
      },
    )).rejects.toThrow();

    const [task] = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'rollback-task'));
    expect(task).toMatchObject({
      title: 'Before rollback',
      sourceId: 'acme/original:9',
    });
    const rolledBackEntities = await db.select().from(schema.externalEntities)
      .where((await import('drizzle-orm')).inArray(
        schema.externalEntities.stableId,
        ['I_rollback', 'R_rollback'],
      ));
    const rolledBackBindings = await db.select().from(schema.externalEntityBindings)
      .where((await import('drizzle-orm')).inArray(
        schema.externalEntityBindings.localId,
        ['rollback-task', 'rollback-list'],
      ));
    expect(rolledBackEntities).toEqual([]);
    expect(rolledBackBindings).toEqual([]);
  });

  it('rejects an oversized batch without partial effects', async () => {
    const [{ default: db }, schema, { reconcileTransferIdentity }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
    ]);
    const now = '2026-08-12T20:00:00.000Z';
    const connectorInstanceId = 'oversized-batch-connector';
    await insertConnector(db, schema, connectorInstanceId, now);
    await db.insert(schema.tasks).values({
      id: 'oversized-task',
      sourceId: 'acme/repo-0:1',
      connectorType: 'github-issues',
      connectorInstanceId,
      title: 'Oversized batch task',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    const entityCountBefore = (await db.select().from(schema.externalEntities)).length;
    const bindingCountBefore = (await db.select().from(schema.externalEntityBindings)).length;
    const sourceListRows: (typeof schema.sourceLists.$inferInsert)[] = [];
    const refreshSourceLists: {
      sourceId: string;
      evidence: { entity: ReturnType<typeof repositoryEvidence> };
    }[] = [];
    for (let index = 0; index < 500; index += 1) {
      const sourceId = `acme/repo-${index}`;
      sourceListRows.push({
        id: `oversized-list-${index}`,
        connectorInstanceId,
        sourceId,
        name: sourceId,
        type: 'repo',
      });
      refreshSourceLists.push({
        sourceId,
        evidence: {
          entity: repositoryEvidence(`R_oversized_${index}`, 'acme', `repo-${index}`, now),
        },
      });
    }
    await db.insert(schema.sourceLists).values(sourceListRows);

    await expect(reconcileTransferIdentity('oversized-task', connectorInstanceId, {
      task: transferTask({
        connectorInstanceId,
        sourceId: 'acme/repo-0:1',
        title: 'Oversized batch task',
        externalIdentity: issueEvidence('I_oversized', 'acme', 'repo-0', 1, now),
        now,
      }),
      sourceLists: refreshSourceLists,
    })).rejects.toThrow('External identity batch exceeds the maximum of 500');

    expect(await db.select().from(schema.externalEntities)).toHaveLength(entityCountBefore);
    expect(await db.select().from(schema.externalEntityBindings)).toHaveLength(bindingCountBefore);
  });

  it('returns a promise and the tasks route awaits the new identity write', async () => {
    const [{ default: db }, schema, { persistCreatedTaskIdentity }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
    ]);
    const now = '2026-08-13T20:00:00.000Z';
    await insertConnector(db, schema, 'github-create-async', now);
    await db.insert(schema.sourceLists).values({
      id: 'create-async-list',
      connectorInstanceId: 'github-create-async',
      sourceId: 'acme/async',
      name: 'acme/async',
      type: 'repo',
    });
    await db.insert(schema.tasks).values({
      id: 'create-async-task',
      sourceId: 'acme/async:5',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-create-async',
      title: 'Created async',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    const repository = repositoryEvidence('R_create_async', 'acme', 'async', now);

    const pending = persistCreatedTaskIdentity({
      taskId: 'create-async-task',
      connectorInstanceId: 'github-create-async',
      sourceId: 'acme/async:5',
      sourceListId: 'acme/async',
      evidence: issueEvidence('I_create_async', 'acme', 'async', 5, now, repository),
    });
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    const routeSource = readFileSync(
      resolve(process.cwd(), 'src/app/api/tasks/route.ts'),
      'utf8',
    );
    expect(routeSource).toMatch(/await persistCreatedTaskIdentity\(\{/);
  });
});

function transferTask(input: {
  connectorInstanceId: string;
  sourceId: string;
  title: string;
  metadata?: Record<string, unknown>;
  sourceListId?: string;
  sourceListName?: string;
  externalIdentity?: ReturnType<typeof issueEvidence>;
  now: string;
}) {
  return {
    id: 'remote-placeholder',
    sourceId: input.sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    status: 'todo' as const,
    priority: 'none' as const,
    createdAt: input.now,
    updatedAt: input.now,
    childIds: [],
    depth: 0,
    isChecklistItem: false,
    sourceListId: input.sourceListId,
    sourceListName: input.sourceListName,
    hubProjectIds: [],
    tags: [],
    metadata: input.metadata ?? {},
    externalIdentity: input.externalIdentity,
    syncStatus: 'synced' as const,
    lastSyncedAt: input.now,
  };
}

function issueEvidence(
  stableId: string,
  owner: string,
  repository: string,
  issueNumber: number,
  observedAt: string,
  repositoryIdentity?: ReturnType<typeof repositoryEvidence>,
) {
  return {
    entity: {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'issue' as const,
        stableId,
      },
      locator: {
        owner,
        repository,
        issueNumber,
        apiUrl: `https://api.github.com/repos/${owner}/${repository}/issues/${issueNumber}`,
        webUrl: `https://github.com/${owner}/${repository}/issues/${issueNumber}`,
      },
      observationSource: 'rest' as const,
      observedAt,
    },
    ...(repositoryIdentity ? { repository: repositoryIdentity } : {}),
  };
}

function repositoryEvidence(
  stableId: string,
  owner: string,
  repository: string,
  observedAt: string,
) {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository' as const,
      stableId,
    },
    locator: {
      owner,
      repository,
      apiUrl: `https://api.github.com/repos/${owner}/${repository}`,
      webUrl: `https://github.com/${owner}/${repository}`,
    },
    observationSource: 'rest' as const,
    observedAt,
  };
}

async function insertConnector(
  database: typeof import('@/db').default,
  schema: typeof import('@/db/schema'),
  connectorInstanceId: string,
  now: string,
): Promise<void> {
  await database.insert(schema.connectorConfigs).values({
    id: connectorInstanceId,
    type: 'github-issues',
    name: connectorInstanceId,
    enabled: true,
    syncMode: 'poll',
    capabilities: { read: true, write: true, taskCreate: true },
    credentials: { token: 'test' },
    settings: {},
    syncedLists: [],
    createdAt: now,
    updatedAt: now,
  });
}
