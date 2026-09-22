import { devices, expect, test, type Page } from '@playwright/test';

test.use({
  ...devices['iPhone 16 Pro Max'],
  browserName: 'webkit',
  serviceWorkers: 'block',
});

const routes = [
  '/',
  '/today',
  '/triage',
  '/capture',
  '/quick-sort',
  '/ai',
  '/all-tasks',
  '/projects',
  '/graph',
  '/goals',
  '/notifications',
  '/routines',
  '/insights',
  '/settings',
  '/kanban',
  '/doc-intelligence',
  '/timeline',
];

async function setScrollPosition(page: Page, ratio: number) {
  return page.evaluate((scrollRatio) => {
    const scrollables = Array.from(
      document.querySelectorAll<HTMLElement>('#main-content *'),
    ).filter((element) => {
      const { overflowY } = getComputedStyle(element);
      return /(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
    });

    for (const element of scrollables) {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * scrollRatio;
    }
    return scrollables.length;
  }, ratio);
}

async function applySafeAreaInsets(page: Page, top = 47, bottom = 34) {
  await page.evaluate(({ topInset, bottomInset }) => {
    document.documentElement.style.setProperty('--safe-area-inset-top', `${topInset}px`);
    document.documentElement.style.setProperty('--safe-area-inset-bottom', `${bottomInset}px`);
  }, { topInset: top, bottomInset: bottom });
  await page.waitForTimeout(100);
}

async function getShellGeometry(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.app-viewport')!;
    const header = document.querySelector<HTMLElement>('[data-mobile-shell-header]')!;
    const main = document.querySelector<HTMLElement>('#main-content')!;
    const nav = document.querySelector<HTMLElement>('[data-mobile-shell-nav]')!;
    const menuButton = header.querySelector<HTMLElement>('button')!;
    const navLinks = Array.from(nav.querySelectorAll<HTMLElement>('a'));
    const shellRect = shell.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const menuRect = menuButton.getBoundingClientRect();
    const scrollingElement = document.scrollingElement!;

    return {
      viewportHeight: window.innerHeight,
      shellTop: shellRect.top,
      shellBottom: shellRect.bottom,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      headerPaddingTop: Number.parseFloat(getComputedStyle(header).paddingTop),
      menuTop: menuRect.top,
      mainTop: mainRect.top,
      mainBottom: mainRect.bottom,
      mainOverflowY: getComputedStyle(main).overflowY,
      mainPaddingBottom: Number.parseFloat(getComputedStyle(main).paddingBottom),
      navTop: navRect.top,
      navBottom: navRect.bottom,
      navHeight: navRect.height,
      navPaddingBottom: Number.parseFloat(getComputedStyle(nav).paddingBottom),
      navPosition: getComputedStyle(nav).position,
      lowestNavControlBottom: Math.max(...navLinks.map((link) => link.getBoundingClientRect().bottom)),
      documentScrollRange: scrollingElement.scrollHeight - scrollingElement.clientHeight,
      documentScrollTop: scrollingElement.scrollTop,
    };
  });
}

async function getInteractiveNavOverlaps(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]');
    if (!nav) return ['Mobile navigation is missing'];

    const navRect = nav.getBoundingClientRect();
    const selector = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => !nav.contains(element))
      .flatMap((element) => {
        const style = getComputedStyle(element);
        if (
          style.display === 'none'
          || style.visibility === 'hidden'
          || Number(style.opacity) === 0
          || element.closest('[aria-hidden="true"]')
        ) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        let top = Math.max(rect.top, 0);
        let bottom = Math.min(rect.bottom, window.innerHeight);

        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (/(auto|scroll|hidden|clip)/.test(ancestorStyle.overflowY)) {
            const ancestorRect = ancestor.getBoundingClientRect();
            top = Math.max(top, ancestorRect.top);
            bottom = Math.min(bottom, ancestorRect.bottom);
          }
        }

        if (bottom <= top || bottom <= navRect.top + 0.5 || top >= navRect.bottom - 0.5) {
          return [];
        }

        const label = element.getAttribute('aria-label')
          || element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80)
          || element.tagName.toLowerCase();
        return [`${element.tagName.toLowerCase()} "${label}" (${Math.round(top)}-${Math.round(bottom)})`];
      });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });
});

test('desktop does not reserve the mobile navigation area', async ({ browserName, page }) => {
  expect(browserName).toBe('webkit');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
  });

  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeHidden();
  await expect(page.locator('#main-content')).toHaveCSS('padding-bottom', '0px');
});

test('mobile drawer applies the top safe area once and returns focus after exit', async ({ browserName, page }) => {
  expect(browserName).toBe('webkit');
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-inset-top', '47px');
  });

  const menuButton = page.getByRole('button', { name: /^Open menu/ });
  await menuButton.focus();
  await page.keyboard.press('Enter');

  const drawer = page.getByRole('navigation', { name: 'Drawer navigation' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveCSS('padding-top', '47px');
  await expect(page.getByPlaceholder('Search…')).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(drawer).toBeHidden();
  await expect(menuButton).toBeFocused();
});

for (const viewport of [
  { name: 'short iPhone', width: 375, height: 667 },
  { name: 'tall iPhone', width: 430, height: 932 },
]) {
  test(`${viewport.name} keeps chrome stationary while route content scrolls`, async ({ browserName, page }) => {
    expect(browserName).toBe('webkit');
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/settings');
    await applySafeAreaInsets(page);
    await page.waitForFunction(() => (
      Array.from(document.querySelectorAll<HTMLElement>('#main-content *')).some((element) => {
        const { overflowY } = getComputedStyle(element);
        return /(auto|scroll)/.test(overflowY)
          && element.scrollHeight > element.clientHeight + 1;
      })
    ));

    const before = await getShellGeometry(page);
    const routeScrollTop = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('#main-content *'),
      )
        .filter((element) => {
          const { overflowY } = getComputedStyle(element);
          return /(auto|scroll)/.test(overflowY)
            && element.scrollHeight > element.clientHeight + 1;
        })
        .sort((left, right) => right.clientHeight - left.clientHeight);
      const element = candidates[0];
      if (!element) return 0;
      element.scrollTop = Math.min(300, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(100);
    const after = await getShellGeometry(page);

    expect(routeScrollTop).toBeGreaterThan(0);
    expect(after.shellTop).toBeCloseTo(0, 0);
    expect(after.shellBottom).toBeCloseTo(viewport.height, 0);
    expect(after.headerTop).toBeCloseTo(before.headerTop, 0);
    expect(after.headerBottom).toBeCloseTo(before.headerBottom, 0);
    expect(after.navTop).toBeCloseTo(before.navTop, 0);
    expect(after.navBottom).toBeCloseTo(before.navBottom, 0);
    expect(after.documentScrollRange).toBeLessThanOrEqual(1);
    expect(after.documentScrollTop).toBe(0);
  });
}

for (const route of routes) {
  test(`${route} keeps content between safe-area-aware shell chrome`, async ({ browserName, page }) => {
    expect(browserName).toBe('webkit');
    await page.goto(route);
    await applySafeAreaInsets(page);

    const main = page.locator('#main-content');
    const header = page.locator('[data-mobile-shell-header]');
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(main).toBeVisible();
    await expect(header).toBeVisible();
    await expect(nav).toBeVisible();

    const geometry = await getShellGeometry(page);
    expect(geometry.headerPaddingTop).toBeCloseTo(47, 0);
    expect(geometry.menuTop).toBeGreaterThanOrEqual(47);
    expect(geometry.navHeight).toBeCloseTo(91, 0);
    expect(geometry.navPaddingBottom).toBeCloseTo(34, 0);
    expect(geometry.navPosition).toBe('relative');
    expect(geometry.lowestNavControlBottom).toBeLessThanOrEqual(geometry.viewportHeight - 34 + 0.5);
    expect(geometry.mainPaddingBottom).toBe(0);
    expect(geometry.mainOverflowY).toBe('hidden');
    expect(geometry.mainBottom).toBeCloseTo(geometry.navTop, 0);
    expect(geometry.navBottom).toBeCloseTo(geometry.viewportHeight, 0);
    expect(geometry.documentScrollRange).toBeLessThanOrEqual(1);

    for (const ratio of [0, 0.5, 1]) {
      await setScrollPosition(page, ratio);
      expect(await getInteractiveNavOverlaps(page), `route ${route} at scroll ratio ${ratio}`).toEqual([]);
      const scrolledGeometry = await getShellGeometry(page);
      expect(scrolledGeometry.headerTop).toBeCloseTo(geometry.headerTop, 0);
      expect(scrolledGeometry.navBottom).toBeCloseTo(geometry.navBottom, 0);
    }
  });
}
