import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

async function seedProject(suffix: string) {
  const [{ default: db }, schema] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
  ]);
  const now = new Date().toISOString();
  const projectId = `project-${suffix}`;
  const phaseIds = [`phase-${suffix}-a`, `phase-${suffix}-b`];
  const taskIds = [`task-${suffix}-a`, `task-${suffix}-b`, `task-${suffix}-c`];

  await db.insert(schema.hubProjects).values({
    id: projectId,
    name: `Project ${suffix}`,
    color: '#3b82f6',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectPhases).values([
    {
      id: phaseIds[0],
      projectId,
      name: 'First',
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: phaseIds[1],
      projectId,
      name: 'Second',
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.tasks).values(taskIds.map((id, index) => ({
    id,
    sourceId: `source-${id}`,
    connectorType: index === 0 ? 'github-issues' : 'local',
    connectorInstanceId: index === 0 ? 'github-work' : 'local',
    title: `Task ${index + 1}`,
    status: 'todo',
    priority: 'none',
    metadata: {},
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  })));
  await db.insert(schema.taskProjects).values(
    taskIds.map((taskId) => ({ taskId, projectId })),
  );
  await db.insert(schema.projectPhaseItems).values([
    {
      id: `item-${suffix}-a`,
      phaseId: phaseIds[0],
      taskId: taskIds[0],
      sortOrder: 0,
      estimatedEffortHours: 3,
      createdAt: now,
    },
    {
      id: `item-${suffix}-b`,
      phaseId: phaseIds[0],
      taskId: taskIds[1],
      sortOrder: 1,
      createdAt: now,
    },
    {
      id: `item-${suffix}-c`,
      phaseId: phaseIds[1],
      taskId: taskIds[2],
      sortOrder: 0,
      createdAt: now,
    },
  ]);
  await db.update(schema.hubProjects)
    .set({ hierarchyRevision: 0 })
    .where((await import('drizzle-orm')).eq(schema.hubProjects.id, projectId));

  return { db, schema, projectId, phaseIds, taskIds };
}

describe('project hierarchy service', () => {
  it('moves tasks atomically, normalizes order, audits the command, and restores with its inverse', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('move');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');
    const request = {
      commandId: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 0,
      command: {
        type: 'move_tasks' as const,
        taskIds: [taskIds[0]],
        toPhaseId: phaseIds[1],
        toIndex: 0,
      },
    };

    const moved = applyProjectHierarchyCommand({ projectId, request });

    expect(moved.revision).toBe(1);
    expect(moved.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[1]]);
    expect(moved.hierarchy.phaseItemsByPhase[phaseIds[1]].map((item) => item.taskId))
      .toEqual([taskIds[0], taskIds[2]]);
    expect(moved.hierarchy.phaseItemsByPhase[phaseIds[1]][0]).toMatchObject({
      id: 'item-move-a',
      estimatedEffortHours: 3,
      sortOrder: 0,
    });
    expect(moved.inverseCommand).toEqual({
      type: 'restore_task_positions',
      placements: [{ taskId: taskIds[0], phaseId: phaseIds[0], index: 0 }],
    });

    const [sourceTask] = await db.select().from(schema.tasks)
      .where((await import('drizzle-orm')).eq(schema.tasks.id, taskIds[0]));
    expect(sourceTask.syncStatus).toBe('synced');
    const audit = await db.select().from(schema.projectHierarchyCommands);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      projectId,
      baseRevision: 0,
      resultRevision: 1,
      commandType: 'move_tasks',
    });

    const restored = applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '22222222-2222-4222-8222-222222222222',
        expectedRevision: moved.revision,
        command: moved.inverseCommand,
      },
    });
    expect(restored.revision).toBe(2);
    expect(restored.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[0], taskIds[1]]);
    expect(restored.hierarchy.phaseItemsByPhase[phaseIds[1]].map((item) => item.taskId))
      .toEqual([taskIds[2]]);
  });

  it('reorders a task within its current phase with dense ordering', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('same-phase');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedRevision: 0,
        command: {
          type: 'move_tasks',
          taskIds: [taskIds[0]],
          toPhaseId: phaseIds[0],
          toIndex: 1,
        },
      },
    });

    expect(result.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => ({
      taskId: item.taskId,
      sortOrder: item.sortOrder,
    }))).toEqual([
      { taskId: taskIds[1], sortOrder: 0 },
      { taskId: taskIds[0], sortOrder: 1 },
    ]);

    const { getProjectSubgraph } = await import('@/lib/graph/service');
    const graph = await getProjectSubgraph(projectId);
    expect(graph?.edges
      .filter((edge) => edge.type === 'contains' && edge.source === `phase:${phaseIds[0]}`)
      .map((edge) => edge.target)).toEqual([
      `task:${taskIds[1]}`,
      `task:${taskIds[0]}`,
    ]);
  });

  it('preserves request order for a bulk cross-phase move', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('bulk');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedRevision: 0,
        command: {
          type: 'move_tasks',
          taskIds: [taskIds[1], taskIds[0]],
          toPhaseId: phaseIds[1],
          toIndex: 1,
        },
      },
    });

    expect(result.hierarchy.phaseItemsByPhase[phaseIds[0]]).toEqual([]);
    expect(result.hierarchy.phaseItemsByPhase[phaseIds[1]].map((item) => ({
      taskId: item.taskId,
      sortOrder: item.sortOrder,
    }))).toEqual([
      { taskId: taskIds[2], sortOrder: 0 },
      { taskId: taskIds[1], sortOrder: 1 },
      { taskId: taskIds[0], sortOrder: 2 },
    ]);
  });

  it('projects tied legacy phase-item order deterministically into the graph', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('graph-ties');
    const { and, eq } = await import('drizzle-orm');
    await db.update(schema.projectPhaseItems)
      .set({ sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z' })
      .where(and(
        eq(schema.projectPhaseItems.phaseId, phaseIds[0]),
      ));

    const { getProjectSubgraph } = await import('@/lib/graph/service');
    const graph = await getProjectSubgraph(projectId);
    expect(graph?.edges
      .filter((edge) => edge.type === 'contains' && edge.source === `phase:${phaseIds[0]}`)
      .map((edge) => edge.target)).toEqual([
      `task:${taskIds[0]}`,
      `task:${taskIds[1]}`,
    ]);
  });

  it('returns the original result when the same command ID is retried', async () => {
    const { db, schema, projectId, phaseIds } = await seedProject('retry');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');
    const request = {
      commandId: '33333333-3333-4333-8333-333333333333',
      expectedRevision: 0,
      command: {
        type: 'reorder_phases' as const,
        orderedPhaseIds: [phaseIds[1], phaseIds[0]],
      },
    };

    const first = applyProjectHierarchyCommand({ projectId, request });
    const retry = applyProjectHierarchyCommand({ projectId, request });

    expect(retry).toEqual(first);
    const [project] = await db.select().from(schema.hubProjects)
      .where((await import('drizzle-orm')).eq(schema.hubProjects.id, projectId));
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(project.hierarchyRevision).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it('rejects reusing a command ID for a different request', async () => {
    const { projectId, phaseIds } = await seedProject('command-conflict');
    const {
      applyProjectHierarchyCommand,
      ProjectHierarchyServiceError,
    } = await import('@/lib/projects/hierarchy-service');
    const commandId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId,
        expectedRevision: 0,
        command: {
          type: 'reorder_phases',
          orderedPhaseIds: [phaseIds[1], phaseIds[0]],
        },
      },
    });

    expect(() => applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId,
        expectedRevision: 1,
        command: {
          type: 'reorder_phases',
          orderedPhaseIds: [phaseIds[0], phaseIds[1]],
        },
      },
    })).toThrowError(ProjectHierarchyServiceError);
    try {
      applyProjectHierarchyCommand({
        projectId,
        request: {
          commandId,
          expectedRevision: 1,
          command: {
            type: 'reorder_phases',
            orderedPhaseIds: [phaseIds[0], phaseIds[1]],
          },
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: 'COMMAND_ID_CONFLICT',
      });
    }
  });

  it('rejects stale revisions with the current authoritative snapshot', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('stale');
    const {
      applyProjectHierarchyCommand,
      ProjectHierarchyServiceError,
    } = await import('@/lib/projects/hierarchy-service');
    applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '44444444-4444-4444-8444-444444444444',
        expectedRevision: 0,
        command: {
          type: 'reorder_phases',
          orderedPhaseIds: [phaseIds[1], phaseIds[0]],
        },
      },
    });

    expect(() => applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '55555555-5555-4555-8555-555555555555',
        expectedRevision: 0,
        command: {
          type: 'move_tasks',
          taskIds: [taskIds[0]],
          toPhaseId: phaseIds[1],
          toIndex: 0,
        },
      },
    })).toThrowError(ProjectHierarchyServiceError);
    try {
      applyProjectHierarchyCommand({
        projectId,
        request: {
          commandId: '66666666-6666-4666-8666-666666666666',
          expectedRevision: 0,
          command: {
            type: 'move_tasks',
            taskIds: [taskIds[0]],
            toPhaseId: phaseIds[1],
            toIndex: 0,
          },
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: 'HIERARCHY_REVISION_CONFLICT',
        current: expect.objectContaining({ revision: 1 }),
      });
    }
  });

  it('rolls back the whole command when any task is outside the project', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('rollback');
    const {
      applyProjectHierarchyCommand,
      getProjectHierarchySnapshot,
    } = await import('@/lib/projects/hierarchy-service');

    expect(() => applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '77777777-7777-4777-8777-777777777777',
        expectedRevision: 0,
        command: {
          type: 'move_tasks',
          taskIds: [taskIds[0], 'not-in-project'],
          toPhaseId: phaseIds[1],
          toIndex: 0,
        },
      },
    })).toThrow('Every task must belong to this project');

    const hierarchy = getProjectHierarchySnapshot(projectId)!;
    expect(hierarchy.revision).toBe(0);
    expect(hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[0], taskIds[1]]);
    expect(hierarchy.phaseItemsByPhase[phaseIds[1]].map((item) => item.taskId))
      .toEqual([taskIds[2]]);
  });

  it('enforces one phase per task per project at the database boundary', async () => {
    const { db, schema, phaseIds, taskIds } = await seedProject('constraint');

    await expect(db.insert(schema.projectPhaseItems).values({
      id: 'duplicate-project-phase-item',
      phaseId: phaseIds[1],
      taskId: taskIds[0],
      sortOrder: 1,
      createdAt: new Date().toISOString(),
    })).rejects.toThrow('task already belongs to another phase in this project');
  });

  it('requires project membership for phase assignment and cleans placement on removal', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('membership');
    const now = new Date().toISOString();
    await db.insert(schema.tasks).values({
      id: 'membership-outsider',
      sourceId: 'source-membership-outsider',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Outsider',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });

    await expect(db.insert(schema.projectPhaseItems).values({
      id: 'membership-outsider-item',
      phaseId: phaseIds[0],
      taskId: 'membership-outsider',
      sortOrder: 2,
      createdAt: now,
    })).rejects.toThrow('task must belong to the phase project');

    const { and, eq } = await import('drizzle-orm');
    await db.delete(schema.taskProjects).where(and(
      eq(schema.taskProjects.projectId, projectId),
      eq(schema.taskProjects.taskId, taskIds[0]),
    ));
    const remaining = await db.select().from(schema.projectPhaseItems)
      .where(eq(schema.projectPhaseItems.taskId, taskIds[0]));
    expect(remaining).toEqual([]);
  });

  it('advances the revision for legacy hierarchy writers', async () => {
    const { db, schema, projectId } = await seedProject('legacy-revision');
    const now = new Date().toISOString();

    await db.insert(schema.projectPhases).values({
      id: 'legacy-added-phase',
      projectId,
      name: 'Legacy phase',
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });

    const [project] = await db.select().from(schema.hubProjects)
      .where((await import('drizzle-orm')).eq(schema.hubProjects.id, projectId));
    expect(project.hierarchyRevision).toBe(1);
  });

  it('rejects reparenting a phase when its tasks already occupy the target project', async () => {
    const first = await seedProject('reparent-source');
    const second = await seedProject('reparent-target');
    const now = new Date().toISOString();
    await first.db.insert(first.schema.taskProjects).values(
      first.taskIds.slice(0, 2).map((taskId) => ({
        taskId,
        projectId: second.projectId,
      })),
    );
    await first.db.insert(first.schema.projectPhaseItems).values({
      id: 'reparent-target-item',
      phaseId: second.phaseIds[0],
      taskId: first.taskIds[0],
      sortOrder: 1,
      createdAt: now,
    });

    await expect(first.db.update(first.schema.projectPhases)
      .set({ projectId: second.projectId })
      .where((await import('drizzle-orm')).eq(first.schema.projectPhases.id, first.phaseIds[0])))
      .rejects.toThrow('phase tasks already belong to another phase in the target project');
  });
});
