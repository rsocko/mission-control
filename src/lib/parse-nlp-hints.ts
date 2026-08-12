/**
 * NLP Hint Parser for Quick Add Toast Suggestions
 *
 * Scans a *cleaned* task title (after explicit token extraction) for natural
 * language cues about priority, effort, and tags.  Results are shaped as a
 * `QuickSortSuggestion` so they slot directly into the inline-toast UI in
 * QuickAddBar.
 *
 * These hints are **not** applied automatically — they populate the suggestion
 * nudge row so the user can review and one-click apply.
 */

import type { QuickSortSuggestion } from '@/lib/hooks/useQuickSortData';

// ── Priority keyword mappings ───────────────────────────────────────────────

interface KeywordMapping {
  /** Words / short phrases to match (lower-cased). */
  keywords: string[];
  value: string;
  confidence: number;
  reason: string;
}

const PRIORITY_MAPPINGS: KeywordMapping[] = [
  {
    keywords: ['urgent', 'asap', 'critical', 'emergency', 'blocker', 'showstopper'],
    value: 'critical',
    confidence: 0.7,
    reason: 'Title contains an urgency keyword',
  },
  {
    keywords: ['important', 'high priority', 'time-sensitive', 'deadline'],
    value: 'high',
    confidence: 0.6,
    reason: 'Title suggests high importance',
  },
  {
    keywords: ['low priority', 'whenever', 'someday', 'nice to have', 'nice-to-have', 'backlog'],
    value: 'low',
    confidence: 0.6,
    reason: 'Title suggests low priority',
  },
];

// ── Effort keyword mappings ─────────────────────────────────────────────────

interface EffortMapping {
  keywords: string[];
  value: number; // 1-5
  confidence: number;
  reason: string;
}

const EFFORT_MAPPINGS: EffortMapping[] = [
  {
    keywords: ['quick', 'simple', 'easy', 'trivial', 'small fix', 'typo', 'minor'],
    value: 1, // XS
    confidence: 0.6,
    reason: 'Title suggests a small task',
  },
  {
    keywords: ['straightforward', 'short'],
    value: 2, // S
    confidence: 0.55,
    reason: 'Title suggests a short task',
  },
  {
    keywords: ['epic', 'massive', 'huge'],
    value: 5, // XL — checked before L so "epic redesign" picks XL
    confidence: 0.55,
    reason: 'Title suggests an extra-large task',
  },
  {
    keywords: ['complex', 'complicated', 'large', 'big', 'major', 'overhaul', 'redesign', 'refactor', 'rewrite', 'migration'],
    value: 4, // L
    confidence: 0.6,
    reason: 'Title suggests a large task',
  },
];

// ── Tag matching helpers ────────────────────────────────────────────────────

export interface CachedTag {
  id: string;
  name: string;
  slug: string;
}

/** Minimum tag name length to match against title words (avoids false positives). */
const MIN_TAG_LENGTH = 3;

/** Tag names that are too common as normal English words to auto-suggest. */
const TAG_STOPWORDS = new Set([
  'the', 'and', 'for', 'new', 'old', 'add', 'set', 'get', 'put', 'run',
  'use', 'try', 'see', 'top', 'end', 'now', 'day', 'one', 'two', 'all',
  'any', 'fix', 'hot', 'not', 'app', 'api',
]);

const TAG_MATCH_CONFIDENCE = 0.55;

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Scans a cleaned task title for natural-language metadata hints.
 *
 * @param title  The cleaned task title (explicit tokens already stripped).
 * @param availableTags  The user's existing tags (from the `/api/tags` cache).
 * @returns A `QuickSortSuggestion` containing any detected hints, or `null`
 *          if nothing was detected.
 */
export function parseNlpHints(
  title: string,
  availableTags: CachedTag[] = [],
): QuickSortSuggestion | null {
  const lower = ` ${title.toLowerCase()} `; // pad with spaces for whole-word matching

  // ── Priority ────────────────────────────────────────────────────────────
  let priority: QuickSortSuggestion['priority'] = null;
  for (const mapping of PRIORITY_MAPPINGS) {
    if (matchesAny(lower, mapping.keywords)) {
      priority = { value: mapping.value, confidence: mapping.confidence, reason: mapping.reason };
      break; // first match wins (ordered by severity)
    }
  }

  // ── Effort ──────────────────────────────────────────────────────────────
  let effort: QuickSortSuggestion['effort'] = null;
  for (const mapping of EFFORT_MAPPINGS) {
    if (matchesAny(lower, mapping.keywords)) {
      effort = { value: mapping.value, confidence: mapping.confidence, reason: mapping.reason };
      break;
    }
  }

  // ── Tags ────────────────────────────────────────────────────────────────
  const matchedTags: QuickSortSuggestion['tags'] = [];
  const seenTagNames = new Set<string>();
  for (const tag of availableTags) {
    if (tag.name.length < MIN_TAG_LENGTH) continue;
    if (TAG_STOPWORDS.has(tag.name.toLowerCase())) continue;
    // Skip duplicate tag names (can occur when DB has same-name tags with different IDs)
    const nameLower = tag.name.toLowerCase();
    if (seenTagNames.has(nameLower)) continue;

    // Check if the tag name (or its slug) appears as a word/phrase in the title
    if (containsWord(lower, nameLower) || containsWord(lower, tag.slug.toLowerCase())) {
      matchedTags.push({ id: tag.id, name: tag.name, confidence: TAG_MATCH_CONFIDENCE });
      seenTagNames.add(nameLower);
    }
  }

  if (!priority && !effort && matchedTags.length === 0) return null;
  return { priority, effort, tags: matchedTags };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if the padded lowercase text contains any of the keywords as whole words/phrases. */
function matchesAny(paddedLower: string, keywords: string[]): boolean {
  return keywords.some(kw => containsWord(paddedLower, kw));
}

/** Word-boundary match inside a space-padded lowercase string. */
function containsWord(paddedLower: string, word: string): boolean {
  let start = 0;
  while (true) {
    const idx = paddedLower.indexOf(word, start);
    if (idx === -1) return false;
    const before = paddedLower[idx - 1];
    const after = paddedLower[idx + word.length];
    if (isWordBoundary(before) && isWordBoundary(after)) return true;
    start = idx + 1;
  }
}

function isWordBoundary(ch: string | undefined): boolean {
  if (!ch) return true;
  return /[\s\-_:;,.!?'"()\[\]{}\/]/.test(ch);
}
