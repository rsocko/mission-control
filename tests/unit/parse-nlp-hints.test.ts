import { describe, it, expect } from 'vitest';
import { parseNlpHints, type CachedTag } from '@/lib/parse-nlp-hints';

const sampleTags: CachedTag[] = [
  { id: 'tag-1', name: 'bug', slug: 'bug' },
  { id: 'tag-2', name: 'design', slug: 'design' },
  { id: 'tag-3', name: 'frontend', slug: 'frontend' },
  { id: 'tag-4', name: 'documentation', slug: 'documentation' },
  { id: 'tag-5', name: 'dx', slug: 'dx' }, // too short (< 3 chars) — should be skipped
  { id: 'tag-6', name: 'api', slug: 'api' }, // in stopwords — should be skipped
];

describe('parseNlpHints', () => {
  // ── Priority ────────────────────────────────────────────────────────────

  describe('priority detection', () => {
    it('detects "urgent" as critical priority', () => {
      const result = parseNlpHints('Fix urgent production outage');
      expect(result?.priority?.value).toBe('critical');
      expect(result?.priority?.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('detects "asap" as critical', () => {
      const result = parseNlpHints('Deploy hotfix ASAP');
      expect(result?.priority?.value).toBe('critical');
    });

    it('detects "important" as high', () => {
      const result = parseNlpHints('Important meeting prep');
      expect(result?.priority?.value).toBe('high');
    });

    it('detects "someday" as low', () => {
      const result = parseNlpHints('Someday reorganize bookmarks');
      expect(result?.priority?.value).toBe('low');
    });

    it('detects "nice to have" as low', () => {
      const result = parseNlpHints('Add dark mode nice to have');
      expect(result?.priority?.value).toBe('low');
    });

    it('does not match partial words like "burger" for "urgent"', () => {
      const result = parseNlpHints('Order burger for lunch');
      expect(result?.priority ?? null).toBeNull();
    });
  });

  // ── Effort ──────────────────────────────────────────────────────────────

  describe('effort detection', () => {
    it('detects "quick" as XS effort', () => {
      const result = parseNlpHints('Quick typo fix in readme');
      expect(result?.effort?.value).toBe(1);
    });

    it('detects "simple" as XS effort', () => {
      const result = parseNlpHints('Simple config change');
      expect(result?.effort?.value).toBe(1);
    });

    it('detects "complex" as L effort', () => {
      const result = parseNlpHints('Complex database migration');
      expect(result?.effort?.value).toBe(4);
    });

    it('detects "refactor" as L effort', () => {
      const result = parseNlpHints('Refactor auth module');
      expect(result?.effort?.value).toBe(4);
    });

    it('detects "epic" as XL effort', () => {
      const result = parseNlpHints('Epic redesign of the whole app');
      expect(result?.effort?.value).toBe(5);
    });
  });

  // ── Tag matching ────────────────────────────────────────────────────────

  describe('tag matching', () => {
    it('matches tag name as a whole word in title', () => {
      const result = parseNlpHints('Fix bug in login form', sampleTags);
      expect(result?.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'tag-1', name: 'bug' })]),
      );
    });

    it('matches multiple tags', () => {
      const result = parseNlpHints('Update frontend design tokens', sampleTags);
      const tagIds = result?.tags.map(t => t.id) ?? [];
      expect(tagIds).toContain('tag-2'); // design
      expect(tagIds).toContain('tag-3'); // frontend
    });

    it('does not match tag as substring', () => {
      const result = parseNlpHints('Debugging session notes', sampleTags);
      // "bug" should NOT match inside "Debugging"
      const hasBug = result?.tags.some(t => t.id === 'tag-1') ?? false;
      expect(hasBug).toBe(false);
    });

    it('matches tag even when an earlier occurrence is embedded in another word', () => {
      const result = parseNlpHints('Debugging the auth bug', sampleTags);
      // "bug" appears first inside "Debugging" (no match), then standalone (should match)
      const hasBug = result?.tags.some(t => t.id === 'tag-1') ?? false;
      expect(hasBug).toBe(true);
    });

    it('skips tags shorter than MIN_TAG_LENGTH', () => {
      const result = parseNlpHints('Improve dx for contributors', sampleTags);
      const hasDx = result?.tags.some(t => t.id === 'tag-5') ?? false;
      expect(hasDx).toBe(false);
    });

    it('skips tags in the stopwords list', () => {
      const result = parseNlpHints('Build new API endpoint', sampleTags);
      const hasApi = result?.tags.some(t => t.id === 'tag-6') ?? false;
      expect(hasApi).toBe(false);
    });
  });

  // ── Combined ────────────────────────────────────────────────────────────

  describe('combined detection', () => {
    it('detects priority + effort + tags together', () => {
      const result = parseNlpHints('Urgent quick bug fix', sampleTags);
      expect(result?.priority?.value).toBe('critical');
      expect(result?.effort?.value).toBe(1);
      expect(result?.tags).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'bug' })]),
      );
    });
  });

  // ── No match ────────────────────────────────────────────────────────────

  describe('no match', () => {
    it('returns null when nothing is detected', () => {
      const result = parseNlpHints('Buy groceries', sampleTags);
      expect(result).toBeNull();
    });

    it('returns null for empty title', () => {
      expect(parseNlpHints('')).toBeNull();
    });

    it('returns null for no tags provided and no keywords', () => {
      expect(parseNlpHints('Buy groceries')).toBeNull();
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────

  describe('deduplication', () => {
    it('does not suggest the same tag name twice when DB has duplicate-named tags with different IDs', () => {
      const tagsWithDuplicates: CachedTag[] = [
        { id: 'uuid-from-sync', name: 'bug', slug: 'bug' },
        { id: 'tag-bug', name: 'bug', slug: 'bug' },
        { id: 'tag-design', name: 'design', slug: 'design' },
      ];
      const result = parseNlpHints('Fix bug in login form', tagsWithDuplicates);
      const bugTags = result?.tags.filter(t => t.name.toLowerCase() === 'bug') ?? [];
      expect(bugTags).toHaveLength(1);
    });

    it('does not suggest the same tag name twice with different casing', () => {
      const tagsWithCaseDupes: CachedTag[] = [
        { id: 'tag-1', name: 'Bug', slug: 'bug' },
        { id: 'tag-2', name: 'bug', slug: 'bug-2' },
      ];
      const result = parseNlpHints('Fix bug in login form', tagsWithCaseDupes);
      const bugTags = result?.tags.filter(t => t.name.toLowerCase() === 'bug') ?? [];
      expect(bugTags).toHaveLength(1);
    });
  });
});
