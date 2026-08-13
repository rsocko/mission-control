import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  GitHubHttpError,
} from '@/lib/connectors/github-issues/github-client';

describe('GitHub API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves GraphQL rate-limit status and retry timing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'retry-after': '2' },
    })));

    const client = createGitHubClient('test-token');

    await expect(client.graphqlFetch('query { viewer { login } }')).rejects.toEqual(
      expect.objectContaining<Partial<GitHubHttpError>>({
        name: 'GitHubHttpError',
        status: 429,
        retryAfterMs: 2_000,
      }),
    );
  });
});
