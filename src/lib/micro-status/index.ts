/**
 * Micro-Status ↔ Source Tag Mapping
 * 
 * Converts between MC micro-status values and namespaced source tags.
 * Prefix: "mc:" — distinguishes Mission Control metadata from user tags.
 * 
 * Examples:
 *   waiting_on_someone  ↔  mc:waiting-on-someone
 *   started_but_stuck   ↔  mc:started-but-stuck
 */

import { MICRO_STATUS_CONFIG } from '@/types';
import type { MicroStatus } from '@/types';

/** Prefix used for micro-status tags in source systems */
export const MICRO_STATUS_TAG_PREFIX = 'mc:';

/** All valid micro-status tag names (for filtering) */
export const ALL_MICRO_STATUS_TAGS = Object.keys(MICRO_STATUS_CONFIG).map(
  key => `${MICRO_STATUS_TAG_PREFIX}${key.replace(/_/g, '-')}`
);

/**
 * Convert a micro-status key to a source tag name.
 * e.g. "waiting_on_someone" → "mc:waiting-on-someone"
 */
export function microStatusToTag(microStatus: string): string {
  return `${MICRO_STATUS_TAG_PREFIX}${microStatus.replace(/_/g, '-')}`;
}

/**
 * Convert a source tag name back to a micro-status key.
 * Returns null if the tag doesn't match the micro-status prefix.
 * e.g. "mc:waiting-on-someone" → "waiting_on_someone"
 */
export function tagToMicroStatus(tagName: string): MicroStatus | null {
  if (!tagName.startsWith(MICRO_STATUS_TAG_PREFIX)) return null;
  const slug = tagName.slice(MICRO_STATUS_TAG_PREFIX.length);
  const key = slug.replace(/-/g, '_');
  return key in MICRO_STATUS_CONFIG ? (key as MicroStatus) : null;
}

/**
 * Check if a tag name is a micro-status tag.
 */
export function isMicroStatusTag(tagName: string): boolean {
  return tagName.startsWith(MICRO_STATUS_TAG_PREFIX) && tagToMicroStatus(tagName) !== null;
}

/**
 * Get the display color for a micro-status tag (for auto-creating labels).
 * Returns hex color without # prefix (for GitHub label API).
 */
export function getMicroStatusTagColor(tagName: string): string | null {
  const status = tagToMicroStatus(tagName);
  if (!status) return null;
  return MICRO_STATUS_CONFIG[status].color.replace('#', '');
}

/**
 * Given a list of tag names, extract the micro-status (if any).
 * Returns the first matching micro-status found.
 */
export function extractMicroStatusFromTags(tagNames: string[]): MicroStatus | null {
  for (const tag of tagNames) {
    const status = tagToMicroStatus(tag);
    if (status) return status;
  }
  return null;
}

/**
 * Update a tag list to reflect a new micro-status.
 * Removes any existing mc:* tags and adds the new one (if not null).
 * Returns the updated tag list.
 */
export function updateTagsWithMicroStatus(
  existingTags: string[],
  newMicroStatus: string | null,
): string[] {
  // Remove all existing mc:* tags
  const filtered = existingTags.filter(t => !isMicroStatusTag(t));
  // Add new one if set
  if (newMicroStatus) {
    filtered.push(microStatusToTag(newMicroStatus));
  }
  return filtered;
}

/**
 * Check if a connector's settings have micro-status sync enabled.
 * Legacy connectors without an explicit setting retain the original enabled behavior.
 * New connector creation persists false explicitly.
 */
export function isMicroStatusSyncEnabled(
  settings: Record<string, unknown>,
): boolean {
  return settings.syncMicroStatus !== false;
}
