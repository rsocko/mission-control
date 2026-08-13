import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  GitHubHttpError,
} from '@/lib/connectors/github-issues/github-client';

describe('GitHub API client', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('preserves GraphQL forbidden rate-limit evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'You have exceeded a secondary rate limit.',
    }), {
      status: 403,
      headers: {
        'retry-after': '2',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1786579200',
      },
    })));

    const client = createGitHubClient('test-token');

    await expect(client.graphqlFetch('mutation { transferIssue(input: {}) { clientMutationId } }'))
      .rejects.toEqual(expect.objectContaining<Partial<GitHubHttpError>>({
        name: 'GitHubHttpError',
        status: 403,
        retryAfterMs: 2_000,
        headers: expect.objectContaining({
          'retry-after': '2',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1786579200',
        }),
        responseBody: expect.stringContaining('secondary rate limit'),
      }));
  });

  it('retains at most 8 KiB from an oversized chunked error body and cancels it', async () => {
    let cancelled = false;
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
       pullCount += 1;
       controller.enqueue(new TextEncoder().encode('x'.repeat(4_096)));
      },
      cancel() {
       cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403 })));

    const client = createGitHubClient('test-token');
    const error = await client.graphqlFetch('query { viewer { login } }')
      .catch((caught: unknown) => caught);

    expect(error).toEqual(expect.objectContaining<Partial<GitHubHttpError>>({
      status: 403,
      responseBody: 'x'.repeat(8_192),
    }));
    expect(cancelled).toBe(true);
    expect(pullCount).toBeLessThanOrEqual(3);
  });

  it('decodes UTF-8 characters split across error-body chunks', async () => {
    const encoded = new TextEncoder().encode('A🙂B');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
       controller.enqueue(encoded.subarray(0, 3));
       controller.enqueue(encoded.subarray(3, 5));
       controller.enqueue(encoded.subarray(5));
       controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403 })));

    const client = createGitHubClient('test-token');

    await expect(client.graphqlFetch('query { viewer { login } }')).rejects.toEqual(
      expect.objectContaining<Partial<GitHubHttpError>>({
       status: 403,
       responseBody: 'A🙂B',
      }),
    );
  });

  it('times out and cancels a stalled error body while preserving header evidence', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
       cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 403,
      headers: {
       'retry-after': '2',
       'x-ratelimit-remaining': '0',
      },
    })));

    const client = createGitHubClient('test-token');
    const request = client.graphqlFetch('query { viewer { login } }');
    const rejection = expect(request).rejects.toEqual(
      expect.objectContaining<Partial<GitHubHttpError>>({
       status: 403,
       retryAfterMs: 2_000,
       headers: expect.objectContaining({
         'retry-after': '2',
         'x-ratelimit-remaining': '0',
       }),
       responseBody: null,
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(cancelled).toBe(true);
  });

  it.each(['0.5', '2026-08-14', '08/14/2026', 'not-a-delay'])(
    'rejects malformed Retry-After evidence %s',
    async (retryAfter) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
        status: 403,
        headers: { 'retry-after': retryAfter },
      })));

      const client = createGitHubClient('test-token');

      await expect(client.graphqlFetch('query { viewer { login } }')).rejects.toEqual(
        expect.objectContaining<Partial<GitHubHttpError>>({
          status: 403,
          retryAfterMs: null,
        }),
      );
    },
  );
});
