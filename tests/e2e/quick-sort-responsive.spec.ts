import { devices, expect, test } from '@playwright/test';
import type { QuickSortQueueTask } from '@/lib/hooks/useQuickSortData';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

test.use({
  ...devices['iPhone 16 Pro Max'],
  browserName: 'webkit',
  serviceWorkers: 'block',
});

const longTask = {
  id: 'task-overflow',
  title: 'Long mobile card content '.repeat(30),
  hasNotes: false,
  priority: 'none',
  effort: null,
  status: 'todo',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: null,
  sourceListName: null,
  dueDate: null,
  createdAt: '2026-07-31T12:00:00.000Z',
  projects: [],
  phases: [],
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
} satisfies QuickSortQueueTask;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });

  await page.route('**/api/tasks/quick-sort**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.endsWith('/suggestions')) {
      await route.fulfill({ json: { suggestions: {} } });
      return;
    }

    if (url.searchParams.get('counts') === 'true') {
      await route.fulfill({
        json: {
          counts: { no_priority: 1, no_effort: 1, no_tags: 1, no_due_date: 0 },
        },
      });
      return;
    }

    await route.fulfill({ json: { tasks: [longTask] } });
  });

  await page.route('**/api/tasks/quick-sort-stats', async (route) => {
    await route.fulfill({
      json: {
        thisWeek: {
          total: 0,
          byMode: { no_priority: 0, no_effort: 0, no_tags: 0, no_due_date: 0 },
        },
        streak: 0,
      },
    });
  });

  await page.route('**/api/settings/mode', async (route) => {
    await route.fulfill({ json: { mode: 'live' } });
  });

  await page.goto('/quick-sort');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
  });
  const queueButton = page.getByRole('button', { name: /Set Priority/ });
  const modeHeading = page.getByRole('heading', { name: 'Set Priority' });
  await expect(async () => {
    if (await queueButton.isVisible()) {
      await queueButton.click();
    }
    await expect(modeHeading).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});

test('keeps actions visible while long task details scroll', async ({ browserName, page }) => {
  expect(browserName).toBe('webkit');
  const details = page.getByRole('region', { name: 'Task details' });
  const markDone = page.getByRole('button', { name: 'Done', exact: true });
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });

  await expect(markDone).toBeInViewport();

  const dimensions = await details.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const actionBox = await markDone.boundingBox();
  const navBox = await mobileNav.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(navBox!.y);
});

test('keeps actions reachable on an exceptionally short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 390 });

  const mode = page.getByTestId('quick-sort-mode');
  const markDone = page.getByRole('button', { name: 'Done', exact: true });
  await markDone.scrollIntoViewIfNeeded();

  await expect(markDone).toBeInViewport();
  const dimensions = await mode.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
});
