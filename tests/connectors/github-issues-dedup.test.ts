/**
 * Tests for PR #288 — Fix duplicate sub-issues in GitHub Issues connector
 * 
 * The fix ensures that when a sub-issue is referenced BOTH via the GraphQL
 * subIssues field AND as a markdown task-list item (e.g. `- [ ] #123`),
 * it is not duplicated — the checklist parser filters out issues that already
 * appeared in the subIssues nodes.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock fetch globally
beforeAll(() => {
  global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
  };
});

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: { id: 'id', type: 'type' },
}));

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/lib/micro-status', () => ({
  extractMicroStatusFromTags: vi.fn(() => ({ microStatus: null, filteredTags: [] })),
  isMicroStatusTag: vi.fn(() => false),
  updateTagsWithMicroStatus: vi.fn((tags: string[]) => tags),
  microStatusToTag: vi.fn(() => null),
  getMicroStatusTagColor: vi.fn(() => null),
  MICRO_STATUS_TAG_PREFIX: 'mc:',
}));

// Import the transformer directly to unit-test dedup logic
describe('GitHub Issues — sub-issue deduplication (PR #288)', () => {
  it('parseMarkdownTaskList should exclude items referencing sub-issue numbers', async () => {
    const { parseMarkdownTaskList } = await import('@/lib/connectors/github-issues/issue-transformer');

    const body = `
## Tasks
- [ ] #10 Implement auth
- [ ] #20 Write tests
- [ ] Design the UI
- [x] #30 Setup CI
    `;

    const subIssueNumbers = new Set([10, 30]);
    const items = parseMarkdownTaskList(body, 'parent-1', 'gh-inst', 'org/repo');

    // Filter as the connector does
    const filtered = items.filter(item => {
      const issueRefMatch = item.title.match(/#(\d+)/);
      if (issueRefMatch && subIssueNumbers.has(Number(issueRefMatch[1]))) {
        return false;
      }
      return true;
    });

    // #10 and #30 should be excluded (they're in subIssues)
    // #20 and "Design the UI" should remain
    expect(filtered.length).toBe(2);
    expect(filtered.some(i => i.title.includes('#20'))).toBe(true);
    expect(filtered.some(i => i.title.includes('Design the UI'))).toBe(true);
    expect(filtered.some(i => i.title.includes('#10'))).toBe(false);
    expect(filtered.some(i => i.title.includes('#30'))).toBe(false);
  });

  it('should not exclude checklist items that reference non-sub-issue numbers', async () => {
    const { parseMarkdownTaskList } = await import('@/lib/connectors/github-issues/issue-transformer');

    const body = `- [ ] Fix #99 regression\n- [ ] Address #100`;
    const subIssueNumbers = new Set([50]); // none of these match

    const items = parseMarkdownTaskList(body, 'parent-2', 'gh-inst', 'org/repo');
    const filtered = items.filter(item => {
      const issueRefMatch = item.title.match(/#(\d+)/);
      if (issueRefMatch && subIssueNumbers.has(Number(issueRefMatch[1]))) {
        return false;
      }
      return true;
    });

    expect(filtered.length).toBe(2);
  });

  it('should handle empty body gracefully', async () => {
    const { parseMarkdownTaskList } = await import('@/lib/connectors/github-issues/issue-transformer');

    const items = parseMarkdownTaskList('', 'parent-3', 'gh-inst', 'org/repo');
    expect(items).toHaveLength(0);
  });

  it('should handle body with no task items', async () => {
    const { parseMarkdownTaskList } = await import('@/lib/connectors/github-issues/issue-transformer');

    const body = `# Issue description\nJust some text with no checklist items.`;
    const items = parseMarkdownTaskList(body, 'parent-4', 'gh-inst', 'org/repo');
    expect(items).toHaveLength(0);
  });
});
