import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('ideation conversion transaction', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('persists the project hierarchy, properties, tags, and dependencies atomically', async () => {
    const [{ POST }, { default: db }, schema] = await Promise.all([
      import('@/app/api/ideation/convert/route'),
      import('@/db'),
      import('@/db/schema'),
    ]);

    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Integrated graph project',
        color: '#6366f1',
        nodes: [
          {
            id: 'root',
            label: 'Integrated graph project',
            kind: 'idea',
            parentId: null,
            sortOrder: 0,
            properties: {},
          },
          {
            id: 'phase',
            label: 'Build',
            kind: 'phase',
            parentId: 'root',
            sortOrder: 0,
            properties: {},
          },
          {
            id: 'first',
            label: 'First task',
            kind: 'task',
            parentId: 'phase',
            sortOrder: 0,
            properties: {
              priority: { key: 'priority', rawValue: 'high', value: 'high' },
              tags: { key: 'tags', rawValue: '#graph', value: ['graph'] },
              assignee: { key: 'assignee', rawValue: 'me', value: 'me' },
            },
          },
          {
            id: 'second',
            label: 'Second task',
            kind: 'task',
            parentId: 'phase',
            sortOrder: 1,
            properties: {
              'depends-on': {
                key: 'depends-on',
                rawValue: '[[First task]]',
                value: ['First task'],
              },
              due: { key: 'due', rawValue: '2030-01-02', value: '2030-01-02' },
              related: {
                key: 'related',
                rawValue: '[[First task]]',
                value: ['First task'],
              },
            },
          },
          {
            id: 'child',
            label: 'Child task',
            kind: 'task',
            parentId: 'first',
            sortOrder: 0,
            properties: {
              notes: {
                key: 'notes',
                rawValue: 'Coordinate with [[Second task]]',
                value: 'Coordinate with [[Second task]]',
              },
            },
          },
          {
            id: 'grandchild',
            label: 'Grandchild task',
            kind: 'task',
            parentId: 'child',
            sortOrder: 0,
            properties: {},
          },
        ],
      }),
    }));

    expect(response.status).toBe(201);
    const projects = await db.select().from(schema.hubProjects);
    const phases = await db.select().from(schema.projectPhases);
    const persistedTasks = await db.select().from(schema.tasks);
    const memberships = await db.select().from(schema.taskProjects);
    const phaseItems = await db.select().from(schema.projectPhaseItems);
    const persistedTags = await db.select().from(schema.tags);
    const tagLinks = await db.select().from(schema.taskTags);
    const dependencies = await db.select().from(schema.taskDependencies);

    expect(projects).toHaveLength(1);
    expect(phases.map((phase) => phase.name)).toEqual(['Build']);
    expect(persistedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'First task', priority: 'high', assignee: 'me', depth: 0 }),
      expect.objectContaining({ title: 'Second task', dueDate: '2030-01-02' }),
      expect.objectContaining({ title: 'Child task', depth: 1 }),
      expect.objectContaining({ title: 'Grandchild task', depth: 2 }),
    ]));
    const taskByTitle = new Map(persistedTasks.map((task) => [task.title, task]));
    expect(taskByTitle.get('Child task')?.parentId).toBe(taskByTitle.get('First task')?.id);
    expect(taskByTitle.get('Grandchild task')?.parentId).toBe(taskByTitle.get('Child task')?.id);
    expect(memberships).toHaveLength(4);
    expect(phaseItems).toHaveLength(4);
    expect(persistedTags.map((tag) => tag.slug)).toContain('graph');
    expect(tagLinks).toHaveLength(1);
    expect(dependencies).toHaveLength(3);
    expect(dependencies.map((dependency) => dependency.type).sort()).toEqual([
      'blocks',
      'related',
      'related',
    ]);
    expect(dependencies.find((dependency) => dependency.type === 'blocks')).toEqual(
      expect.objectContaining({
        taskId: taskByTitle.get('Second task')?.id,
        dependsOnTaskId: taskByTitle.get('First task')?.id,
      }),
    );
    for (const related of dependencies.filter((dependency) => dependency.type === 'related')) {
      expect(related.dependsOnTaskId.localeCompare(related.taskId)).toBeLessThan(0);
    }
  });
});
