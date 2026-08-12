/**
 * Tests that synthetic labels (priority, effort, micro-status) are excluded
 * from the tags array when transforming GitHub issues, since those fields
 * are represented by dedicated structured fields.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  let counter = 0;
  return { ...actual, randomUUID: () => `test-uuid-${++counter}` };
});

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  let counter = 0;
  return { ...actual, randomUUID: () => `test-uuid-${++counter}` };
});

// Must import after mock declaration (vitest hoists vi.mock automatically)
import { mapGraphQLIssueToTask, mapRestIssueToTask } from '@/lib/connectors/github-issues/issue-transformer';

describe('issue-transformer synthetic-tag filtering', () => {
  const repo = 'owner/repo';
  const connectorId = 'conn-1';

  const baseGraphQLIssue = {
    id: 'node-1',
    number: 42,
    title: 'Test issue',
    body: '',
    state: 'OPEN' as const,
    stateReason: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    closedAt: null,
    assignees: { nodes: [] },
    milestone: null,
    parent: null,
    subIssues: { nodes: [] },
    url: 'https://github.com/owner/repo/issues/42',
    labels: { nodes: [] as Array<{ name: string; color: string }> },
  };

  const baseRestIssue = {
    id: 1,
    number: 42,
    title: 'Test issue',
    body: '',
    state: 'open' as const,
    state_reason: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    closed_at: null,
    assignee: null,
    milestone: null,
    labels: [] as Array<{ name: string; color: string }>,
    html_url: 'https://github.com/owner/repo/issues/42',
  };

  it('filters priority labels from GraphQL tags', () => {
    const issue = {
      ...baseGraphQLIssue,
      labels: {
        nodes: [
          { name: 'priority:medium', color: 'eab308' },
          { name: 'bug', color: 'd73a4a' },
        ],
      },
    };

    const task = mapGraphQLIssueToTask(issue, repo, connectorId);
    expect(task.priority).toBe('medium');
    expect(task.tags.map(t => t.name)).toEqual(['bug']);
  });

  it('filters effort labels from GraphQL tags', () => {
    const issue = {
      ...baseGraphQLIssue,
      labels: {
        nodes: [
          { name: 'effort:3', color: 'eab308' },
          { name: 'enhancement', color: 'a2eeef' },
        ],
      },
    };

    const task = mapGraphQLIssueToTask(issue, repo, connectorId);
    expect(task.effort).toBe(3);
    expect(task.tags.map(t => t.name)).toEqual(['enhancement']);
  });

  it('filters micro-status labels from GraphQL tags', () => {
    const issue = {
      ...baseGraphQLIssue,
      labels: {
        nodes: [
          { name: 'mc:in-research', color: '6e6e6e' },
          { name: 'feature', color: '0075ca' },
        ],
      },
    };

    const task = mapGraphQLIssueToTask(issue, repo, connectorId);
    expect(task.tags.map(t => t.name)).toEqual(['feature']);
  });

  it('filters all synthetic labels while keeping regular ones (REST)', () => {
    const issue = {
      ...baseRestIssue,
      labels: [
        { name: 'priority:high', color: 'd93f0b' },
        { name: 'effort:2', color: '7dc67d' },
        { name: 'mc:blocked-external', color: '6e6e6e' },
        { name: 'documentation', color: '0075ca' },
        { name: 'good first issue', color: '7057ff' },
      ],
    };

    const task = mapRestIssueToTask(issue, repo, connectorId);
    expect(task.priority).toBe('high');
    expect(task.effort).toBe(2);
    expect(task.tags.map(t => t.name)).toEqual(['documentation', 'good first issue']);
  });

  it('keeps all labels when none are synthetic', () => {
    const issue = {
      ...baseGraphQLIssue,
      labels: {
        nodes: [
          { name: 'bug', color: 'd73a4a' },
          { name: 'help wanted', color: '008672' },
        ],
      },
    };

    const task = mapGraphQLIssueToTask(issue, repo, connectorId);
    expect(task.tags.map(t => t.name)).toEqual(['bug', 'help wanted']);
  });
});
