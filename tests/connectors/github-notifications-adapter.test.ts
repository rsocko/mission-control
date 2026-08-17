import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient, GitHubNotification } from '@/lib/connectors/github-issues/github-client';
import {
  GitHubNotificationsAdapter,
  type GitHubNotificationPollState,
} from '@/lib/connectors/github-issues/notifications-adapter';
import { ConnectorWritebackError } from '@/lib/connectors/notification-writeback-contract';

/**
 * Constructs a `GitHubNotificationsAdapter` directly — with a fake client and
 * an in-memory `persistPollState` stub standing in for the shared connector
 * config store — so the adapter can be exercised completely independently of
 * `GitHubIssuesConnector`, a real database, or network access. This is the
 * "independently testable" shape called for by issue #1225 for the extracted
 * notifications adapter (complementary to the existing DB-backed
 * `github-notification-lifecycle.test.ts`, which exercises the same adapter
 * indirectly through the connector facade's public API).
 */
function createAdapter(overrides: { restFetch?: GitHubClient['restFetch'] } = {}) {
  let pollState: GitHubNotificationPollState = {};
  const persistPollState = vi.fn(async (patch: Partial<GitHubNotificationPollState>) => {
    const next = { ...pollState };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    pollState = next;
    return pollState;
  });
  const client: GitHubClient = {
    origin: { hostKey: 'github.com', restBaseUrl: 'https://api.github.com', graphqlUrl: 'https://api.github.com/graphql' },
    restFetch: overrides.restFetch ?? vi.fn(async () => new Response('[]', { status: 200 })),
    graphqlFetch: vi.fn(),
    graphqlFetchAny: vi.fn(),
  };
  const adapter = new GitHubNotificationsAdapter({
    connectorType: 'github-issues',
    getConnectorId: () => 'github-1',
    getClient: () => client,
    persistPollState,
  });
  return { adapter, client, persistPollState, getPollState: () => pollState };
}

function githubNotification(overrides: Partial<GitHubNotification> = {}): GitHubNotification {
  return {
    id: '1001',
    reason: 'mention',
    unread: true,
    updated_at: '2026-08-10T00:00:00.000Z',
    last_read_at: null,
    subject: { title: 'Some issue', type: 'Issue', url: 'https://api.github.com/repos/acme/app/issues/9' },
    repository: { full_name: 'acme/app' },
    ...overrides,
  };
}

describe('GitHubNotificationsAdapter', () => {
  it('returns an empty list without calling the client when notifications are disabled', async () => {
    const { adapter, client } = createAdapter();
    adapter.configure({
      fetchNotificationsEnabled: false,
      notificationReasons: [],
      participatingOnly: false,
      authenticatedUser: 'octocat',
      notificationPollState: {},
    });

    const result = await adapter.fetchNotifications();
    expect(result).toEqual([]);
    expect(client.restFetch).not.toHaveBeenCalled();
  });

  it('maps fetched notifications to InboundNotification shape and applies the reason filter', async () => {
    const restFetch = vi.fn(async () => new Response(JSON.stringify([
      githubNotification({ id: '1', reason: 'mention' }),
      githubNotification({ id: '2', reason: 'security_alert', subject: { title: 'Vuln', type: 'RepositoryVulnerabilityAlert', url: undefined } }),
    ]), { status: 200 }));
    const { adapter } = createAdapter({ restFetch });
    adapter.configure({
      fetchNotificationsEnabled: true,
      notificationReasons: ['security_alert'],
      participatingOnly: false,
      authenticatedUser: 'octocat',
      notificationPollState: {},
    });

    const result = await adapter.fetchNotifications(new Date('2026-08-01T00:00:00.000Z'));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'gh-notif-2',
      sourceId: '2',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      level: 'urgent',
      category: 'security',
      isRead: false,
      isActionable: true,
      actionUrl: 'https://github.com/acme/app',
    });
  });

  it('follows Link-header pagination across multiple pages and persists poll-state checkpoints incrementally', async () => {
    const restFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([githubNotification({ id: '1' })]), {
        status: 200,
        headers: { link: '</notifications?page=2>; rel="next"', etag: '"v1"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([githubNotification({ id: '2' })]), { status: 200 }));
    const { adapter, persistPollState } = createAdapter({ restFetch });
    adapter.configure({
      fetchNotificationsEnabled: true,
      notificationReasons: [],
      participatingOnly: false,
      authenticatedUser: 'octocat',
      notificationPollState: {},
    });

    const result = await adapter.fetchNotifications(new Date('2026-08-01T00:00:00.000Z'));
    expect(result.map((n) => n.sourceId).sort()).toEqual(['1', '2']);
    expect(restFetch).toHaveBeenCalledTimes(2);
    expect(restFetch.mock.calls[1][0]).toBe('/notifications?page=2');
    // continuationUrl is persisted mid-poll so an interrupted poll can resume.
    expect(persistPollState).toHaveBeenCalledWith(expect.objectContaining({ continuationUrl: '/notifications?page=2' }));

    // commitNotificationFetch() finalizes the checkpoint only after the caller
    // has durably processed the returned notifications.
    await adapter.commitNotificationFetch();
    expect(persistPollState).toHaveBeenCalledWith(expect.objectContaining({
      checkpointSince: expect.any(String),
      continuationUrl: undefined,
      pendingSince: undefined,
    }));
  });

  it('rejects a malformed notification id as non-retryable and marks a 429 response as retryable', async () => {
    const { adapter } = createAdapter();
    await expect(adapter.writeNotificationAction('not-a-valid-id', 'mark_read'))
      .rejects.toMatchObject({ retryable: false });

    const restFetch = vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'retry-after': '30' },
    }));
    const { adapter: rateLimited } = createAdapter({ restFetch });
    await expect(rateLimited.writeNotificationAction('gh-notif-42', 'mark_read'))
      .rejects.toMatchObject({ retryable: true, status: 429 });
    expect(restFetch).toHaveBeenCalledWith('/notifications/threads/42', expect.objectContaining({ method: 'PATCH' }));
  });

  it('markNotificationRead() delegates to writeNotificationAction("mark_read")', async () => {
    const restFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const { adapter } = createAdapter({ restFetch });
    await adapter.markNotificationRead('gh-notif-7');
    expect(restFetch).toHaveBeenCalledWith('/notifications/threads/7', expect.objectContaining({ method: 'PATCH' }));
  });

  it('resetForDispose() clears reason/participation filters and poll state, matching the pre-extraction connector', async () => {
    const restFetch = vi.fn<GitHubClient['restFetch']>(async () => new Response(JSON.stringify([
      githubNotification({ id: '1', reason: 'mention' }),
      githubNotification({ id: '2', reason: 'ci_activity' }),
    ]), { status: 200 }));
    const { adapter } = createAdapter({ restFetch });
    adapter.configure({
      fetchNotificationsEnabled: true,
      notificationReasons: ['mention'],
      participatingOnly: true,
      authenticatedUser: 'octocat',
      notificationPollState: { checkpointSince: '2026-08-01T00:00:00.000Z' },
    });

    // Before reset: reason filter narrows to just the configured reason.
    const before = await adapter.fetchNotifications(new Date('2026-08-01T00:00:00.000Z'));
    expect(before.map((n) => n.sourceId)).toEqual(['1']);
    expect(restFetch.mock.calls[0][0]).toContain('participating=true');

    adapter.resetForDispose();

    // After reset: no reason filter (both notifications pass through) and
    // participating=true is no longer appended to the request URL.
    const after = await adapter.fetchNotifications(new Date('2026-08-01T00:00:00.000Z'));
    expect(after.map((n) => n.sourceId).sort()).toEqual(['1', '2']);
    const lastCallUrl = restFetch.mock.calls[restFetch.mock.calls.length - 1][0] as string;
    expect(lastCallUrl).not.toContain('participating=true');
  });

  it('propagates a thrown ConnectorWritebackError instance (not a generic Error) for status-code introspection', async () => {
    const { adapter } = createAdapter();
    try {
      await adapter.writeNotificationAction('bad-id', 'mark_read');
      expect.unreachable('expected writeNotificationAction to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorWritebackError);
    }
  });
});
