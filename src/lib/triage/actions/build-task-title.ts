import type { TriageItem } from '@/types';

/**
 * Build an action-oriented task title from a triage item.
 *
 * Instead of using the AI triage summary (which is a recommendation, not a task),
 * this derives an actionable title from the item's content type and title.
 * For example: "Evaluate coolify/coolify" or "Review: Home Assistant MQTT setup".
 */
export function buildActionTitle(item: TriageItem, overrideTitle?: string): string {
  if (overrideTitle) return overrideTitle;

  const baseTitle = item.title || item.sourceUrl || 'Untitled item';

  // Document Intelligence items already have action-oriented titles (e.g. "Pay: Vendor — $50")
  if (item.sourcePlatform === 'document-intelligence') {
    return baseTitle;
  }

  // Pick a verb prefix based on content type and categories
  const verb = inferActionVerb(item);

  return `${verb} ${baseTitle}`;
}

function inferActionVerb(item: TriageItem): string {
  const categories = (item.aiCategories || []).map((c) => c.toLowerCase());
  const contentType = item.contentType;

  // Repos and tools → "Evaluate"
  if (contentType === 'repo' || categories.includes('tool')) {
    return 'Evaluate';
  }

  // 3D models → "Review model:"
  if (contentType === 'model_3d' || categories.includes('3d-printing')) {
    return 'Review model:';
  }

  // Homelab / home-automation → "Set up" or "Try"
  if (categories.includes('homelab') || categories.includes('home-automation')) {
    return 'Try';
  }

  // Video content → "Watch"
  if (contentType === 'video') {
    return 'Watch';
  }

  // Articles / text posts → "Read"
  if (contentType === 'article' || contentType === 'text_post') {
    return 'Read';
  }

  // Default → "Review"
  return 'Review';
}
