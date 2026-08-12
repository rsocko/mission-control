/**
 * Fuzzy Title Matching for Cross-Connector Dedup
 *
 * Implements a multi-signal similarity scorer for task titles that combines:
 * 1. Normalized Levenshtein distance (character-level similarity)
 * 2. Token overlap (word-level Jaccard similarity)
 * 3. Optional context boosting (same person, same subject line)
 *
 * Thresholds:
 * - >= 0.85: Auto-link (high confidence match)
 * - 0.70–0.84: Potential match (could flag for review)
 * - < 0.70: No match
 */

export interface FuzzyMatchResult {
  taskId: string;
  title: string;
  score: number;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
}

export interface FuzzyMatchOptions {
  /** Minimum score to consider a match (default: 0.70) */
  threshold?: number;
  /** Score above which auto-linking occurs (default: 0.85) */
  autoLinkThreshold?: number;
  /** Boost score if context matches (same person, subject) */
  contextFrom?: string;
  contextSubject?: string;
}

const DEFAULT_THRESHOLD = 0.70;
const DEFAULT_AUTO_LINK_THRESHOLD = 0.85;

/**
 * Normalize a title for comparison:
 * - lowercase
 * - strip leading/trailing whitespace
 * - collapse multiple spaces
 * - remove common filler prefixes like "Re:", "FW:", "Action:"
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(re:|fw:|fwd:|action:|follow[- ]?up:)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize a normalized title into meaningful words.
 * Strips common stop words that don't carry meaning for matching.
 */
export function tokenize(normalized: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by',
    'and', 'or', 'is', 'it', 'this', 'that', 'with', 'from',
  ]);

  return normalized
    .split(/[\s\-_/]+/)
    .filter(t => t.length > 1 && !stopWords.has(t));
}

/**
 * Compute Levenshtein distance between two strings.
 * Uses single-row DP (O(min(a,b)) space) with early exit when distance exceeds maxAllowed.
 */
function levenshteinDistance(a: string, b: string, maxAllowed?: number): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter string for space efficiency
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const bLen = b.length;
  const aLen = a.length;
  const cutoff = maxAllowed ?? aLen;

  // Single-row DP
  let prev = new Array(bLen + 1);
  let curr = new Array(bLen + 1);

  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = i;

    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    // Early exit: if minimum in this row already exceeds cutoff, bail
    if (rowMin > cutoff) return cutoff + 1;

    [prev, curr] = [curr, prev];
  }

  return prev[bLen];
}

/**
 * Normalized Levenshtein similarity: 1.0 = identical, 0.0 = completely different.
 * Caps input to 200 chars to prevent excessive computation on long email subjects.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const cappedA = a.length > 200 ? a.slice(0, 200) : a;
  const cappedB = b.length > 200 ? b.slice(0, 200) : b;
  const maxLen = Math.max(cappedA.length, cappedB.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(cappedA, cappedB, maxLen);
  return 1.0 - Math.min(dist, maxLen) / maxLen;
}

/**
 * Token-level Jaccard similarity.
 */
export function tokenSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Combined similarity score with weighted components.
 * - 40% Levenshtein similarity (catches typos, minor rewordings)
 * - 60% Token similarity (catches reordering, different phrasing same words)
 */
export function computeSimilarity(titleA: string, titleB: string): number {
  const normA = normalizeTitle(titleA);
  const normB = normalizeTitle(titleB);

  // Quick exact-match shortcut
  if (normA === normB) return 1.0;

  const levSim = levenshteinSimilarity(normA, normB);
  const tokSim = tokenSimilarity(tokenize(normA), tokenize(normB));

  return 0.4 * levSim + 0.6 * tokSim;
}

/**
 * Find fuzzy matches for a title among a set of candidate tasks.
 * Returns matches sorted by score descending.
 */
export function findFuzzyMatches(
  incomingTitle: string,
  candidates: Array<{
    id: string;
    title: string;
    connectorType: string;
    connectorInstanceId: string;
    sourceId: string;
    metadata?: string | null;
  }>,
  options: FuzzyMatchOptions = {},
): FuzzyMatchResult[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  const results: FuzzyMatchResult[] = [];

  for (const candidate of candidates) {
    // Don't match against the same connector type (that's sourceId dedup)
    let score = computeSimilarity(incomingTitle, candidate.title);

    // Context boosting: if the from/subject context matches, boost by up to 0.10
    if (options.contextFrom || options.contextSubject) {
      const boost = computeContextBoost(candidate.metadata, options);
      score = Math.min(1.0, score + boost);
    }

    if (score >= threshold) {
      results.push({
        taskId: candidate.id,
        title: candidate.title,
        score,
        connectorType: candidate.connectorType,
        connectorInstanceId: candidate.connectorInstanceId,
        sourceId: candidate.sourceId,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Compute a context-based boost (0–0.10) based on matching person/subject.
 */
function computeContextBoost(
  metadataJson: string | null | undefined,
  options: FuzzyMatchOptions,
): number {
  if (!metadataJson) return 0;

  try {
    const metadata = JSON.parse(metadataJson as string);
    let boost = 0;

    // Check if 'from' matches (e.g. same person assigned/created)
    if (options.contextFrom) {
      const taskAssignee = metadata.assignee || metadata.from || '';
      if (taskAssignee.toLowerCase().includes(options.contextFrom.toLowerCase())) {
        boost += 0.05;
      }
    }

    // Check if subject line matches
    if (options.contextSubject) {
      const taskSubject = metadata.scoutContext?.sourceSubject || metadata.sourceSubject || '';
      if (taskSubject && computeSimilarity(options.contextSubject, taskSubject) > 0.7) {
        boost += 0.05;
      }
    }

    return boost;
  } catch {
    return 0;
  }
}

/**
 * Determine if a match score qualifies for automatic linking.
 */
export function isAutoLinkMatch(score: number, options: FuzzyMatchOptions = {}): boolean {
  return score >= (options.autoLinkThreshold ?? DEFAULT_AUTO_LINK_THRESHOLD);
}

/**
 * Determine if a match is a potential match (for flagging/review).
 */
export function isPotentialMatch(score: number, options: FuzzyMatchOptions = {}): boolean {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const autoLink = options.autoLinkThreshold ?? DEFAULT_AUTO_LINK_THRESHOLD;
  return score >= threshold && score < autoLink;
}
