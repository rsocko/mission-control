/**
 * Documentation screenshot capture suite for Mission Control.
 *
 * Generates named screenshots for each major view/feature against
 * the demo Docker container (mc-docs-demo on port 3098).
 *
 * Run:
 *   npm run docs:screenshots          (full pipeline: build, start, capture, teardown)
 *   npm run docs:screenshots:capture  (capture only — container must be running)
 *
 * The suite:
 * 1. Seeds demo data via POST /api/settings/mode { action: "reset-demo" }
 * 2. Navigates each route and waits for content to render
 * 3. Captures full-page screenshots to docs/assets/screenshots/
 * 4. Generates a manifest.json for doc tooling
 */

import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocScreen {
  /** Filename (without extension) — becomes the screenshot file name */
  name: string;
  /** Route to navigate to */
  route: string;
  /** Selector to wait for before capturing (ensures content is rendered) */
  waitFor?: string;
  /** Viewport override for this specific capture */
  viewport?: { width: number; height: number };
  /** Human description for the manifest and doc generation */
  description: string;
  /** Which doc page this screenshot belongs to */
  docPage?: string;
  /** Custom setup function (e.g., click into a sub-view, open a panel) */
  setup?: (page: Page) => Promise<void>;
}

// ─── Screenshot Manifest ────────────────────────────────────────────────────
//
// Add new entries here when new features/views are added.
// Each entry produces one PNG in docs/assets/screenshots/.

const SCREENS: DocScreen[] = [
  // ── Dashboard ──────────────────────────────────────────────────────────
  {
    name: 'dashboard',
    route: '/',
    waitFor: 'h1:has-text("Mission Control")',
    description: 'Main dashboard — unified task list with sidebar filters, KPI bar, and task rows',
    docPage: 'docs/features/dashboard.md',
  },

  // ── My Day ─────────────────────────────────────────────────────────────
  {
    name: 'my-day',
    route: '/today',
    waitFor: 'text=My Day',
    description: 'My Day view — focused daily planner with scheduled tasks and AI suggestions sidebar',
    docPage: 'docs/features/my-day.md',
  },

  // ── Triage ─────────────────────────────────────────────────────────────
  {
    name: 'triage',
    route: '/triage',
    waitFor: 'text=Triage',
    description: 'Triage queue — content routing inbox with filter sidebar and item cards',
    docPage: 'docs/features/triage.md',
  },

  // ── Kanban ─────────────────────────────────────────────────────────────
  {
    name: 'kanban',
    route: '/kanban',
    waitFor: 'text=Kanban',
    description: 'Kanban board — drag-and-drop columns with task cards',
    docPage: 'docs/features/kanban.md',
  },

  // ── Projects (Portfolio) ───────────────────────────────────────────────
  {
    name: 'projects',
    route: '/projects',
    waitFor: 'text=Projects',
    description: 'Projects hub — portfolio overview with progress bars and health indicators',
    docPage: 'docs/features/projects.md',
  },

  // ── Goals & Ideas ──────────────────────────────────────────────────────
  {
    name: 'goals',
    route: '/goals',
    waitFor: 'text=Goals',
    description: 'Goals & Ideas — tag-based smart view with filter chips and goal cards',
    docPage: 'docs/features/goals.md',
  },

  // ── Timeline ───────────────────────────────────────────────────────────
  {
    name: 'timeline',
    route: '/timeline',
    waitFor: 'text=Timeline',
    description: 'Timeline — calendar view with task due date indicators',
    docPage: 'docs/features/timeline.md',
  },

  // ── Routines ───────────────────────────────────────────────────────────
  {
    name: 'routines',
    route: '/routines',
    waitFor: 'text=Routines',
    description: 'Routines — habit tracking with weekly grid and routine cards',
    docPage: 'docs/features/routines.md',
  },

  // ── Insights ───────────────────────────────────────────────────────────
  {
    name: 'insights',
    route: '/insights',
    waitFor: 'text=Insights',
    description: 'Insights — analytics dashboard with trend charts and AI observations',
    docPage: 'docs/features/insights.md',
  },

  // ── AI Assistant ───────────────────────────────────────────────────────
  {
    name: 'ai-assistant',
    route: '/ai',
    waitFor: 'text=Chat',
    description: 'AI Assistant — chat interface with tab navigation (Chat, Agents, Insights)',
    docPage: 'docs/features/ai-assistant.md',
  },

  // ── Settings ───────────────────────────────────────────────────────────
  {
    name: 'settings',
    route: '/settings',
    waitFor: 'text=Settings',
    description: 'Settings — connector configuration, app mode, AI provider setup',
  },

  // ── Mobile Viewport (Dashboard) ───────────────────────────────────────
  {
    name: 'dashboard-mobile',
    route: '/',
    waitFor: 'h1:has-text("Mission Control")',
    viewport: { width: 390, height: 844 },
    description: 'Dashboard on mobile viewport — responsive layout with hamburger nav',
    docPage: 'docs/features/dashboard.md',
  },
];

// ─── Config ─────────────────────────────────────────────────────────────────

const SCREENSHOT_DIR = path.resolve(__dirname, '../../docs/assets/screenshots');

// ─── Setup ──────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

// Seed demo data before the suite runs (ensures fresh, consistent data)
test('seed demo data', async ({ request }) => {
  const response = await request.post('/api/settings/mode', {
    data: { action: 'reset-demo' },
  });
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.success).toBe(true);

  // Allow seed data to fully propagate
  await new Promise((resolve) => setTimeout(resolve, 2000));
});

// ─── Capture Loop ───────────────────────────────────────────────────────────

for (const screen of SCREENS) {
  test(`capture: ${screen.name}`, async ({ page }) => {
    // Apply viewport override if specified
    if (screen.viewport) {
      await page.setViewportSize(screen.viewport);
    }

    // Navigate and wait for content
    await page.goto(screen.route);
    await page.waitForLoadState('networkidle');

    if (screen.waitFor) {
      await page.waitForSelector(screen.waitFor, { timeout: 15_000 });
    }

    // Run custom setup if provided (e.g., clicking into a sub-view)
    if (screen.setup) {
      await screen.setup(page);
    }

    // Allow animations to settle (reduced-motion is on, but layout shifts may occur)
    await page.waitForTimeout(1500);

    // Hide the demo mode banner for cleaner screenshots
    await page.evaluate(() => {
      const banner = document.querySelector('.bg-amber-900\\/30');
      if (banner) (banner as HTMLElement).style.display = 'none';
    });

    const screenshotPath = path.join(SCREENSHOT_DIR, `${screen.name}.png`);
    await page.screenshot({
      path: screenshotPath,
      fullPage: false,
    });

    expect(fs.existsSync(screenshotPath)).toBe(true);
  });
}

// ─── Manifest Generation ────────────────────────────────────────────────────

test('generate manifest', async () => {
  const manifest = {
    generated_at: new Date().toISOString(),
    generator: 'playwright.docs.config.ts',
    screenshot_dir: 'docs/assets/screenshots',
    screens: SCREENS.map((s) => ({
      name: s.name,
      file: `docs/assets/screenshots/${s.name}.png`,
      route: s.route,
      description: s.description,
      doc_page: s.docPage ?? null,
      viewport: s.viewport ?? { width: 1440, height: 900 },
    })),
  };

  const manifestPath = path.join(SCREENSHOT_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  expect(fs.existsSync(manifestPath)).toBe(true);
});
