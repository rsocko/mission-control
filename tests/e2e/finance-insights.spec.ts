import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const detail = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/fixtures/finance-insights/occurrence-detail.json'),
  'utf8',
)) as Record<string, unknown>;
const summary = structuredClone(detail);
for (const field of [
  'ruleResults',
  'baseline',
  'comparisons',
  'contributors',
  'exclusions',
  'evidence',
  'lifecycleHistory',
  'suppression',
  'availableActions',
]) {
  delete summary[field];
}

const overview = {
  connectors: [{ id: 'finance-one', name: 'Tyrion' }],
  connector: { id: 'finance-one', name: 'Tyrion' },
  attention: {
    total: 1,
    pendingExceptions: 1,
    retryRequested: 0,
    failedWritebacks: 0,
    openAlerts: 0,
  },
  alerts: [],
  subjects: [],
  digest: ['Invented digest remains independently visible'],
  links: {
    monarch: {
      transactions: 'https://app.monarchmoney.com/transactions',
      budgets: 'https://app.monarchmoney.com/plan',
      recurring: 'https://app.monarchmoney.com/recurring',
      reports: 'https://app.monarchmoney.com/reports',
      accounts: 'https://app.monarchmoney.com/accounts',
      investments: 'https://app.monarchmoney.com/investments',
      goals: 'https://app.monarchmoney.com/goals',
      forecasts: 'https://app.monarchmoney.com/plan',
    },
    tyrionConfiguration: 'https://tyrion.example/configuration',
  },
};

const health = {
  overall: 'healthy',
  bridge: { reachable: true, authenticated: true, authState: 'valid', mode: 'live' },
  sync: {
    status: 'succeeded',
    lastSuccessfulSyncAt: '2026-08-10T15:00:00Z',
    freshnessMinutes: 1,
    stale: false,
    lastErrorCode: null,
    activeJob: null,
  },
  attribution: {
    status: 'healthy',
    lastSuccessfulAt: '2026-08-10T15:00:00Z',
    policyVersion: 1,
    engineVersion: 'invented',
  },
  projection: { aggregate: 'fresh', datasets: [] },
};

async function mockFinance(page: Page) {
  await page.route('**/api/finance/overview', (route) => route.fulfill({ json: overview }));
  await page.route('**/api/connectors/*/health', (route) => route.fulfill({ json: health }));
  await page.route('**/api/finance/insights/presentation', (route) => route.fulfill({
    json: {
      contractVersion: '1.0',
      state: 'connected',
      transport: 'live',
      authoritative: true,
      sourceAsOf: '2026-08-10T15:00:00Z',
      collapsedCount: 0,
      items: [summary],
    },
  }));
  await page.route('**/api/finance/insights/occurrence-*', (route) => route.fulfill({
    json: {
      contractVersion: '1.0',
      detail,
      externalLinks: [{
        system: 'monarch',
        label: 'Open Monarch recurring',
        url: 'https://app.monarchmoney.com/recurring',
      }],
    },
  }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });
  await mockFinance(page);
});

test('desktop drawer is deep-linked, scrollable, keyboard-safe, and preserves Finance content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/finance');

  await expect(page.getByText('Invented digest remains independently visible')).toBeVisible();
  const trigger = page.getByRole('button', { name: 'View details' });
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Spending insight details' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/finance\\?insight=${detail.occurrenceId}$`));
  const geometry = await page.getByTestId('finance-insight-drawer-panel').boundingBox();
  expect(geometry).not.toBeNull();
  expect(geometry!.x).toBeGreaterThan(500);
  expect(geometry!.width).toBeLessThan(800);
  await expect(page.getByText('Top contributors')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Monarch recurring' }))
    .toHaveAttribute('href', 'https://app.monarchmoney.com/recurring');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/\/finance$/);
});

test('narrow layout uses a full-screen detail surface and canonical route renders the same detail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/finance');
  await page.getByRole('button', { name: 'View details' }).click();

  const panel = page.getByTestId('finance-insight-drawer-panel');
  await expect(panel).toHaveCSS('width', '390px');
  await expect(panel).toHaveCSS('height', '844px');
  const geometry = await panel.boundingBox();
  expect(geometry).not.toBeNull();
  expect(geometry!.x).toBeLessThan(12);

  await page.goto(`/finance/insights/${detail.occurrenceId}`);
  await expect(page.getByRole('heading', { name: String(detail.headline) })).toBeVisible();
  await expect(page.getByText('Comparisons')).toBeVisible();
  await expect(page.getByText('Supporting evidence')).toBeVisible();
  await expect(page).not.toHaveURL(/finance\/review/);
});
