import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.MC_DB_PATH = ':memory:';
  vi.doUnmock('drizzle-orm');
  vi.doUnmock('crypto');
  vi.resetModules();
});

describe('project auto-include rules', () => {
  it('normalizes tag rules, backfills matches on save, and explains qualification', async () => {
    const [{ default: db }, schema, { eq, and }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const now = new Date().toISOString();
    const projectId = 'project-auto-include';

    await db.insert(schema.hubProjects).values({
      id: projectId,
      name: '3D Printing',
      color: '#3b82f6',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.tasks).values([
      {
        id: 'auto-tagged',
        sourceId: 'source-auto-tagged',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Print enclosure',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'auto-unmatched',
        sourceId: 'source-auto-unmatched',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Buy groceries',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);
    await db.insert(schema.tags).values({
      id: 'tag-3d-print',
      name: '3DPrint',
      slug: '3dprint',
      type: 'hub',
      confirmed: true,
      createdAt: now,
    });
    await db.insert(schema.taskTags).values({
      taskId: 'auto-tagged',
      tagId: 'tag-3d-print',
    });

    const { PATCH } = await import('@/app/api/hub-projects/[id]/route');
    const response = await PATCH(
      new Request(`http://localhost/api/hub-projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoIncludeRules: [{ type: 'tag', value: '#3DPrint' }],
        }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.evaluation).toMatchObject({ added: 1, matched: 1 });

    const [storedProject] = await db.select()
      .from(schema.hubProjects)
      .where(eq(schema.hubProjects.id, projectId));
    expect(storedProject.autoIncludeRules).toEqual([{ type: 'tag', value: '3DPrint' }]);

    const membership = await db.select()
      .from(schema.taskProjects)
      .where(and(
        eq(schema.taskProjects.projectId, projectId),
        eq(schema.taskProjects.taskId, 'auto-tagged'),
      ));
    expect(membership).toHaveLength(1);

    const { GET } = await import('@/app/api/hub-projects/[id]/rule-matches/route');
    const previewResponse = await GET(
      new Request(`http://localhost/api/hub-projects/${projectId}/rule-matches`),
      { params: Promise.resolve({ id: projectId }) },
    );
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      total: 1,
      matches: [{
        taskId: 'auto-tagged',
        title: 'Print enclosure',
        alreadyAssigned: true,
        reasons: ['Tag "3DPrint"'],
      }],
    });

    const taskMembershipRoute = await import('@/app/api/hub-projects/[id]/tasks/route');
    const removalResponse = await taskMembershipRoute.DELETE(
      new Request(`http://localhost/api/hub-projects/${projectId}/tasks`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'auto-tagged' }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(removalResponse.status).toBe(200);

    const exclusions = await db.select()
      .from(schema.projectAutoIncludeExclusions)
      .where(and(
        eq(schema.projectAutoIncludeExclusions.projectId, projectId),
        eq(schema.projectAutoIncludeExclusions.taskId, 'auto-tagged'),
      ));
    expect(exclusions).toHaveLength(1);

    const rules = await import('@/lib/rules');
    await rules.evaluateRulesForTasks(['auto-tagged']);
    const excludedMembership = await db.select()
      .from(schema.taskProjects)
      .where(and(
        eq(schema.taskProjects.projectId, projectId),
        eq(schema.taskProjects.taskId, 'auto-tagged'),
      ));
    expect(excludedMembership).toHaveLength(0);

    const excludedPreviewResponse = await GET(
      new Request(`http://localhost/api/hub-projects/${projectId}/rule-matches`),
      { params: Promise.resolve({ id: projectId }) },
    );
    const excludedPreview = await excludedPreviewResponse.json();
    expect(excludedPreview.matches[0]).toMatchObject({
      taskId: 'auto-tagged',
      alreadyAssigned: false,
      excluded: true,
    });

    const restoreResponse = await taskMembershipRoute.POST(
      new Request(`http://localhost/api/hub-projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'auto-tagged' }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(restoreResponse.status).toBe(200);

    const restoredExclusions = await db.select()
      .from(schema.projectAutoIncludeExclusions)
      .where(and(
        eq(schema.projectAutoIncludeExclusions.projectId, projectId),
        eq(schema.projectAutoIncludeExclusions.taskId, 'auto-tagged'),
      ));
    expect(restoredExclusions).toHaveLength(0);
    const restoredMembership = await db.select()
      .from(schema.taskProjects)
      .where(and(
        eq(schema.taskProjects.projectId, projectId),
        eq(schema.taskProjects.taskId, 'auto-tagged'),
      ));
    expect(restoredMembership).toHaveLength(1);
  });

  it('uses OR semantics and applies tag rules to sync-time candidate tasks', async () => {
    const [{ default: db }, schema, rules] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/rules'),
    ]);
    const now = new Date().toISOString();
    const projectId = 'project-auto-sync';

    await db.insert(schema.hubProjects).values({
      id: projectId,
      name: 'Auto Sync',
      color: '#3b82f6',
      autoIncludeRules: [
        { type: 'tag', value: '3DPrint' },
        { type: 'title_contains', value: 'phase 0' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.tasks).values([
      {
        id: 'sync-tagged',
        sourceId: 'source-sync-tagged',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Print a bracket',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'sync-title',
        sourceId: 'source-sync-title',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Complete PHASE 0',
        status: 'todo',
        priority: 'none',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);
    await db.insert(schema.taskTags).values({
      taskId: 'sync-tagged',
      tagId: 'tag-3d-print',
    });

    await rules.evaluateRulesForTasks(['sync-tagged', 'sync-title']);
    const memberships = await db.select()
      .from(schema.taskProjects)
      .where((await import('drizzle-orm')).eq(schema.taskProjects.projectId, projectId));

    expect(memberships.map((membership) => membership.taskId).sort())
      .toEqual(['sync-tagged', 'sync-title']);
  });

  it.each(['merge', 'unify'] as const)(
    're-evaluates affected tasks after tag %s',
    async (operation) => {
      const [{ default: db }, schema, { eq, and }] = await Promise.all([
        import('@/db'),
        import('@/db/schema'),
        import('drizzle-orm'),
      ]);
      const now = new Date().toISOString();
      const projectId = `project-tag-${operation}`;
      const taskId = `task-tag-${operation}`;
      const aliasTaskId = `task-tag-alias-${operation}`;
      const targetTagId = `target-tag-${operation}`;
      const sourceTagId = `source-tag-${operation}`;
      const aliasTagId = `alias-tag-${operation}`;
      const nestedAliasTagId = `nested-alias-tag-${operation}`;

      await db.insert(schema.hubProjects).values({
        id: projectId,
        name: `Tag ${operation}`,
        color: '#3b82f6',
        autoIncludeRules: [{ type: 'tag', value: `target-${operation}` }],
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.tasks).values([
        {
          id: taskId,
          sourceId: `source-${taskId}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          title: `Task for tag ${operation}`,
          status: 'todo',
          priority: 'none',
          metadata: {},
          syncStatus: 'synced',
          createdAt: now,
          updatedAt: now,
          lastSyncedAt: now,
        },
        {
          id: aliasTaskId,
          sourceId: `source-${aliasTaskId}`,
          connectorType: 'local',
          connectorInstanceId: 'local',
          title: `Task for nested alias ${operation}`,
          status: 'todo',
          priority: 'none',
          metadata: {},
          syncStatus: 'synced',
          createdAt: now,
          updatedAt: now,
          lastSyncedAt: now,
        },
      ]);
      await db.insert(schema.tags).values([
        {
          id: targetTagId,
          name: `target-${operation}`,
          slug: `target-${operation}`,
          type: 'hub',
          confirmed: true,
          createdAt: now,
        },
        {
          id: sourceTagId,
          name: `source-${operation}`,
          slug: `source-${operation}`,
          type: operation === 'merge' ? 'hub' : 'source',
          confirmed: true,
          createdAt: now,
        },
        {
          id: aliasTagId,
          name: `alias-${operation}`,
          slug: `alias-${operation}`,
          type: 'source',
          confirmed: true,
          createdAt: now,
          unifiedInto: sourceTagId,
        },
        {
          id: nestedAliasTagId,
          name: `nested-alias-${operation}`,
          slug: `nested-alias-${operation}`,
          type: 'source',
          confirmed: true,
          createdAt: now,
          unifiedInto: aliasTagId,
        },
      ]);
      await db.insert(schema.taskTags).values([
        { taskId, tagId: sourceTagId },
        { taskId: aliasTaskId, tagId: nestedAliasTagId },
      ]);

      const route = operation === 'merge'
        ? await import('@/app/api/tags/merge/route')
        : await import('@/app/api/tags/unify/route');
      const response = await route.POST(new Request(`http://localhost/api/tags/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTagIds: [sourceTagId],
          targetTagId,
        }),
      }));

      expect(response.status).toBe(200);
      const membership = await db.select()
        .from(schema.taskProjects)
        .where(and(
          eq(schema.taskProjects.projectId, projectId),
          eq(schema.taskProjects.taskId, taskId),
        ));
      expect(membership).toHaveLength(1);
      expect(await db.select()
        .from(schema.taskProjects)
        .where(and(
          eq(schema.taskProjects.projectId, projectId),
          eq(schema.taskProjects.taskId, aliasTaskId),
        ))).toHaveLength(1);
      await expect(
        db.select({ unifiedInto: schema.tags.unifiedInto })
          .from(schema.tags)
          .where(eq(schema.tags.id, aliasTagId)),
      ).resolves.toEqual([{ unifiedInto: targetTagId }]);
      await expect(
        db.select({ unifiedInto: schema.tags.unifiedInto })
          .from(schema.tags)
          .where(eq(schema.tags.id, nestedAliasTagId)),
      ).resolves.toEqual([{ unifiedInto: targetTagId }]);
    },
  );

  it('detaches a shared hub tag only from the winning source scope', async () => {
    const [{ default: db }, schema, { and, eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const now = new Date().toISOString();
    const taskId = 'task-source-winner';
    const sameScopeHubOnlyTaskId = 'task-same-scope-hub-only';
    const otherSourceTaskId = 'task-other-source';
    const localAliasTaskId = 'task-local-alias';
    const hubTagId = 'hub-tag-to-remove';
    const sourceTagId = 'source-tag-to-keep';
    const selectedOtherSourceTagId = 'selected-other-source-tag';
    const existingAliasId = 'existing-source-alias';
    const localAliasId = 'local-alias';

    await db.insert(schema.tasks).values({
      id: taskId,
      sourceId: `source-${taskId}`,
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Task for source winner',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: sameScopeHubOnlyTaskId,
      sourceId: `source-${sameScopeHubOnlyTaskId}`,
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Task with only the shared hub tag',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: localAliasTaskId,
      sourceId: `source-${localAliasTaskId}`,
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceListId: 'todo-list',
      title: 'Task with a local alias but no selected source tag',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tasks).values({
      id: otherSourceTaskId,
      sourceId: `source-${otherSourceTaskId}`,
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      sourceListId: 'todo-list',
      title: 'Task using the shared hub elsewhere',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tags).values([
      {
        id: hubTagId,
        name: 'Area Insights',
        slug: 'area-insights',
        type: 'hub',
        confirmed: true,
        createdAt: now,
      },
      {
        id: sourceTagId,
        name: 'area:insights',
        slug: 'area-insights',
        type: 'source',
        source: 'github-issues',
        confirmed: true,
        createdAt: now,
      },
      {
        id: existingAliasId,
        name: 'area-insights',
        slug: 'area-insights',
        type: 'source',
        source: 'microsoft-todo',
        confirmed: true,
        createdAt: now,
        unifiedInto: hubTagId,
      },
      {
        id: selectedOtherSourceTagId,
        name: 'area-insights-selected',
        slug: 'area-insights-selected',
        type: 'source',
        source: 'microsoft-todo',
        confirmed: true,
        createdAt: now,
      },
      {
        id: localAliasId,
        name: 'Local alias',
        slug: 'local-alias',
        type: 'hub',
        confirmed: true,
        createdAt: now,
        unifiedInto: selectedOtherSourceTagId,
      },
    ]);
    await db.insert(schema.taskTags).values([
      { taskId, tagId: hubTagId },
      { taskId, tagId: sourceTagId },
      { taskId: sameScopeHubOnlyTaskId, tagId: hubTagId },
      { taskId: otherSourceTaskId, tagId: hubTagId },
      { taskId: otherSourceTaskId, tagId: selectedOtherSourceTagId },
      { taskId: localAliasTaskId, tagId: hubTagId },
      { taskId: localAliasTaskId, tagId: localAliasId },
    ]);

    const route = await import('@/app/api/tags/unify/route');
    const response = await route.POST(new Request('http://localhost/api/tags/unify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceTagIds: [hubTagId, sourceTagId, selectedOtherSourceTagId],
        targetTagId: sourceTagId,
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ removed: 0, detached: 2 });
    expect(await db.select().from(schema.tags).where(eq(schema.tags.id, hubTagId))).toHaveLength(1);
    expect(await db.select().from(schema.tags).where(eq(schema.tags.id, sourceTagId))).toHaveLength(1);
    await expect(
      db.select({ unifiedInto: schema.tags.unifiedInto })
        .from(schema.tags)
        .where(eq(schema.tags.id, existingAliasId)),
    ).resolves.toEqual([{ unifiedInto: hubTagId }]);
    expect(await db.select().from(schema.taskTags).where(eq(schema.taskTags.tagId, sourceTagId))).toHaveLength(3);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, taskId),
      eq(schema.taskTags.tagId, hubTagId),
    ))).toHaveLength(0);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, sameScopeHubOnlyTaskId),
      eq(schema.taskTags.tagId, hubTagId),
    ))).toHaveLength(1);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, localAliasTaskId),
      eq(schema.taskTags.tagId, hubTagId),
    ))).toHaveLength(1);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, otherSourceTaskId),
      eq(schema.taskTags.tagId, hubTagId),
    ))).toHaveLength(0);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, otherSourceTaskId),
      eq(schema.taskTags.tagId, sourceTagId),
    ))).toHaveLength(1);
  });

  it('rejects a source winner without a resolvable task scope', async () => {
    const [{ default: db }, schema, { eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const now = new Date().toISOString();
    const hubTagId = 'unused-source-hub';
    const sourceTagId = 'unused-source-winner';

    await db.insert(schema.tags).values([
      {
        id: hubTagId,
        name: 'Unused Hub',
        slug: 'unused-hub',
        type: 'hub',
        confirmed: true,
        createdAt: now,
      },
      {
        id: sourceTagId,
        name: 'unused-source',
        slug: 'unused-source',
        type: 'source',
        source: 'github-issues',
        confirmed: true,
        createdAt: now,
      },
    ]);

    const route = await import('@/app/api/tags/unify/route');
    const response = await route.POST(new Request('http://localhost/api/tags/unify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceTagIds: [hubTagId, sourceTagId],
        targetTagId: sourceTagId,
      }),
    }));

    expect(response.status).toBe(400);
    expect(await db.select().from(schema.tags).where(eq(schema.tags.id, hubTagId))).toHaveLength(1);
    expect(await db.select().from(schema.tags).where(eq(schema.tags.id, sourceTagId))).toHaveLength(1);
  });

  it('uses another selected source scope for an unused source winner', async () => {
    const [{ default: db }, schema, { and, eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const now = new Date().toISOString();
    const taskId = 'combined-source-scope-task';
    const hubTagId = 'combined-source-scope-hub';
    const targetTagId = 'combined-source-scope-target';
    const scopedSourceTagId = 'combined-source-scope-selected';

    await db.insert(schema.tasks).values({
      id: taskId,
      sourceId: `source-${taskId}`,
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-combined',
      sourceListId: 'todo-combined-list',
      title: 'Task using another selected source',
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tags).values([
      {
        id: hubTagId,
        name: 'Combined Hub',
        slug: 'combined-hub',
        type: 'hub',
        confirmed: true,
        createdAt: now,
      },
      {
        id: targetTagId,
        name: 'unused-winner',
        slug: 'unused-winner',
        type: 'source',
        source: 'github-issues',
        confirmed: true,
        createdAt: now,
      },
      {
        id: scopedSourceTagId,
        name: 'used-source',
        slug: 'used-source',
        type: 'source',
        source: 'microsoft-todo',
        confirmed: true,
        createdAt: now,
      },
    ]);
    await db.insert(schema.taskTags).values([
      { taskId, tagId: hubTagId },
      { taskId, tagId: scopedSourceTagId },
    ]);

    const route = await import('@/app/api/tags/unify/route');
    const response = await route.POST(new Request('http://localhost/api/tags/unify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceTagIds: [hubTagId, targetTagId, scopedSourceTagId],
        targetTagId,
      }),
    }));

    expect(response.status).toBe(200);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, taskId),
      eq(schema.taskTags.tagId, hubTagId),
    ))).toHaveLength(0);
    expect(await db.select().from(schema.taskTags).where(and(
      eq(schema.taskTags.taskId, taskId),
      eq(schema.taskTags.tagId, targetTagId),
    ))).toHaveLength(1);
  });

  it('rejects source-backed tags at the destructive merge endpoint', async () => {
    const [{ default: db }, schema] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
    ]);
    const now = new Date().toISOString();
    const targetTagId = 'destructive-merge-target';
    const sourceTagId = 'destructive-merge-source';
    await db.insert(schema.tags).values([
      {
        id: targetTagId,
        name: 'Local target',
        slug: 'local-target',
        type: 'hub',
        confirmed: true,
        createdAt: now,
      },
      {
        id: sourceTagId,
        name: 'Source label',
        slug: 'source-label',
        type: 'source',
        source: 'github-issues',
        confirmed: true,
        createdAt: now,
      },
    ]);

    const route = await import('@/app/api/tags/merge/route');
    const response = await route.POST(new Request('http://localhost/api/tags/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceTagIds: [sourceTagId],
        targetTagId,
      }),
    }));

    expect(response.status).toBe(400);
  });

  it('batches large rule backfills', async () => {
    const [{ default: db }, schema, rules, { eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/rules'),
      import('drizzle-orm'),
    ]);
    const now = new Date().toISOString();
    const projectId = 'project-batched-backfill';
    const taskCount = 501;

    await db.insert(schema.hubProjects).values({
      id: projectId,
      name: 'Batched backfill',
      color: '#3b82f6',
      autoIncludeRules: [{ type: 'connector', value: 'bulk-connector' }],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.tasks).values(Array.from({ length: taskCount }, (_, index) => ({
      id: `bulk-task-${index}`,
      sourceId: `bulk-source-${index}`,
      connectorType: 'test',
      connectorInstanceId: 'bulk-connector',
      title: `Bulk task ${index}`,
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    })));

    const evaluation = await rules.reevaluateProject(projectId);
    expect(evaluation).toMatchObject({ added: taskCount, matched: taskCount });

    const memberships = await db.select()
      .from(schema.taskProjects)
      .where(eq(schema.taskProjects.projectId, projectId));
    expect(memberships).toHaveLength(taskCount);
  });
});
