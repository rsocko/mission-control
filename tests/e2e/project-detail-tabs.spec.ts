import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

interface ProjectCandidate {
  id: string;
  name: string;
}

interface ProjectTask {
  status: string;
  title: string;
}

interface ProjectFixtures {
  planProject: ProjectCandidate;
  planPhaseName: string;
  taskProject: ProjectCandidate;
  taskTitle: string;
}

async function discoverProjectFixtures(request: APIRequestContext): Promise<ProjectFixtures> {
  const projectsResponse = await request.get('/api/hub-projects');
  expect(projectsResponse.ok(), 'project discovery request should succeed').toBeTruthy();

  const { projects } = await projectsResponse.json() as { projects: ProjectCandidate[] };
  const routeSafeProjects = projects.filter(
    (project) => encodeURIComponent(project.id) === project.id,
  );
  expect(
    routeSafeProjects.length,
    'deployment should contain a visible project with a URL-segment-safe ID',
  ).toBeGreaterThan(0);

  let planProject: ProjectCandidate | undefined;
  let planPhaseName: string | undefined;
  let taskProject: ProjectCandidate | undefined;
  let taskTitle: string | undefined;
  for (const project of routeSafeProjects) {
    const tasksResponse = await request.get(
      `/api/tasks?projectId=${encodeURIComponent(project.id)}&parentOnly=true&sortBy=updated&limit=200&offset=0`,
    );
    expect(
      tasksResponse.ok(),
      `task discovery request should succeed for project "${project.name}"`,
    ).toBeTruthy();

    const { tasks } = await tasksResponse.json() as { tasks: ProjectTask[] };
    const activeTask = tasks.find(
      ({ status }) => status !== 'done' && status !== 'cancelled',
    );
    if (!activeTask) continue;

    if (!taskProject) {
      taskProject = project;
      taskTitle = activeTask.title;
    }

    const hierarchyResponse = await request.get(
      `/api/projects/${encodeURIComponent(project.id)}/hierarchy`,
    );
    expect(
      hierarchyResponse.ok(),
      `hierarchy discovery request should succeed for project "${project.name}"`,
    ).toBeTruthy();

    const { hierarchy } = await hierarchyResponse.json() as {
      hierarchy: { phases: Array<{ id: string; name: string }> };
    };
    const [phase] = hierarchy.phases;
    if (phase) {
      planProject = project;
      planPhaseName = phase.name;
    }

    if (planProject && planPhaseName && taskProject && taskTitle) break;
  }

  if (!planProject || !planPhaseName) {
    throw new Error(
      'deployment should contain a visible project with phases and an active task',
    );
  }
  if (!taskProject || !taskTitle) {
    throw new Error('deployment should contain a visible project with an active task');
  }

  return { planProject, planPhaseName, taskProject, taskTitle };
}

async function openProject(
  page: Page,
  project: ProjectCandidate,
  tab: 'phases' | 'tasks',
) {
  await page.goto(`/projects/${encodeURIComponent(project.id)}?tab=${tab}`);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
}

test.describe('Project detail tabs', () => {
  let fixtures: ProjectFixtures;

  test.beforeAll(async ({ request }) => {
    fixtures = await discoverProjectFixtures(request);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    });
  });

  test('switches tabs and restores Plan view state', async ({ page }) => {
    await openProject(page, fixtures.planProject, 'phases');
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();

    await page.getByRole('button', { name: 'Gantt' }).click();
    await expect(page.getByText('Phase timeline')).toBeVisible();
    await page.getByRole('button', { name: 'Month' }).click();
    await expect(page.getByText(/Zoom by month/)).toBeVisible();

    await page.getByRole('button', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Description' })).toBeVisible();
    await page.getByRole('button', { name: /^Plan \(/ }).click();

    await expect(page.getByText('Phase timeline')).toBeVisible();
    await expect(page.getByText(/Zoom by month/)).toBeVisible();
  });

  test('keeps one task detail panel across tabs', async ({ page }) => {
    await openProject(page, fixtures.taskProject, 'tasks');
    await page.getByText(fixtures.taskTitle, { exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Close task detail' })).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close task detail' })).toBeVisible();
  });

  test('keeps phase add-task menu keyboard accessible', async ({ page }) => {
    await openProject(page, fixtures.planProject, 'phases');
    const phase = page.getByRole(
      'region',
      { name: `${fixtures.planPhaseName} phase`, exact: true },
    );
    const addTask = phase.getByRole('button', { name: 'Add task' });
    await addTask.click();

    const createTask = page.getByRole('menuitem', { name: 'Create new task' });
    const linkTask = page.getByRole('menuitem', { name: 'Link existing task' });
    await expect(createTask).toBeFocused();

    await createTask.press('ArrowDown');
    await expect(linkTask).toBeFocused();
    await linkTask.press('ArrowUp');
    await expect(createTask).toBeFocused();
    await createTask.press('End');
    await expect(linkTask).toBeFocused();
    await linkTask.press('Home');
    await expect(createTask).toBeFocused();
  });
});
