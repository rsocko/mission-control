import { devices, expect, test, type Page } from '@playwright/test';
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
  hasNotes: true,
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

const nextTask = {
  ...longTask,
  id: 'task-next',
  title: 'Next task',
  hasNotes: false,
} satisfies QuickSortQueueTask;

type RuntimeContext = 'browser' | 'standalone' | 'native';

test.beforeEach(async ({ browserName, page }) => {
  expect(browserName).toBe('webkit');
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });

  await page.route('**/api/tasks/quick-sort**', async (route) => {
    const url = new URL(route.request().url());

    if (route.request().method() === 'POST') {
      await route.fulfill({ json: { operation: { state: 'applied' } } });
      return;
    }

    if (url.pathname.endsWith('/suggestions')) {
      await route.fulfill({ json: { suggestions: {} } });
      return;
    }

    if (url.searchParams.get('counts') === 'true') {
      await route.fulfill({
        json: {
          counts: { no_priority: 2, no_effort: 2, no_tags: 2, no_due_date: 0 },
        },
      });
      return;
    }

    await route.fulfill({ json: { tasks: [longTask, nextTask] } });
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

  await page.route('**/api/tags', async (route) => {
    await route.fulfill({
      json: {
        tags: Array.from({ length: 20 }, (_, index) => ({
          id: `tag-${index}`,
          name: `Planning ${index}`,
          slug: `planning-${index}`,
          color: null,
        })),
      },
    });
  });
});

async function installRuntimeSignal(page: Page, runtime: RuntimeContext) {
  if (runtime === 'standalone') {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', {
        configurable: true,
        value: true,
      });
      const browserMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        if (query !== '(display-mode: standalone)') return browserMatchMedia(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true,
        };
      };
    });
  }

  if (runtime === 'native') {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isMCNativeApp', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(window, 'MCNativeContext', {
        configurable: true,
        value: { platform: 'ios', contractVersion: 1 },
      });
    });
  }
}

async function openPriorityQueue(
  page: Page,
  {
    runtime = 'browser',
    safeAreaTop = 59,
    safeAreaBottom = 34,
    viewport,
    queueName = /Pick Quadrant/,
    modeHeadingName = 'Pick Quadrant',
  }: {
    runtime?: RuntimeContext;
    safeAreaTop?: number;
    safeAreaBottom?: number;
    viewport?: { width: number; height: number };
    queueName?: RegExp;
    modeHeadingName?: string;
  } = {},
) {
  await installRuntimeSignal(page, runtime);
  if (viewport) await page.setViewportSize(viewport);
  await page.goto('/quick-sort');
  await page.evaluate(({ top, bottom }) => {
    document.documentElement.style.setProperty('--safe-area-inset-top', `${top}px`);
    document.documentElement.style.setProperty('--safe-area-inset-bottom', `${bottom}px`);
  }, { top: safeAreaTop, bottom: safeAreaBottom });

  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(1);
  const queueButton = page.getByRole('button', { name: queueName });
  const modeHeading = page.getByRole('heading', { name: modeHeadingName });
  await expect(async () => {
    if (await queueButton.isVisible()) await queueButton.click();
    await expect(modeHeading).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('aside[aria-label="Quick Sort queues"]')).toHaveCount(0);
}

async function expectStableQuickSortShell(page: Page) {
  const header = page.locator('[data-mobile-shell-header]');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  const done = page.getByRole('button', { name: 'Done', exact: true });
  const skip = page.getByRole('button', { name: 'Skip', exact: true });

  await expect(header).toBeInViewport();
  await expect(nav).toBeInViewport();
  await expect(done).toBeInViewport();
  await expect(skip).toBeInViewport();

  const geometry = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement!;
    const mode = document.querySelector<HTMLElement>('[data-testid="quick-sort-mode"]')!;
    const header = document.querySelector<HTMLElement>('[data-mobile-shell-header]')!;
    const nav = document.querySelector<HTMLElement>('[data-mobile-shell-nav]')!;
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Done')!;
    const skip = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Skip')!;

    return {
      documentScrollRange: scrollingElement.scrollHeight - scrollingElement.clientHeight,
      documentScrollTop: scrollingElement.scrollTop,
      modeScrollRange: mode.scrollHeight - mode.clientHeight,
      modeOverflowY: getComputedStyle(mode).overflowY,
      headerTop: header.getBoundingClientRect().top,
      navBottom: nav.getBoundingClientRect().bottom,
      doneBottom: done.getBoundingClientRect().bottom,
      skipBottom: skip.getBoundingClientRect().bottom,
      navTop: nav.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    };
  });

  expect(geometry.documentScrollRange).toBeLessThanOrEqual(1);
  expect(geometry.documentScrollTop).toBe(0);
  expect(geometry.modeScrollRange).toBeLessThanOrEqual(1);
  expect(geometry.modeOverflowY).toBe('hidden');
  expect(geometry.headerTop).toBeGreaterThanOrEqual(0);
  expect(geometry.navBottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);
  expect(geometry.doneBottom).toBeLessThanOrEqual(geometry.navTop + 0.5);
  expect(geometry.skipBottom).toBeLessThanOrEqual(geometry.navTop + 0.5);
}

async function expectOnlyBoundedRegionsScroll(page: Page) {
  const unexpectedScrollers = await page.evaluate(() => (
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="quick-sort-mode"] *'))
      .filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return /(auto|scroll)/.test(overflowY)
          && element.scrollHeight > element.clientHeight + 1;
      })
      .filter((element) => (
        element.getAttribute('aria-label') !== 'Task details'
        && element.dataset.testid !== 'quick-sort-primary-actions'
      ))
      .map((element) => element.outerHTML.slice(0, 160))
  ));
  expect(unexpectedScrollers).toEqual([]);
}

test('fits the full interaction on iPhone 16 Pro Max while task details scroll', async ({ page }) => {
  await openPriorityQueue(page);
  await expectStableQuickSortShell(page);

  const details = page.getByRole('region', { name: 'Task details' });
  const dimensions = await details.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await details.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStableQuickSortShell(page);
  await expectOnlyBoundedRegionsScroll(page);
});

for (const runtime of ['standalone', 'native'] satisfies RuntimeContext[]) {
  test(`${runtime} runtime keeps variable safe areas and all primary chrome visible`, async ({ page }) => {
    await openPriorityQueue(page, {
      runtime,
      safeAreaTop: runtime === 'standalone' ? 20 : 63,
      safeAreaBottom: runtime === 'standalone' ? 20 : 37,
    });

    await expectStableQuickSortShell(page);
    await expectOnlyBoundedRegionsScroll(page);
    if (runtime === 'standalone') {
      expect(await page.evaluate(() => (
        window.matchMedia('(display-mode: standalone)').matches
        && Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
      ))).toBe(true);
    } else {
      expect(await page.evaluate(() => (
        (window as Window & { isMCNativeApp?: boolean }).isMCNativeApp === true
      ))).toBe(true);
    }
  });
}

for (const viewport of [
  { name: 'short portrait', width: 390, height: 667, safeAreaTop: 47, safeAreaBottom: 34 },
  { name: 'landscape-style', width: 620, height: 390, safeAreaTop: 12, safeAreaBottom: 21 },
]) {
  test(`${viewport.name} keeps route scrolling bounded and controls visible`, async ({ page }) => {
    await openPriorityQueue(page, {
      viewport,
      safeAreaTop: viewport.safeAreaTop,
      safeAreaBottom: viewport.safeAreaBottom,
    });

    await expectStableQuickSortShell(page);
    await expect(page.getByTestId('quick-sort-swipe-handle')).toBeInViewport();
    expect(await page.getByRole('region', { name: 'Task details' }).evaluate(
      (element) => element.clientHeight,
    )).toBeGreaterThanOrEqual(44);
    await expectOnlyBoundedRegionsScroll(page);
    await expectComfortableTouchTargets(page);
  });
}

test('every visible Quick Sort control keeps a 44px touch target on iPhone 16 Pro Max', async ({ page }) => {
  await openPriorityQueue(page);
  await expectComfortableTouchTargets(page);

  await page.getByRole('button', { name: /Do first/ }).click();
  await expect(page.getByRole('heading', { name: 'Next task' })).toBeVisible();
  await expectComfortableTouchTargets(page);
});

test('landscape swaps the queue order control into the header instead of dropping it', async ({ page }) => {
  await openPriorityQueue(page, {
    viewport: { width: 620, height: 390 },
    safeAreaTop: 12,
    safeAreaBottom: 21,
  });

  const layout = await page.evaluate(() => {
    const landscapeOrder = document.querySelector<HTMLElement>('.quick-sort-landscape-order')!;
    const orderRow = document.querySelector<HTMLElement>('.quick-sort-order-row')!;
    return {
      landscapeOrderDisplay: getComputedStyle(landscapeOrder).display,
      landscapeOrderControls: landscapeOrder.querySelectorAll('button, [role="button"]').length,
      orderRowDisplay: getComputedStyle(orderRow).display,
    };
  });

  expect(layout.landscapeOrderDisplay).not.toBe('none');
  expect(layout.landscapeOrderControls).toBeGreaterThan(0);
  expect(layout.orderRowDisplay).toBe('none');
  await expectStableQuickSortShell(page);
});

async function expectComfortableTouchTargets(page: Page) {
  const undersized = await page.evaluate(() => {
    const mode = document.querySelector<HTMLElement>('[data-testid="quick-sort-mode"]')!;
    return Array.from(
      mode.querySelectorAll<HTMLElement>('button, a[href], [role="button"], input, select'),
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return rect.height < 43.5 || rect.width < 43.5;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const label = element.getAttribute('aria-label') || element.textContent || '';
        return `${label.trim().slice(0, 40)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      });
  });
  expect(undersized).toEqual([]);
}

test('button actions still execute without destabilizing the shell', async ({ page }) => {
  await openPriorityQueue(page);
  const operationRequest = page.waitForRequest((request) => (
    request.url().endsWith('/api/tasks/quick-sort/operations')
    && request.method() === 'POST'
  ));

  await page.getByRole('button', { name: /Do first/ }).click();
  const request = await operationRequest;
  expect(JSON.parse(request.postData() ?? '{}').patch).toEqual({
    priority: 'high',
    dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });
  await expect(page.getByRole('heading', { name: 'Next task' })).toBeVisible();
  await expectStableQuickSortShell(page);
});

test('short screens bound overflowing mode actions above the persistent fallbacks', async ({ page }) => {
  await openPriorityQueue(page, {
    viewport: { width: 390, height: 560 },
    safeAreaTop: 47,
    safeAreaBottom: 34,
    queueName: /Add Tags/,
    modeHeadingName: 'Add Tags',
  });

  const actions = page.getByTestId('quick-sort-primary-actions');
  const dimensions = await actions.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await actions.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await actions.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectStableQuickSortShell(page);
  await expectOnlyBoundedRegionsScroll(page);
});

async function dispatchPointer(page: Page, type: string, clientX: number, clientY: number, down: boolean) {
  await page.locator('body').dispatchEvent(type, {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: down ? 1 : 0,
    clientX,
    clientY,
  });
}

const nextFrame = (page: Page) => page.evaluate(() => (
  new Promise((resolve) => { requestAnimationFrame(() => resolve(null)); })
));

test('swipe handle executes a deliberate skip drag', async ({ page }) => {
  await openPriorityQueue(page);
  const operationRequest = page.waitForRequest((request) => (
    request.url().endsWith('/api/tasks/quick-sort/operations')
    && request.method() === 'POST'
  ));
  const handle = page.getByTestId('quick-sort-swipe-handle');
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();

  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await handle.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: centerX,
    clientY: centerY,
  });
  for (let step = 1; step <= 8; step += 1) {
    await dispatchPointer(page, 'pointermove', centerX, centerY - (140 * step) / 8, true);
    await nextFrame(page);
  }
  await dispatchPointer(page, 'pointerup', centerX, centerY - 140, false);

  const request = await operationRequest;
  const body = JSON.parse(request.postData() ?? '{}');
  expect(body.action).toBe('skipped');
  expect(new Date(body.patch.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
  await expect(page.getByRole('heading', { name: 'Next task' })).toBeVisible();
  await expectStableQuickSortShell(page);
});

test('swipe handle executes a fast flick that outruns the pan frame', async ({ page }) => {
  await openPriorityQueue(page);
  const operationRequest = page.waitForRequest((request) => (
    request.url().endsWith('/api/tasks/quick-sort/operations')
    && request.method() === 'POST'
  ));
  const handle = page.getByTestId('quick-sort-swipe-handle');
  const box = (await handle.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  await handle.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: centerX,
    clientY: centerY,
  });
  // A small nudge starts the pan but stays under the axis-lock distance.
  await dispatchPointer(page, 'pointermove', centerX, centerY - 6, true);
  await nextFrame(page);
  // The flick and the lift land inside one frame, so the axis is never locked mid-gesture.
  await dispatchPointer(page, 'pointermove', centerX, centerY - 140, true);
  await dispatchPointer(page, 'pointerup', centerX, centerY - 140, false);

  const request = await operationRequest;
  expect(JSON.parse(request.postData() ?? '{}').action).toBe('skipped');
  await expect(page.getByRole('heading', { name: 'Next task' })).toBeVisible();
  await expectStableQuickSortShell(page);
});

test('swipe handle ignores a diagonal gesture without a dominant axis', async ({ page }) => {
  await openPriorityQueue(page);
  let operationRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/tasks/quick-sort/operations') && request.method() === 'POST') {
      operationRequests += 1;
    }
  });

  const handle = page.getByTestId('quick-sort-swipe-handle');
  const box = (await handle.boundingBox())!;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await handle.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: centerX,
    clientY: centerY,
  });
  await dispatchPointer(page, 'pointermove', centerX - 6, centerY - 6, true);
  await nextFrame(page);
  await dispatchPointer(page, 'pointermove', centerX - 90, centerY - 90, true);
  await nextFrame(page);
  await dispatchPointer(page, 'pointerup', centerX - 90, centerY - 90, false);
  await nextFrame(page);

  await expect(page.getByRole('heading', { name: /Long mobile card content/ })).toBeVisible();
  expect(operationRequests).toBe(0);
  await expectStableQuickSortShell(page);
});
