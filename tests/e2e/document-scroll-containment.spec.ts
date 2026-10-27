import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const viewport of [
  { width: 1600, height: 900 },
  { width: 390, height: 667 },
]) {
  test(`keeps the document stationary and route content scrollable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem('mc_priority_wizard_dismissed', 'true');
      localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
    });
    await page.goto('/settings');
    const shell = page.locator('.app-viewport');
    await expect(shell).toBeVisible();
    await page.waitForFunction(() => (
      Array.from(document.querySelectorAll<HTMLElement>('#main-content *')).some((element) => (
        /(auto|scroll)/.test(getComputedStyle(element).overflowY)
        && element.clientHeight > 0
      ))
    ));

    // Positioned portal content must not create another viewport below the shell.
    await page.evaluate(() => {
      const overflow = document.createElement('div');
      overflow.setAttribute('aria-hidden', 'true');
      overflow.style.cssText = 'position:absolute;top:100%;height:100dvh;width:1px;pointer-events:none';
      document.body.append(overflow);
      window.scrollTo(0, window.innerHeight);
      document.body.scrollTop = window.innerHeight;
    });

    await page.mouse.move(viewport.width - 1, viewport.height / 2);
    await page.mouse.wheel(0, viewport.height);
    await expect.poll(() => page.evaluate(() => ({
      documentScrollRange: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight,
      windowScrollTop: window.scrollY,
      bodyScrollTop: document.body.scrollTop,
    }))).toEqual({ documentScrollRange: 0, windowScrollTop: 0, bodyScrollTop: 0 });
    await expect(shell).toHaveJSProperty('offsetHeight', viewport.height);
    expect((await shell.boundingBox())!.y).toBe(0);

    const scrollable = page.locator('#main-content').locator('*').filter({ visible: true });
    const scrollTarget = await scrollable.evaluateAll((elements) => {
      const index = elements.findIndex((element) => (
        /(auto|scroll)/.test(getComputedStyle(element).overflowY)
        && element.clientHeight > 0
      ));
      if (index >= 0) {
        const content = document.createElement('div');
        content.setAttribute('aria-hidden', 'true');
        content.style.height = '200dvh';
        elements[index].append(content);
        elements[index].scrollTop = 0;
      }
      return index;
    });
    expect(scrollTarget).toBeGreaterThanOrEqual(0);
    const routeScroller = scrollable.nth(scrollTarget);
    await routeScroller.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => routeScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await shell.boundingBox())!.y).toBe(0);

    await page.setViewportSize({ width: viewport.width, height: viewport.height - 150 });
    await expect(shell).toHaveJSProperty('offsetHeight', viewport.height - 150);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
}
