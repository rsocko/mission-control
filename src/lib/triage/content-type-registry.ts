import logger from '@/lib/logger';
import { getTriagePersistenceRepositories } from './persistence';
import {
  BUILTIN_CONTENT_TYPES,
  type ContentTypeDefinition,
} from './content-type-definitions';
export type { ContentTypeDefinition } from './content-type-definitions';

// ─── TYPES ──────────────────────────────────────────────────────────────────

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
    const rows = await getTriagePersistenceRepositories().contentTypes.list();
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

  await getTriagePersistenceRepositories().contentTypes.upsert({
    ...record,
    createdAt: now,
  });

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

  const deleted = await getTriagePersistenceRepositories().contentTypes.deleteCustom(id);
  invalidateContentTypeCache();
  return deleted;
}

export async function suppressContentType(id: string, suppressed: boolean): Promise<void> {
  const now = new Date().toISOString();
  const builtin = BUILTIN_CONTENT_TYPES.find((candidate) => candidate.id === id);
  await getTriagePersistenceRepositories().contentTypes.setSuppressed({
    id,
    suppressed,
    updatedAt: now,
    builtin: builtin
      ? {
          name: builtin.name,
          icon: builtin.icon || null,
          color: builtin.color,
          priority: builtin.priority,
          urlPatterns: builtin.urlPatterns,
          keywordHints: builtin.keywordHints,
          description: builtin.description || null,
          createdAt: now,
        }
      : null,
  });

  invalidateContentTypeCache();
}

/** Get the list of built-in type IDs for reference. */
export function getBuiltinTypeIds(): string[] {
  return BUILTIN_CONTENT_TYPES.map((bt) => bt.id);
}
