import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => 'github-create-test-id' };
});

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

vi.mock('@/lib/external-identities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/external-identities')>();
  return {
    ...actual,
    getGitHubIdentityModeSnapshot: () => ({
      effectiveMode: 'legacy',
      stablePrimaryEnabled: false,
      revision: 1,
    }),
  };
});

const config: ConnectorConfig = {
  id: 'github-1',
  type: 'github-issues',
  name: 'GitHub',
  enabled: true,
  syncMode: 'manual',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
  },
  credentials: { token: 'test-token' },
  settings: { repos: ['acme/app'] },
  syncedLists: ['acme/app'],
};

describe('GitHub issue tag write-back', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds and removes issue labels through the GitHub API', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }));
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await connector.addTagToTask('acme/app:42', 'Needs review');
    await connector.removeTagFromTask('acme/app:42', 'Needs review');

    expect(calls[0]).toMatchObject({
      url: expect.stringContaining('/repos/acme/app/issues/42/labels'),
      init: {
        method: 'POST',
        body: JSON.stringify({ labels: ['Needs review'] }),
      },
    });
    expect(calls[1]).toMatchObject({
      url: expect.stringContaining('/repos/acme/app/issues/42/labels/Needs%20review'),
      init: { method: 'DELETE' },
    });
  });

  it('sends an explicit empty issue body when clearing a description', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        node_id: 'I_updated',
        number: 42,
        title: 'Updated issue',
        body: null,
        state: 'open',
        created_at: '2026-08-09T20:00:00.000Z',
        updated_at: '2026-08-10T20:00:00.000Z',
        closed_at: null,
        url: 'https://api.github.com/repos/acme/app/issues/42',
        html_url: 'https://github.com/acme/app/issues/42',
        labels: [],
      });
    }));
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await connector.updateTask('acme/app:42', { description: '' });

    expect(calls).toContainEqual(expect.objectContaining({
      url: expect.stringContaining('/repos/acme/app/issues/42'),
      init: expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: '' }),
      }),
    }));
  });

  it('returns stable identity evidence when creating an issue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/repos/acme/app/issues')) {
        return Response.json({
          node_id: 'I_created',
          number: 42,
          title: 'Created issue',
          body: null,
          state: 'open',
          created_at: '2026-08-09T20:00:00.000Z',
          updated_at: '2026-08-09T20:00:00.000Z',
          closed_at: null,
          url: 'https://api.github.com/repos/acme/app/issues/42',
          html_url: 'https://github.com/acme/app/issues/42',
          labels: [],
        });
      }
      if (url.endsWith('/repos/acme/app')) {
        return Response.json({
          node_id: 'R_app',
          full_name: 'acme/app',
          url: 'https://api.github.com/repos/acme/app',
          html_url: 'https://github.com/acme/app',
        });
      }
      return new Response(null, { status: 404 });
    }));
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    const created = await connector.createTask({
      title: 'Created issue',
      sourceListId: 'acme/app',
    });

    expect(created.sourceId).toBe('acme/app:42');
    expect(created.externalIdentity?.entity.identity.stableId).toBe('I_created');
    expect(created.externalIdentity?.repository?.identity.stableId).toBe('R_app');
  });
});
