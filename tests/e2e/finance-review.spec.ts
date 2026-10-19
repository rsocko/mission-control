import { expect, test, type Page } from '@playwright/test';

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
  digest: [],
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

const exception = {
  id: 'exception-one',
  status: 'open',
  reasonCode: 'low-confidence',
  retryable: true,
  reviewState: 'pending',
  policyVersion: 7,
  occurrenceCount: 1,
  firstObservedAt: '2026-10-08T19:00:00.000Z',
  lastObservedAt: '2026-10-08T20:00:00.000Z',
  updatedAt: '2026-10-08T20:00:00.000Z',
  date: '2026-10-08',
  amount: -184.62,
  merchantName: 'Invented Market',
  statementDescriptors: [{
    kind: 'statement',
    text: ' INVENTED  MARKET #1842 ',
    source: { system: 'monarch', field: 'plaidName' },
  }],
  location: {
    evidence: {
      countryCode: 'US',
      region: 'WA',
      locality: 'Seattle',
      confidence: 0.88,
      sourceKind: 'private-ai-inference',
      model: 'private-finance-model',
      modelVersion: 'test-v1',
      evaluatedAt: '2026-10-08T20:00:00.000Z',
      staleAfter: '2027-01-06T20:00:00.000Z',
    },
    inferenceEvidence: 'Descriptor contains Seattle WA.',
    errorCode: null,
  },
  categoryId: 'category-groceries',
  categoryName: 'Groceries',
  accountName: 'Household card',
  cardLast4: '4242',
  assignedKidId: null,
  attributionStatus: 'unassigned',
  confidence: 'likely',
  method: 'merchant-rule',
  explanation: 'Two current rules produced similar matches.',
  reasons: ['low-confidence'],
  decisionSource: 'automated',
  engineVersion: '2.1.0',
  evaluatedAt: '2026-10-08T20:00:00.000Z',
};

async function mockReview(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');
    localStorage.setItem('mission-control:pwa-install-dismissed', Date.now().toString());
  });
  await page.route('**/api/finance/overview', async (route) => {
    await route.fulfill({ json: overview });
  });
  await page.route('**/api/connectors/finance-one/finance/attribution-exceptions?**', async (route) => {
    await route.fulfill({
      json: {
        exceptions: [exception],
        nextCursor: null,
        subjects: [{ kidId: 'kid-one', name: 'Alex' }],
        categories: [{ id: 'category-groceries', name: 'Groceries', groupName: 'Food' }],
      },
    });
  });
}

test('attribution exception detail shows exact transaction evidence', async ({ page }) => {
  await mockReview(page);
  await page.goto('/finance/review');

  await expect(page.getByRole('heading', { name: 'Attribution exception review' })).toBeVisible();
  const descriptor = page.getByRole('region', { name: 'Statement descriptors' }).locator('dd');
  await expect(descriptor).toHaveClass(/whitespace-pre-wrap/);
  expect(await descriptor.textContent()).toBe(' INVENTED  MARKET #1842 ');
  await expect(page.getByText('Seattle, WA, US')).toBeVisible();
  await expect(page.getByText(/88% confidence · Private AI · private-finance-model/)).toBeVisible();
  await expect(page.getByText('Evidence: Descriptor contains Seattle WA.')).toBeVisible();
});
