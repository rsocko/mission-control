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
  await page.evaluate((scrollRatio) => {
    const scrollingElement = document.scrollingElement;
    const scrollables = [
      ...(scrollingElement ? [scrollingElement] : []),
      ...Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => {
        const { overflowY } = getComputedStyle(element);
        return /(auto|scroll)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      }),
    ];

    for (const element of scrollables) {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * scrollRatio;
    }
  }, ratio);
  await page.waitForTimeout(100);
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

for (const route of routes) {
  test(`${route} reserves the full bottom navigation safe area`, async ({ browserName, page }) => {
    expect(browserName).toBe('webkit');
    await page.goto(route);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
    });

    const main = page.locator('#main-content');
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(main).toBeVisible();
    await expect(nav).toBeVisible();

    const geometry = await page.evaluate(() => {
      const mainElement = document.querySelector<HTMLElement>('#main-content')!;
      const navElement = document.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]')!;
      const mainRect = mainElement.getBoundingClientRect();
      const navRect = navElement.getBoundingClientRect();
      const paddingBottom = Number.parseFloat(getComputedStyle(mainElement).paddingBottom);

      return {
        contentBottom: mainRect.bottom - paddingBottom,
        navHeight: navRect.height,
        navTop: navRect.top,
        paddingBottom,
      };
    });

    expect(geometry.navHeight).toBeCloseTo(91, 0);
    expect(geometry.paddingBottom).toBeCloseTo(geometry.navHeight, 0);
    expect(geometry.contentBottom).toBeLessThanOrEqual(geometry.navTop + 0.5);

    for (const ratio of [0, 0.5, 1]) {
      await setScrollPosition(page, ratio);
      expect(await getInteractiveNavOverlaps(page), `route ${route} at scroll ratio ${ratio}`).toEqual([]);
    }
  });
}
