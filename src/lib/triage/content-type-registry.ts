import { randomUUID } from 'crypto';
import db from '@/db';
import { triageContentTypes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';
import type { TriageContentType, TriageSourcePlatform } from '@/types';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface ContentTypeDefinition {
  id: string;
  name: string;
  icon?: string;
  color: string;
  builtin: boolean;
  suppressed: boolean;
  priority: number;
  urlPatterns: string[]; // regex strings
  keywordHints: string[]; // terms to match in title/desc/url
  description?: string;
}

// ─── BUILT-IN CONTENT TYPES ─────────────────────────────────────────────────
// These define the default detection logic. Users can suppress or override them.

const BUILTIN_CONTENT_TYPES: ContentTypeDefinition[] = [
  {
    id: 'repo',
    name: 'GitHub Repos',
    icon: 'github',
    color: '#24292f',
    builtin: true,
    suppressed: false,
    priority: 10,
    urlPatterns: ['github\\.com/[^/]+/[^/]+'],
    keywordHints: [],
    description: 'GitHub repositories',
  },
  {
    id: 'model_3d',
    name: '3D Models',
    icon: 'box',
    color: '#f59e0b',
    builtin: true,
    suppressed: false,
    priority: 15,
    urlPatterns: ['makerworld', 'printables', 'thingiverse'],
    keywordHints: ['3d print', '3d-print', 'functionalprint'],
    description: 'STL files, 3D printing models',
  },
  {
    id: 'video',
    name: 'Videos',
    icon: 'play-circle',
    color: '#ef4444',
    builtin: true,
    suppressed: false,
    priority: 20,
    urlPatterns: ['youtube\\.com', 'youtu\\.be', '/reel/', 'instagram\\.com/reel'],
    keywordHints: [],
    description: 'YouTube videos, Instagram Reels, etc.',
  },
  {
    id: 'image',
    name: 'Images',
    icon: 'image',
    color: '#ec4899',
    builtin: true,
    suppressed: false,
    priority: 25,
    urlPatterns: ['i\\.redd\\.it/', 'instagram\\.com/p/'],
    keywordHints: [],
    description: 'Instagram posts, Reddit images',
  },
  {
    id: 'text_post',
    name: 'Discussions',
    icon: 'message-circle',
    color: '#10b981',
    builtin: true,
    suppressed: false,
    priority: 30,
    urlPatterns: ['(twitter\\.com|x\\.com)/[^/]+/status/'],
    keywordHints: [],
    description: 'Twitter/X posts, forum threads',
  },
  {
    id: 'article',
    name: 'Articles',
    icon: 'file-text',
    color: '#6366f1',
    builtin: true,
    suppressed: false,
    priority: 40,
    urlPatterns: [],
    keywordHints: ['article', 'blog'],
    description: 'Blog posts and articles',
  },
  {
    id: 'product',
    name: 'Products',
    icon: 'shopping-bag',
    color: '#f97316',
    builtin: true,
    suppressed: false,
    priority: 45,
    urlPatterns: [],
    keywordHints: [],
    description: 'Product pages, things to buy',
  },
  {
    id: 'document',
    name: 'Documents',
    icon: 'file-check',
    color: '#3b82f6',
    builtin: true,
    suppressed: false,
    priority: 50,
    urlPatterns: [],
    keywordHints: [],
    description: 'Documents requiring action (bills, letters, forms)',
  },
  {
    id: 'link',
    name: 'Links',
    icon: 'link',
    color: '#3b82f6',
    builtin: true,
    suppressed: false,
    priority: 100, // Lowest priority — fallback
    urlPatterns: [],
    keywordHints: [],
    description: 'Generic links (fallback type)',
  },
];

// ─── REGISTRY CACHE ─────────────────────────────────────────────────────────

let cachedTypes: ContentTypeDefinition[] | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

/** Load all content types (built-in + user-defined), merging DB overrides. */
export async function getContentTypes(): Promise<ContentTypeDefinition[]> {
  const now = Date.now();
  if (cachedTypes && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedTypes;
  }

  try {
    const rows = await db.select().from(triageContentTypes);
    const dbMap = new Map(rows.map((r) => [r.id, r]));

    // Start with built-in types, apply DB overrides (e.g., suppression)
    const merged: ContentTypeDefinition[] = BUILTIN_CONTENT_TYPES.map((bt) => {
      const override = dbMap.get(bt.id);
      if (!override) return bt;
      return {
        id: override.id,
        name: override.name,
        icon: override.icon || bt.icon,
        color: override.color,
        builtin: true,
        suppressed: override.suppressed,
        priority: override.priority,
        urlPatterns: override.urlPatterns as string[],
        keywordHints: override.keywordHints as string[],
        description: override.description || bt.description,
      };
    });

    // Add user-defined types (not in built-in list)
    for (const row of rows) {
      if (BUILTIN_CONTENT_TYPES.some((bt) => bt.id === row.id)) continue;
      merged.push({
        id: row.id,
        name: row.name,
        icon: row.icon || undefined,
        color: row.color,
        builtin: false,
        suppressed: row.suppressed,
        priority: row.priority,
        urlPatterns: row.urlPatterns as string[],
        keywordHints: row.keywordHints as string[],
        description: row.description || undefined,
      });
    }

    // Sort by priority (lower = matched first)
    merged.sort((a, b) => a.priority - b.priority);
    cachedTypes = merged;
    cacheLoadedAt = now;
    return merged;
  } catch (err) {
    // If table doesn't exist yet (migration not run), fall back to built-ins
    logger.debug({ err }, 'Content type registry: falling back to built-ins');
    cachedTypes = [...BUILTIN_CONTENT_TYPES].sort((a, b) => a.priority - b.priority);
    cacheLoadedAt = now;
    return cachedTypes;
  }
}

/** Invalidate the cache (call after mutations). */
export function invalidateContentTypeCache(): void {
  cachedTypes = null;
  cacheLoadedAt = 0;
}

// ─── DETECTION ──────────────────────────────────────────────────────────────

/**
 * Detect content type from URL, title, and description using the registry.
 * User-defined types with lower priority numbers are checked first.
 * Suppressed types are skipped (items that would match fall through to next match or 'link').
 */
export async function detectContentType(
  url: string,
  title: string,
  description?: string,
  sourcePlatform?: TriageSourcePlatform,
): Promise<string> {
  const types = await getContentTypes();
  const combined = `${title} ${description || ''} ${url}`.toLowerCase();

  for (const ct of types) {
    if (ct.suppressed) continue;
    if (ct.id === 'link') continue; // Skip fallback — we'll return it at the end

    let matched = false;

    // Check URL patterns
    if (ct.urlPatterns.length > 0) {
      for (const pattern of ct.urlPatterns) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(url)) {
            matched = true;
            break;
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }

    // Check keyword hints (in combined text)
    if (!matched && ct.keywordHints.length > 0) {
      for (const hint of ct.keywordHints) {
        if (combined.includes(hint.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    if (matched) return ct.id;
  }

  return 'link';
}

/**
 * Synchronous fallback for contexts where async isn't available.
 * Uses cached types if available, otherwise uses built-in defaults.
 */
export function detectContentTypeSync(
  url: string,
  title: string,
  description?: string,
): string {
  const types = cachedTypes || [...BUILTIN_CONTENT_TYPES].sort((a, b) => a.priority - b.priority);
  const combined = `${title} ${description || ''} ${url}`.toLowerCase();

  for (const ct of types) {
    if (ct.suppressed) continue;
    if (ct.id === 'link') continue;

    let matched = false;

    if (ct.urlPatterns.length > 0) {
      for (const pattern of ct.urlPatterns) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(url)) {
            matched = true;
            break;
          }
        } catch {
          // Invalid regex
        }
      }
    }

    if (!matched && ct.keywordHints.length > 0) {
      for (const hint of ct.keywordHints) {
        if (combined.includes(hint.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    if (matched) return ct.id;
  }

  return 'link';
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function upsertContentType(input: {
  id?: string;
  name: string;
  icon?: string;
  color?: string;
  suppressed?: boolean;
  priority?: number;
  urlPatterns?: string[];
  keywordHints?: string[];
  description?: string;
}): Promise<ContentTypeDefinition> {
  const now = new Date().toISOString();
  const id = input.id || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  const existing = await db.select().from(triageContentTypes).where(eq(triageContentTypes.id, id));

  const record = {
    id,
    name: input.name,
    icon: input.icon || null,
    color: input.color || '#6b7280',
    builtin: BUILTIN_CONTENT_TYPES.some((bt) => bt.id === id),
    suppressed: input.suppressed ?? false,
    priority: input.priority ?? 50,
    urlPatterns: input.urlPatterns || [],
    keywordHints: input.keywordHints || [],
    description: input.description || null,
    updatedAt: now,
  };

  if (existing.length > 0) {
    await db.update(triageContentTypes).set(record).where(eq(triageContentTypes.id, id));
  } else {
    await db.insert(triageContentTypes).values({ ...record, createdAt: now });
  }

  invalidateContentTypeCache();

  return {
    ...record,
    icon: record.icon || undefined,
    description: record.description || undefined,
  };
}

export async function deleteContentType(id: string): Promise<boolean> {
  // Don't allow deleting built-in types (suppress them instead)
  if (BUILTIN_CONTENT_TYPES.some((bt) => bt.id === id)) {
    return false;
  }

  await db.delete(triageContentTypes).where(eq(triageContentTypes.id, id));
  invalidateContentTypeCache();
  return true;
}

export async function suppressContentType(id: string, suppressed: boolean): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.select().from(triageContentTypes).where(eq(triageContentTypes.id, id));

  if (existing.length > 0) {
    await db.update(triageContentTypes).set({ suppressed, updatedAt: now }).where(eq(triageContentTypes.id, id));
  } else {
    // Insert a DB record for this built-in type so we can track suppression
    const builtin = BUILTIN_CONTENT_TYPES.find((bt) => bt.id === id);
    if (!builtin) return;
    await db.insert(triageContentTypes).values({
      id: builtin.id,
      name: builtin.name,
      icon: builtin.icon || null,
      color: builtin.color,
      builtin: true,
      suppressed,
      priority: builtin.priority,
      urlPatterns: builtin.urlPatterns,
      keywordHints: builtin.keywordHints,
      description: builtin.description || null,
      createdAt: now,
      updatedAt: now,
    });
  }

  invalidateContentTypeCache();
}

/** Get the list of built-in type IDs for reference. */
export function getBuiltinTypeIds(): string[] {
  return BUILTIN_CONTENT_TYPES.map((bt) => bt.id);
}
