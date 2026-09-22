import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'poisoned-organization-project';
const PHASE_ID = 'poisoned-organization-phase';
const GROUP_ID = 'poisoned-organization-group';

const project = {
  id: PROJECT_ID,
  name: 'Project',
  description: null,
  color: '#3b82f6',
  icon: null,
  iconColor: '#3b82f6',
  sourceBindings: [],
  autoIncludeRules: [],
  kanbanColumns: [],
  defaultView: 'list',
  defaultFilters: null,
  status: 'active',
  statusOverride: null,
  hidden: false,
  category: null,
  targetDate: null,
  startedAt: null,
  completedAt: null,
  sortOrder: 0,
  hierarchyRevision: 0,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};
const phase = {
  id: PHASE_ID,
  projectId: PROJECT_ID,
  name: 'Phase',
  description: null,
  status: 'pending' as const,
  color: null,
  estimatedDays: null,
  targetStart: null,
  targetEnd: null,
  startAfterPhaseId: null,
  sortOrder: 0,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const listSnapshot = {
  groups: [{
    id: GROUP_ID,
    name: 'Group',
    icon: null,
    iconColor: null,
    sourceId: null,
    sortOrder: 0,
    createdAt: NOW,
    sourceLists: [],
  }],
  ungroupedLists: [],
};

const calls = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(async () => ({ affectedTaskIds: [] })),
  deleteProject: vi.fn(async () => ({ affectedTaskIds: [] })),
  createPhase: vi.fn(async (created: unknown) => created),
  updatePhase: vi.fn(async () => phase),
  deletePhase: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  reorderGroups: vi.fn(),
  reevaluateProject: vi.fn(async () => ({
    added: 1,
    matched: 1,
    matches: [{
      taskId: 'poisoned-new-member',
      title: 'Matched',
      status: 'todo',
      alreadyAssigned: true,
      excluded: false,
      excludedAt: null,
      reasons: ['Title contains "match"'],
    }],
  })),
  previewProjectRules: vi.fn(async () => []),
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
  publishSemanticEntityDelete: vi.fn(async () => undefined),
}));

const projectAdministration = {
  listProjects: async () => [project],
  getProject: async (id: string) => id === PROJECT_ID ? project : null,
  projectExists: async (id: string) => id === PROJECT_ID,
  createProject: calls.createProject,
  updateProject: calls.updateProject,
  deleteProject: calls.deleteProject,
  listPhases: async () => [phase],
  createPhase: calls.createPhase,
  getPhase: async (id: string) => id === PHASE_ID ? { phase, items: [] } : null,
  updatePhase: calls.updatePhase,
  deletePhase: calls.deletePhase,
};
const listOrganization = {
  getSnapshot: async () => listSnapshot,
  createGroup: calls.createGroup,
  updateGroup: calls.updateGroup,
  deleteGroup: calls.deleteGroup,
  reorderGroups: calls.reorderGroups,
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    projectAutomation: { projectAdministration, listOrganization },
  }),
}));
vi.mock('@/lib/rules', () => ({
  normalizeAutoIncludeRules: (value: unknown) => Array.isArray(value) ? value : [],
  reevaluateProject: calls.reevaluateProject,
  previewProjectRules: calls.previewProjectRules,
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: calls.publishSemanticEntityDelete,
  publishSemanticEntityUpsert: calls.publishSemanticEntityUpsert,
}));
vi.mock('@/lib/logger', () => ({
  dbLogger: { error: vi.fn() },
}));

const BASE = 'http://localhost:3099';

describe('poisoned-SQLite project-organization web surface', () => {
  it('serves all eight routes through the selected PostgreSQL-shaped composition', async () => {
    const [
      projects,
      projectItem,
      ruleMatches,
      phases,
      phaseItem,
      groups,
      groupItem,
      reorder,
    ] = await Promise.all([
      import('@/app/api/hub-projects/route'),
      import('@/app/api/hub-projects/[id]/route'),
      import('@/app/api/hub-projects/[id]/rule-matches/route'),
      import('@/app/api/project-phases/route'),
      import('@/app/api/project-phases/[id]/route'),
      import('@/app/api/list-groups/route'),
      import('@/app/api/list-groups/[id]/route'),
      import('@/app/api/list-groups/reorder/route'),
    ]);

    expect((await projects.GET(new Request(`${BASE}/api/hub-projects`))).status).toBe(200);
    expect((await projects.POST(new Request(`${BASE}/api/hub-projects`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Created' }),
    }))).status).toBe(201);
    expect((await projects.PATCH(new Request(`${BASE}/api/hub-projects`, {
      method: 'PATCH',
      body: JSON.stringify({ id: PROJECT_ID, name: 'Renamed' }),
    }))).status).toBe(200);
    expect((await projects.DELETE(new Request(
      `${BASE}/api/hub-projects?id=${PROJECT_ID}`,
      { method: 'DELETE' },
    ))).status).toBe(200);

    const projectParams = { params: Promise.resolve({ id: PROJECT_ID }) };
    expect((await projectItem.GET(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}`,
    ), projectParams)).status).toBe(200);
    expect((await projectItem.PATCH(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}`,
      { method: 'PATCH', body: JSON.stringify({ hidden: true }) },
    ), projectParams)).status).toBe(200);
    expect((await projectItem.DELETE(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}`,
      { method: 'DELETE' },
    ), projectParams)).status).toBe(200);
    expect((await ruleMatches.GET(new Request(
      `${BASE}/api/hub-projects/${PROJECT_ID}/rule-matches`,
    ), projectParams)).status).toBe(200);

    expect((await phases.GET(new Request(`${BASE}/api/project-phases`))).status).toBe(200);
    expect((await phases.POST(new Request(`${BASE}/api/project-phases`, {
      method: 'POST',
      body: JSON.stringify({ projectId: PROJECT_ID, name: 'Created phase' }),
    }))).status).toBe(201);
    const phaseParams = { params: Promise.resolve({ id: PHASE_ID }) };
    expect((await phaseItem.GET(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}`,
    ), phaseParams)).status).toBe(200);
    expect((await phaseItem.PATCH(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}`,
      { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) },
    ), phaseParams)).status).toBe(200);
    expect((await phaseItem.DELETE(new Request(
      `${BASE}/api/project-phases/${PHASE_ID}`,
      { method: 'DELETE' },
    ), phaseParams)).status).toBe(200);

    expect((await groups.GET()).status).toBe(200);
    expect((await groups.POST(new Request(`${BASE}/api/list-groups`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Created group' }),
    }))).status).toBe(201);
    const groupParams = { params: Promise.resolve({ id: GROUP_ID }) };
    expect((await groupItem.PATCH(new Request(
      `${BASE}/api/list-groups/${GROUP_ID}`,
      { method: 'PATCH', body: JSON.stringify({ name: 'Renamed group' }) },
    ), groupParams)).status).toBe(200);
    expect((await groupItem.DELETE(new Request(
      `${BASE}/api/list-groups/${GROUP_ID}`,
      { method: 'DELETE' },
    ), groupParams)).status).toBe(200);
    expect((await reorder.PUT(new Request(`${BASE}/api/list-groups/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ orderedIds: [GROUP_ID] }),
    }))).status).toBe(200);
  });

  it('resolves both clean services without evaluating SQLite', async () => {
    const [projects, groups] = await Promise.all([
      import('@/lib/projects/organization-service'),
      import('@/lib/list-groups/service'),
    ]);
    await expect(projects.getHubProject(PROJECT_ID)).resolves.toEqual(project);
    await expect(projects.getProjectPhase(PHASE_ID)).resolves.toEqual({
      phase,
      items: [],
    });
    await projects.updateHubProject(PROJECT_ID, {
      autoIncludeRules: [{ type: 'title_contains', value: 'match' }],
    });
    expect(calls.publishSemanticEntityUpsert).toHaveBeenCalledWith(
      'task',
      'poisoned-new-member',
    );
    await projects.updateProjectPhase(PHASE_ID, { status: 'completed' });
    expect(calls.updatePhase).toHaveBeenCalledWith(
      PHASE_ID,
      expect.objectContaining({
        status: 'completed',
        completedAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    );
    await expect(groups.getListOrganizationSnapshot()).resolves.toEqual(listSnapshot);
  });
});
