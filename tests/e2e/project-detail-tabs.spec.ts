import { expect, test } from '@playwright/test';

test.describe('Project detail tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    });
    await page.goto('/projects/proj-kitchen-reno');
    await expect(page.getByRole('heading', { name: 'Kitchen Renovation' })).toBeVisible();
  });

  test('switches tabs and restores Plan view state', async ({ page }) => {
    await page.getByRole('button', { name: /^Plan \(/ }).click();
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

  test('keeps one task detail panel across tabs', async ({ page, request }) => {
    const response = await request.get(
      '/api/tasks?projectId=proj-kitchen-reno&parentOnly=true&sortBy=updated&limit=200&offset=0',
    );
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as {
      tasks: Array<{ status: string; title: string }>;
    };
    const taskTitle = payload.tasks.find((task) => (
      task.status !== 'done' && task.status !== 'cancelled'
    ))?.title;
    expect(taskTitle).toBeTruthy();

    await page.getByRole('button', { name: /^Project Tasks \(/ }).click();
    await page.getByText(taskTitle!, { exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Close task detail' })).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close task detail' })).toBeVisible();
  });

  test('keeps phase add-task menu keyboard accessible', async ({ page }) => {
    await page.getByRole('button', { name: /^Plan \(/ }).click();
    const phase = page.getByRole('region', { name: / phase$/ }).first();
    await phase.getByRole('button', { name: 'Add task' }).click();

    const createTask = page.getByRole('menuitem', { name: 'Create new task' });
    const linkTask = page.getByRole('menuitem', { name: 'Link existing task' });
    await expect(createTask).toBeFocused();

    await createTask.press('ArrowDown');
    await expect(linkTask).toBeFocused();
    await linkTask.press('Escape');
    await expect(phase.getByRole('button', { name: 'Add task' })).toBeFocused();
  });
});
