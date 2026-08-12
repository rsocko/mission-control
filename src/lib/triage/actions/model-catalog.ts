import type { TriageItem } from '@/types';
import { resolveModelCatalogCredentials } from '../credentials';
import logger from '@/lib/logger';

export interface ModelCatalogResult {
  success: boolean;
  entryId?: string;
  error?: string;
}

export interface ModelCatalogOptions {
  tags?: string[];
  status?: string;
}

type ModelPlatform = 'thingiverse' | 'printables' | 'makerworld' | 'unknown';

const PLATFORM_PATTERNS: Array<{ pattern: RegExp; platform: ModelPlatform }> = [
  { pattern: /thingiverse\.com/i, platform: 'thingiverse' },
  { pattern: /printables\.com/i, platform: 'printables' },
  { pattern: /makerworld\.com/i, platform: 'makerworld' },
];

/** Detect 3D model platform from a URL. */
export function detectModelPlatform(url: string): ModelPlatform {
  for (const { pattern, platform } of PLATFORM_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return 'unknown';
}

/** Derive tags from the triage item's AI categories and detected platform. */
function inferTags(item: TriageItem, platform: ModelPlatform): string[] {
  const tags = new Set<string>();

  tags.add('triage-import');

  if (platform !== 'unknown') {
    tags.add(platform);
  }

  for (const cat of item.aiCategories) {
    tags.add(cat.toLowerCase().replace(/\s+/g, '-'));
  }

  if (item.sourcePlatform) {
    tags.add(`source:${item.sourcePlatform}`);
  }

  return Array.from(tags);
}

/**
 * Save a triage item to the Model Catalog sidecar via its Unified Queue API.
 *
 * POSTs a new entry to the queue in "backlog" state (or overridden status).
 * The Model Catalog sidecar exposes `POST /api/unified-queue/entries`.
 */
export async function saveToModelCatalog(
  item: TriageItem,
  options?: ModelCatalogOptions,
): Promise<ModelCatalogResult> {
  const creds = await resolveModelCatalogCredentials();
  if (!creds) {
    return {
      success: false,
      error: 'Model Catalog not configured (set MC_MODEL_CATALOG_URL)',
    };
  }

  const url = item.canonicalUrl || item.sourceUrl;
  if (!url) {
    return { success: false, error: 'Triage item has no URL to save' };
  }

  const platform = detectModelPlatform(url);
  const tags = options?.tags ?? inferTags(item, platform);

  const payload: Record<string, unknown> = {
    title: item.title || url,
    queue_notes: buildQueueNotes(item, platform),
    state: options?.status || 'backlog',
    source_kind: 'triage',
    source_url: url,
    tags,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }

  try {
    const res = await fetch(
      `${creds.url}/api/unified-queue/entries`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body },
        'Model Catalog queue entry creation failed',
      );
      return {
        success: false,
        error: `Model Catalog API returned ${res.status}: ${body}`,
      };
    }

    const result = (await res.json()) as {
      queue_entry_id?: string;
      id?: string;
    };
    const entryId = result.queue_entry_id || result.id;

    logger.info(
      { entryId, url, platform },
      'Saved triage item to Model Catalog',
    );
    return { success: true, entryId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Model Catalog API request failed');
    return {
      success: false,
      error: `Model Catalog API request failed: ${message}`,
    };
  }
}

/** Build a descriptive note for the queue entry. */
function buildQueueNotes(item: TriageItem, platform: ModelPlatform): string {
  const parts: string[] = [];

  if (item.description) {
    parts.push(item.description);
  }

  if (item.aiSummary) {
    parts.push(`AI Summary: ${item.aiSummary}`);
  }

  if (platform !== 'unknown') {
    parts.push(`Platform: ${platform}`);
  }

  if (item.sourceUrl) {
    parts.push(`Source: ${item.sourceUrl}`);
  }

  if (item.aiCategories.length > 0) {
    parts.push(`Categories: ${item.aiCategories.join(', ')}`);
  }

  return parts.join('\n\n');
}
