import { expect, test } from '@playwright/test';
import type { QuickSortQueueTask } from '@/lib/hooks/useQuickSortData';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

test.use({ serviceWorkers: 'block' });

const task = {
  id: 'task-desktop',
  title: 'Add Quick Sort UI into desktop',
  hasNotes: true,
  priority: 'none',
  effort: null,
  status: 'todo',
  connectorType: 'github-issues',
  connectorInstanceId: 'github',
  sourceListId: null,
  sourceListName: 'octo-org/mission-control',
  dueDate: null,
  createdAt: '2026-08-01T12:00:00.000Z',
  projects: [{ id: 'project-1', name: 'Mission Control', color: '#6366f1' }],
  phases: [],
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
} satisfies QuickSortQueueTask;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const trackedWindow = window as typeof window & { __quickSortQueueMaxCount: number };
    const updateQueueCount = () => {
      trackedWindow.__quickSortQueueMaxCount = Math.max(
        trackedWindow.__quickSortQueueMaxCount,
        document.querySelectorAll('aside[aria-label="Quick Sort queues"]').length,
      );
    };
    trackedWindow.__quickSortQueueMaxCount = 0;
    new MutationObserver(updateQueueCount).observe(document, { childList: true, subtree: true });
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });

  await page.route('**/api/tasks/quick-sort**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.endsWith('/suggestions')) {
      await route.fulfill({
        json: {
          suggestions: {
            [task.id]: {
              priority: { value: 'high', confidence: 0.91, reason: 'High-value workflow parity' },
              effort: null,
              tags: [],
            },
          },
        },
      });
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

    if (url.searchParams.get('sources') === 'true') {
      await route.fulfill({
        json: {
          sources: {
            'github-issues': {
              connectorId: 'github',
              lists: [{ name: 'octo-org/mission-control', count: 1 }],
            },
          },
        },
      });
      return;
    }

    await route.fulfill({ json: { tasks: [task] } });
  });

  await page.route('**/api/tasks/quick-sort-stats', async (route) => {
    await route.fulfill({
      json: {
        thisWeek: {
          total: 4,
          byMode: { no_priority: 4, no_effort: 0, no_tags: 0, no_due_date: 0 },
        },
        streak: 2,
      },
    });
  });

  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    await route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/settings/mode', async (route) => {
    await route.fulfill({ json: { mode: 'live' } });
  });
  await page.route('**/api/features', async (route) => {
    await route.fulfill({ json: { taskCreation: true, aiEnabled: true } });
  });
  await page.route('**/api/health', async (route) => {
    await route.fulfill({
      json: {
        overall: 'healthy',
        message: 'All systems operational',
        connectors: [],
        disabledFeatures: [],
      },
    });
  });

  await page.goto('/quick-sort');
});

test('keeps queue context visible and exposes desktop AI actions', async ({ page }) => {
  const queuePanel = page.locator('aside[aria-label="Quick Sort queues"]');
  await expect(queuePanel).toHaveCount(1);
  await expect(queuePanel).toBeVisible();
  await expect(page.getByRole('link', { name: 'Quick Sort' })).toBeVisible();

  await page.getByRole('button', { name: /Set Priority/ }).click();

  await expect(page.getByRole('heading', { name: 'Set Priority' })).toBeVisible();
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible();
  await expect(queuePanel).toHaveCount(1);
  await expect(queuePanel).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply suggestion/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden();
  expect(await page.evaluate(
    () => (window as typeof window & { __quickSortQueueMaxCount: number }).__quickSortQueueMaxCount,
  )).toBe(1);

  const queueBox = await queuePanel.boundingBox();
  const workspaceBox = await page.getByTestId('quick-sort-mode').boundingBox();
  expect(queueBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(workspaceBox!.x).toBeGreaterThanOrEqual(queueBox!.x + queueBox!.width);
});

test('supports numeric desktop shortcuts for the active queue', async ({ page }) => {
  await page.getByRole('button', { name: /Set Priority/ }).click();
  await expect(page.getByRole('heading', { name: task.title })).toBeVisible();

  const patchRequest = page.waitForRequest((request) => (
    request.method() === 'PATCH' && request.url().endsWith(`/api/tasks/${task.id}`)
  ));
  await page.keyboard.press('2');

  expect((await patchRequest).postDataJSON()).toEqual({ priority: 'high' });
  await expect(page.getByText('All caught up!')).toBeVisible();
});

test('mounts the queue region when the active workspace crosses into desktop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(1);
  await page.getByRole('button', { name: /Set Priority/ }).click();
  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(0);
});
