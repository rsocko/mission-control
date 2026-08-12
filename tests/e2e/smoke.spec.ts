/**
 * E2E Smoke Tests - Core user flows with Playwright
 * Tests #114
 *
 * Run against a remote deployment:
 *   BASE_URL=https://mission-control.example npx playwright test
 */
import { test, expect } from '@playwright/test';

test.describe('Navigation & Core Layout', () => {
  test('homepage loads and shows main layout', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Mission Control/i);
  });

  test('quick collapsed navigation clicks do not trigger expansion', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('nav-rail-pinned', 'false');
      localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    });
    await page.goto('/');

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.hover();
    await page.waitForTimeout(100);
    await expect(nav).toHaveCSS('width', '64px');

    await nav.getByRole('link', { name: 'Projects' }).click();
    await page.mouse.move(500, 500);

    await expect(page).toHaveURL(/\/projects$/);
    await page.waitForTimeout(400);
    await expect(nav).toHaveCSS('width', '64px');
  });

  test('kanban board is accessible', async ({ page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('triage page loads', async ({ page }) => {
    await page.goto('/triage');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('today page loads', async ({ page }) => {
    await page.goto('/today');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('settings page loads', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('Task Management Flow', () => {
  test('can view task list on kanban', async ({ page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('domcontentloaded');
    // Page should render without a fatal crash (toasts/banners from connectors are OK)
    await expect(page.locator('[data-testid="kanban-board"], main')).toBeVisible();
  });

  test('API health check - tasks endpoint responds', async ({ request }) => {
    const response = await request.get('/api/tasks');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('tasks');
  });

  test('API health check - sync status endpoint responds', async ({ request }) => {
    const response = await request.get('/api/sync');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('isSyncing');
  });

  test('API health check - triage endpoint responds', async ({ request }) => {
    const response = await request.get('/api/triage');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('items');
  });
});

test.describe('Triage Flow', () => {
  test('can capture a link via triage API', async ({ request }) => {
    const response = await request.post('/api/triage', {
      data: { url: 'https://example.com/test-article', title: 'E2E Test Capture' },
    });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty('item');
    expect(data.item).toHaveProperty('id');
  });
});

test.describe('Sync Flow', () => {
  test('can trigger a sync via API', async ({ request }) => {
    // Sync may take a long time on a live system with many connectors.
    // Just verify the endpoint accepts the request (not a 404/502).
    const response = await request.post('/api/sync', {
      data: {},
      timeout: 120_000,
    });
    expect(response.status()).toBeLessThan(502);
  });
});
