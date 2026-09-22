import { NextResponse } from 'next/server';
import type { PersistenceJson } from '@/db/persistence/contracts';
import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import { hasValidTriageCaptureKey } from '@/lib/triage/capture-auth';
import logger from '@/lib/logger';

/**
 * Extension scrape-config scaffolding (#355 follow-up, goal 3).
 *
 * The browser extension's per-platform content scripts (reddit-import.js,
 * instagram-import.js, facebook-import.js, tiktok-import.js,
 * pinterest-import.js) already do client-side multi-item scraping — each
 * currently hardcodes its own pacing/volume constants (e.g. `IG_MAX_PAGES`,
 * `IG_BATCH_SIZE` in instagram-import.js). This endpoint is scaffolding for
 * making those knobs Settings-driven instead of hardcoded.
 *
 * Design (not yet wired into the extension — see PR description):
 *   1. Each content script would call `GET /api/triage/extension-config`
 *      (authenticated the same way as `/api/triage/capture` and
 *      `/api/triage/import/bulk`, via `x-triage-capture-key`) once at the
 *      start of a scrape run, instead of reading its local hardcoded consts.
 *   2. The response's `platforms.<id>.enabled` flag would let a user disable
 *      scraping for a given platform from Settings without disabling/
 *      reinstalling the whole extension.
 *   3. `maxPages`/`batchSize` would replace the hardcoded pagination/batch
 *      constants in each `*-import.js` file (for facebook, `maxPages` maps
 *      to its scroll-round budget rather than an API page count, since it
 *      scrapes via DOM scrolling instead of a paginated API).
 *   4. `includedLists`/`excludedLists` are placeholders for scoping which
 *      saved collections/boards/lists a platform scrapes (e.g. specific
 *      Pinterest boards or TikTok collections) — the content scripts don't
 *      currently support this and would need small follow-up changes to
 *      read and honor it.
 *
 * This GET is extension-facing (capture-key authed, matching
 * `/api/triage/capture`/`/api/triage/import/bulk`); PUT is Settings-facing.
 */

const SETTINGS_KEY = 'triage_extension_scrape_config';

export interface PlatformScrapeConfig {
  enabled: boolean;
  maxPages: number;
  batchSize: number;
  includedLists: string[];
  excludedLists: string[];
}

export type ExtensionScrapePlatform = 'reddit' | 'instagram' | 'facebook' | 'tiktok' | 'pinterest';

export interface ExtensionScrapeConfig {
  platforms: Record<ExtensionScrapePlatform, PlatformScrapeConfig>;
}

// Defaults mirror each content script's current hardcoded constants.
const DEFAULT_CONFIG: ExtensionScrapeConfig = {
  platforms: {
    reddit: { enabled: true, maxPages: 50, batchSize: 25, includedLists: [], excludedLists: [] },
    instagram: { enabled: true, maxPages: 50, batchSize: 25, includedLists: [], excludedLists: [] },
    facebook: { enabled: true, maxPages: 60, batchSize: 25, includedLists: [], excludedLists: [] },
    tiktok: { enabled: true, maxPages: 100, batchSize: 25, includedLists: [], excludedLists: [] },
    pinterest: { enabled: true, maxPages: 100, batchSize: 25, includedLists: [], excludedLists: [] },
  },
};

const PLATFORM_IDS: ExtensionScrapePlatform[] = ['reddit', 'instagram', 'facebook', 'tiktok', 'pinterest'];

async function loadConfig(): Promise<ExtensionScrapeConfig> {
  try {
    const value = await (
      await getCorePersistenceRepositoriesForBackend()
    ).settings.get(SETTINGS_KEY);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const stored = value as Partial<ExtensionScrapeConfig>;
      const platforms = {} as ExtensionScrapeConfig['platforms'];
      for (const id of PLATFORM_IDS) {
        platforms[id] = { ...DEFAULT_CONFIG.platforms[id], ...stored.platforms?.[id] };
      }
      return { platforms };
    }
  } catch {
    // table may not exist yet
  }
  return structuredClone(DEFAULT_CONFIG);
}

export async function GET(request: Request) {
  try {
    if (!hasValidTriageCaptureKey(request)) {
      return NextResponse.json({ error: 'Unauthorized extension-config request' }, { status: 401 });
    }
    const config = await loadConfig();
    return NextResponse.json({ config });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load extension scrape config');
    return NextResponse.json({ error: 'Failed to load extension scrape config' }, { status: 500 });
  }
}

/**
 * PUT — Settings-facing update, same partial-merge pattern as
 * `/api/triage/auto-sync`. Body: { platforms: { instagram: { maxPages: 30 } } }
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as Partial<ExtensionScrapeConfig>;

    if (body.platforms) {
      for (const [platformId, cfg] of Object.entries(body.platforms)) {
        if (!PLATFORM_IDS.includes(platformId as ExtensionScrapePlatform)) {
          return NextResponse.json({ error: `Unknown platform: ${platformId}` }, { status: 400 });
        }
        if (cfg.maxPages !== undefined && (typeof cfg.maxPages !== 'number' || cfg.maxPages < 1 || cfg.maxPages > 500)) {
          return NextResponse.json({ error: 'maxPages must be between 1 and 500' }, { status: 400 });
        }
        if (cfg.batchSize !== undefined && (typeof cfg.batchSize !== 'number' || cfg.batchSize < 1 || cfg.batchSize > 100)) {
          return NextResponse.json({ error: 'batchSize must be between 1 and 100' }, { status: 400 });
        }
      }
    }

    const current = await loadConfig();
    const platforms = {} as ExtensionScrapeConfig['platforms'];
    for (const id of PLATFORM_IDS) {
      platforms[id] = { ...current.platforms[id], ...body.platforms?.[id] };
    }
    const merged: ExtensionScrapeConfig = { platforms };

    const storedPlatforms: { [key: string]: PersistenceJson } = {};
    for (const id of PLATFORM_IDS) {
      const config = merged.platforms[id];
      storedPlatforms[id] = {
        enabled: config.enabled,
        maxPages: config.maxPages,
        batchSize: config.batchSize,
        includedLists: [...config.includedLists],
        excludedLists: [...config.excludedLists],
      };
    }
    const storedConfig: PersistenceJson = { platforms: storedPlatforms };
    await (
      await getCorePersistenceRepositoriesForBackend()
    ).settings.set(SETTINGS_KEY, storedConfig);

    return NextResponse.json({ config: merged });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update extension scrape config');
    return NextResponse.json({ error: 'Failed to update extension scrape config' }, { status: 500 });
  }
}
