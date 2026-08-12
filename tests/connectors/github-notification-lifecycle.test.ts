import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-github-notifications-'));
process.env.MC_DB_PATH = join(testDirectory, 'github-notifications.db');

describe('GitHub notification lifecycle', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let GitHubIssuesConnector: typeof import(
    '@/lib/connectors/github-issues'
  ).GitHubIssuesConnector;

  beforeAll(async () => {
    vi.resetModules();
    const database = await import('@/db');
    const schemaModule = await import('@/db/schema');
    const connectorModule = await import('@/lib/connectors/github-issues');
    db = database.default;
    sqlite = database.sqlite;
    schema = schemaModule;
    GitHubIssuesConnector = connectorModule.GitHubIssuesConnector;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    sqlite?.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.MC_DB_PATH;
  });

  async function createConnector(
    id: string,
    notificationPollState?: Record<string, unknown>,
  ) {
    const now = new Date().toISOString();
    const settings = {
      repos: [],
      fetchNotifications: true,
      ...(notificationPollState ? { notificationPollState } : {}),
    };
    const config: ConnectorConfig = {
      id,
      type: 'github-issues',
      name: id,
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: {} as import('@/types').ConnectorCapabilities,
      credentials: { token: `token-${id}` },
      settings,
      syncedLists: [],
    };
    await db.insert(schema.connectorConfigs).values({
      ...config,
      capabilities: config.capabilities,
      credentials: config.credentials,
      settings,
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    return connector;
  }

  it('preserves provider read state, source activity, and unknown reasons', async () => {
    const connector = await createConnector('github-read-state');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      id: 'thread-1',
      reason: 'future_reason',
      subject: { title: 'New provider event', type: 'Issue', url: null },
      repository: { full_name: 'octo/repo' },
      updated_at: '2026-08-10T12:00:00.000Z',
      unread: false,
      last_read_at: '2026-08-10T12:01:00.000Z',
    }]), {
      status: 200,
      headers: {
        etag: '"feed-v1"',
        'last-modified': 'Mon, 10 Aug 2026 12:00:00 GMT',
        'x-poll-interval': '60',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const notifications = await connector.fetchNotifications(
      new Date('2026-08-09T00:00:00.000Z'),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      isRead: true,
      sourceActivityAt: '2026-08-10T12:00:00.000Z',
      sourceActivityKey: 'thread-1:2026-08-10T12:00:00.000Z',
      metadata: {
        reason: 'future_reason',
        reasonKnown: false,
      },
    });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    expect(calls[0]?.[0]).toContain('all=true&per_page=50');
    const beforeCommit = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get('github-read-state') as { settings: string };
    const settingsBeforeCommit = JSON.parse(beforeCommit.settings);
    expect(settingsBeforeCommit.notificationPollState.checkpointSince)
      .toBeUndefined();
    sqlite.prepare('UPDATE connector_configs SET settings = ? WHERE id = ?').run(
      JSON.stringify({ ...settingsBeforeCommit, concurrentSetting: 'preserved' }),
      'github-read-state',
    );
    await connector.commitNotificationFetch();
    const stored = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get('github-read-state') as { settings: string };
    expect(JSON.parse(stored.settings)).toMatchObject({
      notificationPollState: {
        checkpointSince: expect.any(String),
        etag: '"feed-v1"',
        pollIntervalSeconds: 60,
      },
      concurrentSetting: 'preserved',
    });
  });

  it('restarts an incomplete window instead of advancing beyond a failed page', async () => {
    const connector = await createConnector('github-pagination');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          link: '<https://api.github.com/notifications?page=2>; rel="next"',
          etag: '"incomplete-feed"',
        },
      }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(connector.fetchNotifications(
      new Date('2026-08-08T00:00:00.000Z'),
    )).rejects.toThrow('HTTP 503');

    const row = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get('github-pagination') as { settings: string };
    const settings = JSON.parse(row.settings);
    expect(settings.notificationPollState).toMatchObject({
      pendingSince: '2026-08-08T00:00:00.000Z',
      continuationUrl: '/notifications?page=2',
    });
    expect(settings.notificationPollState.checkpointSince).toBeUndefined();
    expect(settings.notificationPollState.etag).toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await connector.fetchNotifications(new Date('2026-08-09T00:00:00.000Z'));
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    expect(new Headers(calls[2]?.[1]?.headers).get('if-none-match')).toBeNull();
    await connector.commitNotificationFetch();
    const completed = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get('github-pagination') as { settings: string };
    expect(JSON.parse(completed.settings).notificationPollState).toMatchObject({
      checkpointSince: expect.any(String),
    });
  });

  it('sends conditional headers and treats 304 as a completed poll', async () => {
    const connector = await createConnector('github-conditional', {
      checkpointSince: '2026-08-09T00:00:00.000Z',
      etag: '"feed-v2"',
      lastModified: 'Sun, 09 Aug 2026 00:00:00 GMT',
    });
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 304,
      headers: { 'x-poll-interval': '120' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(connector.fetchNotifications()).resolves.toEqual([]);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const request = calls[0]?.[1] ?? {};
    expect(new Headers(request.headers).get('if-none-match')).toBe('"feed-v2"');
    expect(new Headers(request.headers).get('if-modified-since'))
      .toBe('Sun, 09 Aug 2026 00:00:00 GMT');
  });

  it('maps provider lifecycle actions to their exact GitHub endpoints', async () => {
    const connector = await createConnector('github-actions');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await connector.writeNotificationAction('gh-notif-42', 'mark_read');
    await connector.writeNotificationAction('gh-notif-42', 'mark_done');
    await connector.writeNotificationAction('gh-notif-42', 'mute');
    await connector.writeNotificationAction('gh-notif-42', 'unmute');
    await expect(connector.writeNotificationAction('gh-notif-thread', 'mark_read'))
      .rejects.toMatchObject({ retryable: false });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    expect(calls.map(([url, request = {}]) => [
      new URL(String(url)).pathname,
      request.method,
      request.body,
    ])).toEqual([
      ['/notifications/threads/42', 'PATCH', undefined],
      ['/notifications/threads/42', 'DELETE', undefined],
      ['/notifications/threads/42/subscription', 'PUT', '{"ignored":true}'],
      ['/notifications/threads/42/subscription', 'PUT', '{"ignored":false}'],
    ]);
  });

  it('classifies authentication failures as terminal and rate limits as retryable', async () => {
    const connector = await createConnector('github-errors');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { 'retry-after': '30' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(connector.writeNotificationAction('42', 'mark_read'))
      .rejects.toMatchObject({ retryable: false, status: 401 });
    await expect(connector.writeNotificationAction('42', 'mark_done'))
      .rejects.toMatchObject({
        retryable: true,
        retryAt: expect.any(Date),
        status: 429,
      });
  });

  it('persists a bounded provider-directed polling retry without advancing the cursor', async () => {
    const connector = await createConnector('github-poll-rate-limit');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'retry-after': '120' },
    })));
    const startedAt = Date.now();

    await expect(connector.fetchNotifications(new Date('2026-08-11T00:00:00.000Z')))
      .rejects.toThrow('HTTP 429');

    const row = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get('github-poll-rate-limit') as { settings: string };
    const pollState = JSON.parse(row.settings).notificationPollState;
    expect(pollState).toMatchObject({
      pendingSince: '2026-08-11T00:00:00.000Z',
    });
    expect(pollState.checkpointSince).toBeUndefined();
    expect(Date.parse(pollState.nextPollAt)).toBeGreaterThanOrEqual(startedAt + 119_000);
    expect(Date.parse(pollState.nextPollAt)).toBeLessThanOrEqual(startedAt + 121_000);
  });
});
