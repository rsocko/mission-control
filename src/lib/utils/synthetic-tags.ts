/**
 * Client-safe helpers to identify "synthetic" tags — labels that represent
 * structured fields (priority, effort, micro-status) and should be hidden
 * from the tag display since they already have dedicated UI controls.
 *
 * These mirror the detection logic in the server-side label-handler and
 * micro-status modules but avoid importing Node / connector dependencies
 * so they can be used in React components.
 */

import { MICRO_STATUS_CONFIG } from '@/types';

const MICRO_STATUS_TAG_PREFIX = 'mc:';

/** Set of valid micro-status slugs derived from the config keys (e.g. "in-research", "blocked-external"). */
const VALID_MICRO_STATUS_SLUGS = new Set(
  Object.keys(MICRO_STATUS_CONFIG).map(key => key.replace(/_/g, '-'))
);

const PRIORITY_RE = /^priority[\s:\/\-_]/i;
const PRIORITY_EXACT_RE = /^p[0-3]$/i;

const EFFORT_RE = /^(?:effort|size|estimate|t-shirt)[\s:\/\-_]/i;

/**
 * Returns true if a tag name represents a field that already has a dedicated
 * UI control (priority dropdown, effort picker, micro-status badge).
 */
export function isSyntheticTag(tagName: string): boolean {
  const t = tagName.trim();
  if (t.startsWith(MICRO_STATUS_TAG_PREFIX)) {
    const slug = t.slice(MICRO_STATUS_TAG_PREFIX.length);
    return VALID_MICRO_STATUS_SLUGS.has(slug);
  }
  if (PRIORITY_RE.test(t) || PRIORITY_EXACT_RE.test(t) || t.toLowerCase() === 'priority') return true;
  if (EFFORT_RE.test(t)) return true;
  return false;
}
