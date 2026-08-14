import { describe, expect, it } from 'vitest';
import { refreshGitHubIssueMetadata } from '@/lib/connectors/github-issues/issue-transformer';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';

describe('getTaskDisplayId', () => {
  it('uses the authoritative GitHub source locator after transfer', () => {
    expect(getTaskDisplayId(
      'github-issues',
      { issueNumber: 784 },
      'rsocko/mission-control:401',
    )).toBe('#401');
  });

  it('falls back to legacy GitHub metadata without a source locator', () => {
    expect(getTaskDisplayId(
      'github-issues',
      { issueNumber: 784 },
      null,
    )).toBe('#784');
  });
});

describe('refreshGitHubIssueMetadata', () => {
  it('preserves double-encoded legacy metadata while replacing the active locator', () => {
    expect(refreshGitHubIssueMetadata(
      '"{\\"issueNumber\\":784,\\"retained\\":true}"',
      'rsocko/mission-control:401',
    )).toEqual({
      issueNumber: 401,
      retained: true,
    });
  });
});
