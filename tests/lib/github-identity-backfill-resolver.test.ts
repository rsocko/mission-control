import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '@/lib/connectors/github-issues/github-client';
import { normalizeGitHubOrigin } from '@/lib/connectors/github-issues/identity';
import { GitHubIdentityBackfillResolver } from '@/lib/external-identities/github-backfill';

vi.unmock('drizzle-orm');

describe('GitHub identity backfill HTTP classification', () => {
  it.each([
    [401, 'permission_denied'],
    [403, 'permission_denied'],
    [404, 'not_found_or_inaccessible'],
  ])('classifies HTTP %s as inaccessible', async (status, reasonCode) => {
    const resolver = new GitHubIdentityBackfillResolver(client(async () => (
      new Response(null, { status })
    )));
    await expect(resolver.resolveSourceList('owner/repo')).resolves.toMatchObject({
      state: 'inaccessible',
      reasonCode,
    });
  });

  it('honors retry timing for rate limits', async () => {
    const resolver = new GitHubIdentityBackfillResolver(client(async () => (
      new Response(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      })
    )));
    const before = Date.now() + 119_000;
    const resolution = await resolver.resolveSourceList('owner/repo');
    expect(resolution).toMatchObject({
      state: 'pending',
      reasonCode: 'rate_limited',
    });
    expect(new Date(resolution.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('keeps missing node IDs legacy-only and network failures retryable', async () => {
    const missing = new GitHubIdentityBackfillResolver(client(async () => (
      Response.json({
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
      })
    )));
    await expect(missing.resolveSourceList('owner/repo')).resolves.toMatchObject({
      state: 'legacy_only',
      reasonCode: 'repository_node_id_missing',
    });

    const network = new GitHubIdentityBackfillResolver(client(async () => {
      throw new Error('network unavailable');
    }));
    await expect(network.resolveSourceList('owner/repo')).resolves.toMatchObject({
      state: 'pending',
      reasonCode: 'network_error',
    });
  });

  it('uses trusted metadata node evidence without accepting a foreign URL', async () => {
    const fakeClient = client(async (path) => {
      if (path === '/repos/owner/repo') {
        return Response.json({
          node_id: 'R_repo',
          full_name: 'owner/repo',
          url: 'https://api.github.com/repos/owner/repo',
          html_url: 'https://github.com/owner/repo',
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const resolver = new GitHubIdentityBackfillResolver(fakeClient);
    const resolution = await resolver.resolveTask({
      id: 'task-1',
      sourceId: 'owner/repo:7',
      metadata: {
        nodeId: 'I_issue',
        url: 'https://evil.example/owner/repo/issues/7',
      },
    });
    expect(resolution).toMatchObject({
      state: 'bound',
      reasonCode: 'metadata_node_id',
      evidence: {
        entity: {
          identity: { stableId: 'I_issue', hostKey: 'github.com' },
          locator: { webUrl: undefined },
        },
      },
    });
  });
});

function client(
  restFetch: (path: string) => Promise<Response>,
): GitHubClient {
  return {
    origin: normalizeGitHubOrigin(),
    restFetch,
    graphqlFetch: vi.fn(),
    graphqlFetchAny: vi.fn(),
  };
}
