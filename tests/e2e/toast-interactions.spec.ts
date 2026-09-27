import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let fixture: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Toaster } from '@/components/ui/toaster';
        import { ToastSettingsCard } from '@/components/settings/ToastSettingsCard';
        import { toast } from '@/lib/toast';
        function Fixture() {
          const [expanded, setExpanded] = React.useState(false);
          return <>
            <nav data-toast-nav={expanded ? 'expanded' : 'collapsed'}
              style={{ position: 'fixed', inset: '0 auto 0 0', width: expanded ? 200 : 64, background: 'Canvas' }} />
            <main style={{ marginLeft: 224 }}>
              <button onClick={() => toast.success('Saved', { duration: Infinity })}>Notify</button>
              <button onClick={() => toast.success('Routine')}>Routine</button>
              <button onClick={() => toast.error('Failed')}>Error</button>
              <button onClick={() => setExpanded(!expanded)}>Toggle rail</button>
              <input aria-label="Quick Add" style={{ position: 'fixed', top: 16, left: '40%' }} />
              <p id="selectable">Previously selected page text</p>
              <ToastSettingsCard />
            </main>
            <Toaster />
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
      loader: 'tsx',
      resolveDir: process.cwd(),
    },
    tsconfig: path.resolve('tsconfig.json'),
    bundle: true,
    write: false,
    outdir: 'toast-fixture',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
  fixture = `<!doctype html><html><head><style>
    :root { --surface-2: Canvas; --border-strong: GrayText; --text-primary: CanvasText; --radius-lg: 8px; }
    body { background: Canvas; color: CanvasText; font-family: sans-serif; }
    ${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
});

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.route('http://toast.test/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('http://toast.test/');
});

async function showToast(page: Page) {
  await page.getByRole('button', { name: 'Notify', exact: true }).click();
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast).toBeVisible();
  // Wait for the entry transform, so real pointer coordinates hit the toast body.
  await expect(toast).toHaveCSS('opacity', '1');
  return toast;
}

test('placement clears both rail states and does not cover Quick Add', async ({ page }) => {
  const toast = await showToast(page);
  await expect(toast).toHaveAttribute('data-x-position', 'left');
  await expect.poll(async () => (await toast.boundingBox())?.x).toBe(88);
  await page.getByRole('button', { name: 'Toggle rail' }).click();
  await expect.poll(async () => (await toast.boundingBox())?.x).toBe(224);
  await page.getByRole('textbox', { name: 'Quick Add' }).fill('Important task');
  await expect(page.getByRole('textbox', { name: 'Quick Add' })).toHaveValue('Important task');
});

for (const pointer of ['mouse', 'touch'] as const) {
  for (const [direction, dx, dy] of [
    ['left', -100, 0], ['right', 100, 0], ['up', 0, -100], ['down', 0, 50],
  ] as const) {
    test(`${pointer} ${direction} drag dismisses on desktop`, async ({ page }) => {
      const toast = await showToast(page);
      const box = (await toast.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (pointer === 'mouse') {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, { steps: 10 });
        await page.mouse.up();
      } else {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 10; step++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10 }],
          });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      }
      await expect(toast).toHaveCount(0);
    });
  }
}

test('X is keyboard operable and settings persist across reload', async ({ page }) => {
  const toast = await showToast(page);
  await page.getByRole('button', { name: 'Close toast' }).focus();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Desktop position' }).click();
  await page.getByRole('option', { name: 'Top-right', exact: true }).click();
  await page.getByRole('combobox', { name: 'Toast volume' }).click();
  await page.getByRole('option', { name: 'Errors only (plus warnings and actions)' }).click();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Desktop position' })).toContainText('Top-right');
  await page.getByRole('button', { name: 'Routine', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Error', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]')).toHaveAttribute('data-x-position', 'right');
  await expect(page.locator('[data-sonner-toast]')).toHaveAttribute('data-y-position', 'top');
});

test('dragging a toast works after selecting page text', async ({ page }) => {
  const toast = await showToast(page);
  await page.locator('#selectable').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  const box = (await toast.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(toast).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
});
