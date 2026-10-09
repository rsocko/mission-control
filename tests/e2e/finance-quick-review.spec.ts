import { expect, test, type Page } from '@playwright/test';

const item = {
  reviewRef: 'review_ref_1234567890',
  stateToken: 'state_token_123456789',
  date: '2026-10-08',
  amount: -184.62,
  currency: 'USD',
  accountName: 'Household card',
  payee: 'Invented Market',
  category: { id: 'category-groceries', label: 'Groceries' },
  kid: null,
  monarchReview: { status: 'needs-review', assignedTo: 'Parent' },
  whySelected: ['High amount with low Kids attribution confidence.'],
  confidence: { overall: 0.52, kids: 0.31, category: 0.81, payee: 0.64 },
  corrections: {
    kids: [{ id: 'kid-alex', label: 'Alex' }],
    categories: [{ id: 'category-groceries', label: 'Groceries' }],
    payeeSuggestions: ['Invented Market'],
    maySuggestKidRule: true,
  },
  research: {
    recommended: true,
    reason: 'The vendor is unfamiliar and the amount is high.',
    normalizedVendorName: 'Invented Market',
    coarseLocation: { locality: 'Seattle', region: 'WA', countryCode: 'US' },
  },
};

const session = {
  contractVersion: '1.0',
  sessionRef: 'session_ref_123456789',
  resumeToken: 'resume_token_123456789',
  sourceAsOf: '2026-10-08T20:00:00.000Z',
  mode: 'ranked',
  filters: {
    preset: 'impact-confidence',
    startDate: null,
    endDate: null,
    minimumAmount: null,
    maximumAmount: null,
    accountNames: [],
  },
  progress: { reviewed: 0, skipped: 0, total: 3, remaining: 3 },
  current: item,
  accounts: ['Household card', 'Checking'],
};

async function mockReview(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });
  await page.route('**/api/finance/quick-review/session', async (route) => {
    await route.fulfill({ json: session });
  });
  await page.route('**/api/finance/quick-review/actions', async (route) => {
    await route.fulfill({
      json: {
        ...session,
        progress: { reviewed: 1, skipped: 0, total: 3, remaining: 2 },
        current: { ...item, reviewRef: 'review_ref_0987654321' },
      },
    });
  });
}

test('desktop keeps review context, filters, and actions usable', async ({ page }) => {
  await mockReview(page);
  await page.goto('/finance/quick-review');

  await expect(page.getByRole('heading', { name: 'Finance quick review' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invented Market' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm/ })).toBeVisible();
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByLabel('Review mode')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Household card' })).toBeVisible();
  await page.getByRole('button', { name: /Confirm/ }).click();
  await expect(page.getByText('1 reviewed · 0 skipped · 2 left')).toBeVisible();
});

test.describe('mobile', () => {
  test.use({
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });

  test('keeps primary actions in the viewport with touch-sized controls', async ({ page }) => {
    await mockReview(page);
    await page.goto('/finance/quick-review');

    const confirm = page.getByRole('button', { name: /Confirm/ });
    const correct = page.getByRole('button', { name: /Correct/ });
    const skip = page.getByRole('button', { name: /Skip/ });
    await expect(confirm).toBeInViewport();
    await expect(correct).toBeInViewport();
    await expect(skip).toBeInViewport();

    for (const control of [confirm, correct, skip]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }

    await correct.click();
    await expect(page.getByRole('heading', { name: 'Correct transaction' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save correction' })).toBeVisible();
  });
});
