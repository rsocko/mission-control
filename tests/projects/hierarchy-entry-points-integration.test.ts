import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('@/db');
  vi.doUnmock('@/db/schema');
  vi.doUnmock('@/lib/projects/hierarchy-service');
  vi.doUnmock('@/lib/tasks/mutation-policy');
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

async function seedEntryPointProject(suffix: string) {
  const [{ default: db }, schema, { eq }] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('drizzle-orm'),
  ]);
  const now = new Date().toISOString();
  const projectId = `entry-project-${suffix}`;
  const phaseIds = [`entry-phase-${suffix}-a`, `entry-phase-${suffix}-b`];
  const taskIds = {
    drag: `entry-task-${suffix}-drag`,
    existing: `entry-task-${suffix}-existing`,
    created: `entry-task-${suffix}-created`,
    blocked: `entry-task-${suffix}-blocked`,
  };

  await db.insert(schema.hubProjects).values({
    id: projectId,
    name: `Entry project ${suffix}`,
    color: '#3b82f6',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.projectPhases).values(phaseIds.map((id, index) => ({
    id,
    projectId,
    name: `Phase ${index + 1}`,
    sortOrder: index,
    createdAt: now,
    updatedAt: now,
  })));
  await db.insert(schema.tasks).values([
    {
      id: taskIds.drag,
      sourceId: `local:${taskIds.drag}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Drag task',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: taskIds.existing,
      sourceId: `local:${taskIds.existing}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Existing task',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: taskIds.created,
      sourceId: `local:${taskIds.created}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Created task',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
    {
      id: taskIds.blocked,
      sourceId: `finance:${taskIds.blocked}`,
      connectorType: 'finance',
      connectorInstanceId: 'finance-history',
      title: 'Blocked task',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    },
  ]);
  await db.insert(schema.taskProjects).values([
    { taskId: taskIds.drag, projectId },
    { taskId: taskIds.created, projectId },
    { taskId: taskIds.blocked, projectId },
  ]);
  await db.insert(schema.projectPhaseItems).values([
    {
      id: `entry-item-${suffix}-drag`,
      phaseId: phaseIds[0],
      taskId: taskIds.drag,
      sortOrder: 0,
      estimatedEffortHours: 5,
      createdAt: now,
    },
    {
      id: `entry-item-${suffix}-blocked`,
      phaseId: phaseIds[0],
      taskId: taskIds.blocked,
      sortOrder: 1,
      createdAt: now,
    },
  ]);
  await db.update(schema.hubProjects)
    .set({ hierarchyRevision: 0 })
    .where(eq(schema.hubProjects.id, projectId));

  return { db, schema, projectId, phaseIds, taskIds };
}

async function loadSnapshot(projectId: string) {
  const { getProjectHierarchySnapshot } = await import('@/lib/projects/hierarchy-service');
  return getProjectHierarchySnapshot(projectId)!;
}

describe('project hierarchy mutation entry points', () => {
  it('keeps add-existing, new-task, drag, reorder, and phase removal mutually visible', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedEntryPointProject('mixed');
    const phaseItemsRoute = await import('@/app/api/project-phases/[id]/items/route');
    const membershipRoute = await import('@/app/api/hub-projects/[id]/tasks/route');
    const hierarchyRoute = await import('@/app/api/projects/[id]/hierarchy/route');
    const reorderRoute = await import('@/app/api/project-phases/[id]/items/reorder/route');

    const newTaskResponse = await phaseItemsRoute.POST(
      new Request(`http://localhost/api/project-phases/${phaseIds[0]}/items`, {
        method: 'POST',
        body: JSON.stringify({ taskId: taskIds.created, sortOrder: 1 }),
      }),
      { params: Promise.resolve({ id: phaseIds[0] }) },
    );
    expect(newTaskResponse.status).toBe(201);

    const addExistingResponse = await membershipRoute.POST(
      new Request(`http://localhost/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ taskId: taskIds.existing, phaseId: phaseIds[1] }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(addExistingResponse.status).toBe(200);

    const afterAdds = await loadSnapshot(projectId);
    expect(afterAdds.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds.drag, taskIds.blocked, taskIds.created]);
    expect(afterAdds.phaseItemsByPhase[phaseIds[1]].map((item) => item.taskId))
      .toEqual([taskIds.existing]);

    const dragResponse = await hierarchyRoute.POST(
      new Request(`http://localhost/api/projects/${projectId}/hierarchy`, {
        method: 'POST',
        body: JSON.stringify({
          commandId: '01010101-0101-4101-8101-010101010101',
          expectedRevision: afterAdds.revision,
          command: {
            type: 'move_tasks',
            taskIds: [taskIds.drag],
            toPhaseId: phaseIds[1],
            toIndex: 0,
          },
        }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(dragResponse.status).toBe(200);

    const reorderResponse = await reorderRoute.PUT(
      new Request(`http://localhost/api/project-phases/${phaseIds[1]}/items/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ orderedTaskIds: [taskIds.existing, taskIds.drag] }),
      }),
      { params: Promise.resolve({ id: phaseIds[1] }) },
    );
    expect(reorderResponse.status).toBe(200);

    const removePhaseResponse = await phaseItemsRoute.DELETE(
      new Request(
        `http://localhost/api/project-phases/${phaseIds[0]}/items?task_id=${taskIds.created}`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: phaseIds[0] }) },
    );
    expect(removePhaseResponse.status).toBe(200);

    const finalSnapshot = await loadSnapshot(projectId);
    expect(finalSnapshot.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds.blocked]);
    expect(finalSnapshot.phaseItemsByPhase[phaseIds[1]].map((item) => ({
      taskId: item.taskId,
      sortOrder: item.sortOrder,
    }))).toEqual([
      { taskId: taskIds.existing, sortOrder: 0 },
      { taskId: taskIds.drag, sortOrder: 1 },
    ]);
    expect(finalSnapshot.revision).toBeGreaterThan(afterAdds.revision);

    const [dragItem] = await db.select().from(schema.projectPhaseItems)
      .where((await import('drizzle-orm')).eq(schema.projectPhaseItems.taskId, taskIds.drag));
    expect(dragItem).toMatchObject({
      id: 'entry-item-mixed-drag',
      phaseId: phaseIds[1],
      estimatedEffortHours: 5,
    });

    const staleResponse = await hierarchyRoute.POST(
      new Request(`http://localhost/api/projects/${projectId}/hierarchy`, {
        method: 'POST',
        body: JSON.stringify({
          commandId: '02020202-0202-4202-8202-020202020202',
          expectedRevision: afterAdds.revision,
          command: {
            type: 'move_tasks',
            taskIds: [taskIds.drag],
            toPhaseId: phaseIds[0],
            toIndex: 0,
          },
        }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      code: 'HIERARCHY_REVISION_CONFLICT',
      current: { revision: finalSnapshot.revision },
    });
  });

  it('persists exactly one winner when commands race from the same revision', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedEntryPointProject('concurrent');
    const { POST } = await import('@/app/api/projects/[id]/hierarchy/route');
    const makeRequest = (commandId: string, toPhaseId: string | null) => POST(
      new Request(`http://localhost/api/projects/${projectId}/hierarchy`, {
        method: 'POST',
        body: JSON.stringify({
          commandId,
          expectedRevision: 0,
          command: {
            type: 'move_tasks',
            taskIds: [taskIds.drag],
            toPhaseId,
            toIndex: 0,
          },
        }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );

    const responses = await Promise.all([
      makeRequest('03030303-0303-4303-8303-030303030303', phaseIds[1]),
      makeRequest('04040404-0404-4404-8404-040404040404', null),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const snapshot = await loadSnapshot(projectId);
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(snapshot.revision).toBe(1);
    expect(audits).toHaveLength(1);
    expect([
      phaseIds[1],
      null,
    ]).toContain(
      snapshot.phases.find((phase) => (
        snapshot.phaseItemsByPhase[phase.id].some((item) => item.taskId === taskIds.drag)
      ))?.id ?? null,
    );
  });

  it('blocks legacy placement and membership entry points without persisted changes', async () => {
    const { db, schema, projectId, phaseIds, taskIds } = await seedEntryPointProject('blocked');
    const phaseItemsRoute = await import('@/app/api/project-phases/[id]/items/route');
    const membershipRoute = await import('@/app/api/hub-projects/[id]/tasks/route');
    const reorderRoute = await import('@/app/api/project-phases/[id]/items/reorder/route');

    const responses = await Promise.all([
      phaseItemsRoute.DELETE(
        new Request(
          `http://localhost/api/project-phases/${phaseIds[0]}/items?task_id=${taskIds.blocked}`,
          { method: 'DELETE' },
        ),
        { params: Promise.resolve({ id: phaseIds[0] }) },
      ),
      membershipRoute.DELETE(
        new Request(`http://localhost/api/hub-projects/${projectId}/tasks`, {
          method: 'DELETE',
          body: JSON.stringify({ taskId: taskIds.blocked }),
        }),
        { params: Promise.resolve({ id: projectId }) },
      ),
      reorderRoute.PUT(
        new Request(`http://localhost/api/project-phases/${phaseIds[0]}/items/reorder`, {
          method: 'PUT',
          body: JSON.stringify({ orderedTaskIds: [taskIds.blocked, taskIds.drag] }),
        }),
        { params: Promise.resolve({ id: phaseIds[0] }) },
      ),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);

    const snapshot = await loadSnapshot(projectId);
    const memberships = await db.select().from(schema.taskProjects)
      .where((await import('drizzle-orm')).eq(schema.taskProjects.projectId, projectId));
    const audits = await db.select().from(schema.projectHierarchyCommands)
      .where((await import('drizzle-orm')).eq(schema.projectHierarchyCommands.projectId, projectId));
    expect(snapshot.revision).toBe(0);
    expect(snapshot.phaseItemsByPhase[phaseIds[0]].map((item) => item.taskId))
      .toEqual([taskIds.drag, taskIds.blocked]);
    expect(memberships.map((membership) => membership.taskId)).toContain(taskIds.blocked);
    expect(audits).toEqual([]);
  });
});
