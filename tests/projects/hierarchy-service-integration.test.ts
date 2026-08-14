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

    const moved = await applyProjectHierarchyCommand({ projectId, request });

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
      placements: [{
        taskId: taskIds[0],
        phaseId: phaseIds[0],
        index: 0,
        item: {
          id: 'item-move-a',
          estimatedEffortHours: 3,
          isProposed: false,
          proposalType: null,
          createdAt: expect.any(String),
        },
      }],
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

    const restored = await applyProjectHierarchyCommand({
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

    const result = await applyProjectHierarchyCommand({
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

  it('preserves already-placed tasks in a mixed placement batch', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('preserve-mixed');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '12121212-1212-4212-8212-121212121212',
        expectedRevision: 0,
        command: {
          type: 'move_tasks',
          taskIds: [taskIds[1], taskIds[2]],
          toPhaseId: phaseIds[0],
          toIndex: 0,
          preserveExistingPosition: true,
        },
      },
    });

    expect(result.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[2], taskIds[0], taskIds[1]]);
  });

  it('preserves request order for a bulk cross-phase move', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('bulk');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = await applyProjectHierarchyCommand({
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

    const first = await applyProjectHierarchyCommand({ projectId, request });
    const retry = await applyProjectHierarchyCommand({ projectId, request });

    expect(retry).toEqual(first);
    const [project] = await db.select().from(schema.hubProjects)
      .where((await import('drizzle-orm')).eq(schema.hubProjects.id, projectId));
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(project.hierarchyRevision).toBe(1);
    expect(audits).toHaveLength(1);
  });

  it('keeps a no-op command retry idempotent after the hierarchy advances', async () => {
    const { db, schema, projectId, phaseIds } = await seedProject('noop-retry');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');
    const noOpRequest = {
      commandId: '34343434-3434-4434-8434-343434343434',
      expectedRevision: 0,
      command: {
        type: 'reorder_phases' as const,
        orderedPhaseIds: phaseIds,
      },
    };

    const noOp = await applyProjectHierarchyCommand({ projectId, request: noOpRequest });
    const changed = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: '35353535-3535-4535-8535-353535353535',
        expectedRevision: 0,
        command: {
          type: 'reorder_phases',
          orderedPhaseIds: [phaseIds[1], phaseIds[0]],
        },
      },
    });
    const retry = await applyProjectHierarchyCommand({ projectId, request: noOpRequest });

    expect(noOp.revision).toBe(0);
    expect(changed.revision).toBe(1);
    expect(retry).toEqual(noOp);
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(audits.map((audit) => [audit.baseRevision, audit.resultRevision])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });

  it('converges concurrent identical command retries on one revision and audit row', async () => {
    const { db, schema, projectId, phaseIds } = await seedProject('concurrent-retry');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');
    const request = {
      commandId: 'abababab-abab-4bab-8bab-abababababab',
      expectedRevision: 0,
      command: {
        type: 'reorder_phases' as const,
        orderedPhaseIds: [phaseIds[1], phaseIds[0]],
      },
    };

    const [first, second] = await Promise.all([
      applyProjectHierarchyCommand({ projectId, request }),
      applyProjectHierarchyCommand({ projectId, request }),
    ]);

    expect(second).toEqual(first);
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

    await applyProjectHierarchyCommand({
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

    await expect(applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId,
        expectedRevision: 1,
        command: {
          type: 'reorder_phases',
          orderedPhaseIds: [phaseIds[0], phaseIds[1]],
        },
      },
    })).rejects.toThrowError(ProjectHierarchyServiceError);
    try {
      await applyProjectHierarchyCommand({
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
    await applyProjectHierarchyCommand({
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

    await expect(applyProjectHierarchyCommand({
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
    })).rejects.toThrowError(ProjectHierarchyServiceError);
    try {
      await applyProjectHierarchyCommand({
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
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('rollback');
    const {
      applyProjectHierarchyCommand,
      getProjectHierarchySnapshot,
    } = await import('@/lib/projects/hierarchy-service');
    const now = new Date().toISOString();
    await db.insert(schema.tasks).values({
      id: 'not-in-project',
      sourceId: 'local:not-in-project',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Not in project',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });

    await expect(applyProjectHierarchyCommand({
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
    })).rejects.toThrow('Every task must belong to this project');

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

  it('assigns project membership and placement atomically and restores both with its inverse', async () => {
    const { db, schema, projectId, phaseIds } = await seedProject('membership-command');
    const now = new Date().toISOString();
    const taskId = 'membership-command-new-task';
    await db.insert(schema.tasks).values({
      id: taskId,
      sourceId: `local:${taskId}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'New task',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const assigned = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expectedRevision: 0,
        command: {
          type: 'assign_tasks',
          taskIds: [taskId],
          toPhaseId: phaseIds[1],
          toIndex: 1,
          newItem: {
            estimatedEffortHours: 8,
            isProposed: true,
            proposalType: 'new_task',
          },
        },
      },
    });

    expect(assigned.revision).toBe(1);
    expect(assigned.hierarchy.phaseItemsByPhase[phaseIds[1]][1]).toMatchObject({
      id: expect.any(String),
      taskId,
      sortOrder: 1,
      estimatedEffortHours: 8,
      isProposed: true,
      proposalType: 'new_task',
      createdAt: expect.any(String),
    });
    expect(assigned.inverseCommand).toEqual({
      type: 'restore_project_tasks',
      states: [{
        taskId,
        member: false,
        excludedAt: null,
        placement: null,
      }],
    });

    const restored = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        expectedRevision: assigned.revision,
        command: assigned.inverseCommand,
      },
    });
    expect(restored.revision).toBe(2);
    expect(restored.hierarchy.phaseItemsByPhase[phaseIds[1]].some((item) => item.taskId === taskId))
      .toBe(false);
    const memberships = await db.select().from(schema.taskProjects)
      .where((await import('drizzle-orm')).eq(schema.taskProjects.taskId, taskId));
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(memberships).toEqual([]);
    expect(audits).toHaveLength(2);
  });

  it('does not advance the revision when an oversized assignment index clamps to current state', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('clamped-assignment');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'dededede-dede-4ede-8ede-dededededede',
        expectedRevision: 0,
        command: {
          type: 'assign_tasks',
          taskIds: [taskIds[1]],
          toPhaseId: phaseIds[0],
          toIndex: 100,
        },
      },
    });

    expect(result.revision).toBe(0);
    expect(result.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[0], taskIds[1]]);
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ baseRevision: 0, resultRevision: 0 });
  });

  it('recomputes retained placements after removing another task in the same command', async () => {
    const { projectId, phaseIds, taskIds } = await seedProject('mixed-restore');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const result = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'efefefef-efef-4fef-8fef-efefefefefef',
        expectedRevision: 0,
        command: {
          type: 'restore_project_tasks',
          states: [
            {
              taskId: taskIds[0],
              member: false,
              excludedAt: null,
              placement: null,
            },
            {
              taskId: taskIds[1],
              member: true,
              excludedAt: null,
              placement: {
                taskId: taskIds[1],
                phaseId: phaseIds[0],
                index: 1,
                item: {
                  id: 'item-mixed-restore-b',
                  estimatedEffortHours: 5,
                  isProposed: false,
                  proposalType: null,
                  createdAt: '2026-01-01T00:00:00.000Z',
                },
              },
            },
          ],
        },
      },
    });

    expect(result.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => ({
      taskId: item.taskId,
      sortOrder: item.sortOrder,
    }))).toEqual([{ taskId: taskIds[1], sortOrder: 0 }]);
  });

  it('restores removed membership, placement metadata, and exclusion state with its inverse', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedProject('remove-command');
    const { applyProjectHierarchyCommand } = await import('@/lib/projects/hierarchy-service');

    const removed = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
        expectedRevision: 0,
        command: {
          type: 'remove_tasks',
          taskIds: [taskIds[0]],
        },
      },
    });
    expect(removed.revision).toBe(1);
    expect(removed.hierarchy.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds[1]]);
    expect(removed.inverseCommand).toMatchObject({
      type: 'restore_project_tasks',
      states: [{
        taskId: taskIds[0],
        member: true,
        excludedAt: null,
        placement: {
          phaseId: phaseIds[0],
          index: 0,
          item: {
            id: 'item-remove-command-a',
            estimatedEffortHours: 3,
          },
        },
      }],
    });
    const exclusionsAfterRemove = await db.select().from(schema.projectAutoIncludeExclusions)
      .where((await import('drizzle-orm')).eq(
        schema.projectAutoIncludeExclusions.taskId,
        taskIds[0],
      ));
    expect(exclusionsAfterRemove).toHaveLength(1);

    const restored = await applyProjectHierarchyCommand({
      projectId,
      request: {
        commandId: 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
        expectedRevision: removed.revision,
        command: removed.inverseCommand,
      },
    });
    expect(restored.hierarchy.phaseItemsByPhase[phaseIds[0]][0]).toMatchObject({
      id: 'item-remove-command-a',
      taskId: taskIds[0],
      estimatedEffortHours: 3,
      sortOrder: 0,
    });
    const exclusionsAfterRestore = await db.select().from(schema.projectAutoIncludeExclusions)
      .where((await import('drizzle-orm')).eq(
        schema.projectAutoIncludeExclusions.taskId,
        taskIds[0],
      ));
    expect(exclusionsAfterRestore).toEqual([]);
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
