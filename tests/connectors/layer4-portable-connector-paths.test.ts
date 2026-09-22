import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCapabilities, ConnectorConfig } from '@/types';

/**
 * Layer 4 reachability proof for the non-finance connectors that own *no*
 * worker persistence table: Rymessage (notification-only) and OWL
 * (`document-intelligence`).
 *
 * Their normal production paths must run entirely on remote transport plus the
 * portable Layer 2 list/task/tag/notification ports, so they work unchanged on
 * either backend. `@/db` throws on any access here, and every credential is an
 * inert placeholder pointing at a stubbed transport — no real endpoint is
 * contacted.
 */

const sqliteTouch = vi.fn();

vi.mock('@/db', () => ({
  get sqlite() {
    sqliteTouch();
    throw new Error('Mission Control SQLite must not be reachable from a connector fetch');
  },
  get db() {
    sqliteTouch();
    throw new Error('Mission Control SQLite must not be reachable from a connector fetch');
  },
  get default() {
    sqliteTouch();
    throw new Error('Mission Control SQLite must not be reachable from a connector fetch');
  },
}));

const CAPABILITIES = {
  read: true,
  write: false,
  delete: false,
  sync: true,
  subtasks: false,
  lists: true,
  tags: true,
  tagWriteBack: false,
} as ConnectorCapabilities;

describe('Layer 4 portable connector paths — Rymessage', () => {
  const config: ConnectorConfig = {
    id: 'rymessage-portable',
    type: 'rymessage',
    name: 'RyMessage',
    enabled: true,
    syncMode: 'poll',
    capabilities: CAPABILITIES,
    // Inert placeholder credential aimed at a stubbed local transport.
    credentials: {},
    settings: {
      mode: 'rest',
      restUrl: 'http://rymessage.invalid:9999',
      apiKey: 'inert-test-key',
      minConfidence: 0.5,
    },
    syncedLists: [],
  };

  it('maps Action Center records to notifications without Mission Control persistence', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      id: 'action-1',
      stable_key: 'action-1',
      chat_guid: 'chat-1',
      action_type: 'reply',
      kind: 'reply',
      title: 'Confirm the vendor call',
      summary: 'Reply to the scheduling request',
      confidence_score: 0.92,
      lifecycle_state: 'visible',
      created_at: '2026-08-07T17:00:00.000Z',
      updated_at: '2026-08-07T18:00:00.000Z',
    }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { rymessageFactory } = await import('@/lib/connectors/rymessage');
      const connector = rymessageFactory.create();
      await connector.initialize(config);

      const notifications = await connector.fetchNotifications!();
      const lists = await connector.fetchSourceLists!();

      expect(fetchMock).toHaveBeenCalled();
      expect(notifications.length).toBeGreaterThan(0);
      expect(notifications[0].connectorType).toBe('rymessage');
      expect(lists).toEqual([expect.objectContaining({ sourceId: 'action-center' })]);
      expect(sqliteTouch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stays inert in webhook mode without reading any database', async () => {
    const { rymessageFactory } = await import('@/lib/connectors/rymessage');
    const connector = rymessageFactory.create();
    await connector.initialize({
      ...config,
      settings: { mode: 'webhook', minConfidence: 0.5 },
    });

    await expect(connector.testConnection()).resolves.toMatchObject({ success: true });
    await expect(connector.fetchNotifications!()).resolves.toEqual([]);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('Layer 4 portable connector paths — OWL document intelligence', () => {
  const config: ConnectorConfig = {
    id: 'owl-portable',
    type: 'document-intelligence',
    name: 'OWL',
    enabled: true,
    syncMode: 'poll',
    capabilities: CAPABILITIES,
    // Inert placeholder credential aimed at a stubbed local transport.
    credentials: { apiKey: 'inert-test-key' },
    settings: {
      baseUrl: 'http://owl.invalid:8200',
      paperlessBaseUrl: 'http://paperless.invalid:8000',
      modules: { actionQueue: true, statements: false, eobMatching: false },
    },
    syncedLists: [],
  };

  it('produces tasks, lists, tags, and notifications with no worker-owned table', async () => {
    const action = {
      id: 'owl-action-1',
      title: 'File the statement',
      action_type: 'file',
      status: 'pending',
      urgency: 'normal',
      priority: 'high',
      created_at: '2026-08-07T17:00:00.000Z',
      updated_at: '2026-08-07T18:00:00.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/api/action-queue/actions')) {
        return new Response(JSON.stringify([action]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { documentIntelligenceFactory } = await import(
        '@/lib/connectors/document-intelligence'
      );
      const connector = documentIntelligenceFactory.create();
      await connector.initialize(config);

      const pages: unknown[][] = [];
      for await (const page of connector.fetchTasks!()) pages.push(page);
      const lists = await connector.fetchSourceLists!();
      const tags = await connector.fetchSourceTags!();
      const notifications = await connector.fetchNotifications!();

      expect(fetchMock).toHaveBeenCalled();
      expect(pages.flat()).toEqual([
        expect.objectContaining({
          connectorType: 'document-intelligence',
          connectorInstanceId: 'owl-portable',
        }),
      ]);
      expect(Array.isArray(lists)).toBe(true);
      expect(Array.isArray(tags)).toBe(true);
      expect(Array.isArray(notifications)).toBe(true);
      expect(sqliteTouch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
