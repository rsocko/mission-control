import { defineConfig, devices } from '@playwright/test';
import { availableParallelism } from 'node:os';

const baseURL = process.env.BASE_URL || 'http://localhost:3099';
const isRemote = baseURL !== 'http://localhost:3099';
const localWorkers = Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : localWorkers,
  reporter: 'html',
  timeout: isRemote ? 60_000 : 30_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only start local dev server when testing against localhost
  ...(isRemote ? {} : {
    webServer: {
      command: 'npm run dev',
      url: 'http://localhost:3099',
      reuseExistingServer: !process.env.CI,
    },
  }),
});
