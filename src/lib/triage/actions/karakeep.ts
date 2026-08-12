import type { TriageItem } from '@/types';
import { resolveKarakeepCredentials } from '../credentials';
import logger from '@/lib/logger';

export interface KarakeepBookmarkResult {
  success: boolean;
  bookmarkId?: string;
  error?: string;
}

interface KarakeepBookmarkPayload {
  type: 'link';
  url: string;
  title?: string;
  tags?: string[];
  listId?: string;
}

/** Map content type / AI categories to a Karakeep list name. */
function inferListName(item: TriageItem): string | undefined {
  if (item.contentType === 'model_3d') return '3D Printing';
  if (item.contentType === 'repo') return 'Development';

  const cats = item.aiCategories.map((c) => c.toLowerCase());
  if (cats.some((c) => c.includes('3d') || c.includes('print'))) return '3D Printing';
  if (cats.some((c) => c.includes('dev') || c.includes('code') || c.includes('programming'))) return 'Development';
  if (cats.some((c) => c.includes('homelab') || c.includes('self-host'))) return 'Homelab';

  return undefined;
}

/** Derive Karakeep tags from the triage item's AI categories. */
function inferTags(item: TriageItem): string[] {
  const tags = new Set<string>();

  for (const cat of item.aiCategories) {
    tags.add(cat.toLowerCase().replace(/\s+/g, '-'));
  }

  // Add source platform as a tag
  if (item.sourcePlatform) {
    tags.add(`source:${item.sourcePlatform}`);
  }

  return Array.from(tags);
}

/**
 * Look up (or create) a list by name and return its id.
 * Returns undefined if the list cannot be resolved.
 */
async function resolveListId(
  baseUrl: string,
  apiKey: string,
  listName: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/lists`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Failed to fetch Karakeep lists');
      return undefined;
    }
    const data = await res.json() as { lists?: Array<{ id: string; name: string }> };
    const lists = data.lists ?? [];
    const match = lists.find((l) => l.name.toLowerCase() === listName.toLowerCase());
    return match?.id;
  } catch (err) {
    logger.warn({ err }, 'Error resolving Karakeep list');
    return undefined;
  }
}

/**
 * Save a triage item as a Karakeep bookmark.
 *
 * @param item     The triage item to save
 * @param overrides Optional tag/list overrides from the caller
 */
export async function saveToKarakeep(
  item: TriageItem,
  overrides?: { tags?: string[]; list?: string },
): Promise<KarakeepBookmarkResult> {
  const creds = await resolveKarakeepCredentials();
  if (!creds) {
    return { success: false, error: 'Karakeep credentials not configured (set MC_KARAKEEP_URL and MC_KARAKEEP_API_KEY)' };
  }

  const url = item.canonicalUrl || item.sourceUrl;
  if (!url) {
    return { success: false, error: 'Triage item has no URL to bookmark' };
  }

  const tags = overrides?.tags ?? inferTags(item);
  const listName = overrides?.list ?? inferListName(item);

  const payload: KarakeepBookmarkPayload = {
    type: 'link',
    url,
    title: item.title || undefined,
    tags: tags,
  };

  // Resolve list id if a list name was determined
  if (listName) {
    const listId = await resolveListId(creds.url, creds.apiKey, listName);
    if (listId) {
      payload.listId = listId;
    } else {
      logger.info({ listName }, 'Karakeep list not found, saving without list assignment');
    }
  }

  try {
    const res = await fetch(`${creds.url}/api/v1/bookmarks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body }, 'Karakeep bookmark creation failed');
      return { success: false, error: `Karakeep API returned ${res.status}: ${body}` };
    }

    const result = await res.json() as { id?: string };
    logger.info({ bookmarkId: result.id, url }, 'Saved triage item to Karakeep');
    return { success: true, bookmarkId: result.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Karakeep API request failed');
    return { success: false, error: `Karakeep API request failed: ${message}` };
  }
}
