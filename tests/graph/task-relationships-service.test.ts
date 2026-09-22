import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('global task relationship service', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('validates, lists, searches, and deletes global relationships', async () => {
    const [{ default: db }, schema, service, { eq }] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/graph/service'),
      import('drizzle-orm'),
    ]);
    const { hubProjects, taskDependencies, taskProjects, tasks } = schema;
    const now = '2026-07-31T12:00:00.000Z';
    await db.insert(hubProjects).values([
      { id: 'project-a', name: 'Alpha', createdAt: now, updatedAt: now },
      { id: 'project-b', name: 'Beta', createdAt: now, updatedAt: now },
    ]);
    await db.insert(tasks).values(Array.from({ length: 6 }, (_, index) => ({
      id: `task-${index + 1}`,
      sourceId: `local:${index + 1}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: `Task ${index + 1}`,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    })));
    await db.insert(taskProjects).values([
      { taskId: 'task-1', projectId: 'project-a' },
      { taskId: 'task-2', projectId: 'project-b' },
      { taskId: 'task-3', projectId: 'project-b' },
      { taskId: 'task-4', projectId: 'project-a' },
      { taskId: 'task-4', projectId: 'project-b' },
    ]);

    const crossProject = await service.createGlobalTaskDependency({
      sourceTaskId: 'task-1',
      targetTaskId: 'task-2',
      type: 'blocks',
    });
    await service.createGlobalTaskDependency({
      sourceTaskId: 'task-2',
      targetTaskId: 'task-3',
      type: 'blocks',
    });
    const related = await service.createGlobalTaskDependency({
      sourceTaskId: 'task-4',
      targetTaskId: 'task-1',
      type: 'related',
    });

    const taskOneRelationships = await service.getTaskRelationships('task-1');
    expect(taskOneRelationships?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        edge: expect.objectContaining({
          id: `dependency:${crossProject.id}`,
          type: 'blocks',
          provenance: 'explicit',
        }),
        direction: 'outgoing',
        task: expect.objectContaining({ id: 'task-2', projectNames: ['Beta'] }),
      }),
      expect.objectContaining({
        edge: expect.objectContaining({
          id: `dependency:${related.id}`,
          type: 'related',
          provenance: 'explicit',
        }),
        direction: 'related',
        task: expect.objectContaining({
          id: 'task-4',
          projectNames: expect.arrayContaining(['Alpha', 'Beta']),
        }),
      }),
    ]));
    expect((await service.getTaskRelationships('task-2'))?.relationships).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        edge: expect.objectContaining({ id: `dependency:${crossProject.id}` }),
        direction: 'incoming',
        task: expect.objectContaining({ id: 'task-1' }),
      }),
    ]));

    await expect(service.createGlobalTaskDependency({
      sourceTaskId: 'task-1',
      targetTaskId: 'task-1',
      type: 'blocks',
    })).rejects.toEqual(new service.GraphServiceError('A task cannot depend on itself', 400));
    await expect(service.createGlobalTaskDependency({
      sourceTaskId: 'missing',
      targetTaskId: 'task-1',
      type: 'blocks',
    })).rejects.toEqual(new service.GraphServiceError('Both tasks must exist', 404));
    await expect(service.createGlobalTaskDependency({
      sourceTaskId: 'task-1',
      targetTaskId: 'task-4',
      type: 'related',
    })).rejects.toEqual(new service.GraphServiceError('This dependency already exists', 409));
    await expect(service.createGlobalTaskDependency({
      sourceTaskId: 'task-3',
      targetTaskId: 'task-1',
      type: 'blocks',
    })).rejects.toEqual(new service.GraphServiceError('This dependency would create a cycle', 409));

    const candidates = await service.searchTaskRelationshipCandidates('task-1', 'Task', 2);
    expect(candidates).toHaveLength(2);
    expect(candidates?.every((candidate) => candidate.id !== 'task-1')).toBe(true);

    const concurrent = await Promise.allSettled([
      service.createGlobalTaskDependency({
        sourceTaskId: 'task-5',
        targetTaskId: 'task-6',
        type: 'related',
      }),
      service.createGlobalTaskDependency({
        sourceTaskId: 'task-6',
        targetTaskId: 'task-5',
        type: 'related',
      }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);

    await expect(service.deleteGlobalTaskDependency({
      taskId: 'task-3',
      dependencyId: crossProject.id,
    })).rejects.toEqual(
      new service.GraphServiceError('Dependency not found for this task', 404),
    );
    await service.deleteGlobalTaskDependency({
      taskId: 'task-1',
      dependencyId: `dependency:${crossProject.id}`,
    });
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.id, crossProject.id)))
      .toHaveLength(0);
  });
});
