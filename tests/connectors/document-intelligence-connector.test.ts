/**
 * Document Intelligence Connector Tests — Phase 2 (#715)
 *
 * Verifies alert dismissal writeback: MC dismiss → DI API sync,
 * task completion writeback, and error handling when DI is unreachable.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { ConnectorConfig, ConnectorCapabilities } from '@/types';

// Track all fetch calls for assertions
const fetchMock = vi.fn();
beforeAll(() => {
  global.fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
  // Each call gets its own fresh Response to avoid "body already used" errors
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
  );
});

const BASE_CONFIG: ConnectorConfig = {
  id: 'di-test-1',
  type: 'document-intelligence',
  name: 'Test DI',
  enabled: true,
  syncMode: 'poll',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: true,
    tagWriteBack: false,
  } as ConnectorCapabilities,
  credentials: { apiKey: 'test-key' },
  settings: {
    baseUrl: 'http://document-intelligence.example:8200',
    paperlessBaseUrl: 'http://paperless.example:8000',
    modules: { actionQueue: true, statements: true, eobMatching: true },
  },
  syncedLists: [],
};

describe('DocumentIntelligenceConnector', () => {
  async function createConnector(config = BASE_CONFIG) {
    const { DocumentIntelligenceConnector } = await import(
      '@/lib/connectors/document-intelligence/index'
    );
    const connector = new DocumentIntelligenceConnector();
    await connector.initialize(config);
    return connector;
  }

  describe('dismissAlert', () => {
    it('calls PATCH on DI API for EOB alerts', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.dismissAlert('eob-42');

      // Find the PATCH call (not the initialization calls)
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain('/api/action-queue/actions/42');
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'dismissed' });
    });

    it('calls PATCH on DI API for action alerts', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.dismissAlert('action-99');

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain('/api/action-queue/actions/99');
    });

    it('skips writeback for statement alerts (informational)', async () => {
      const connector = await createConnector();

      await connector.dismissAlert('stmt-5');

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeUndefined();
    });

    it('throws when DI API returns error', async () => {
      const connector = await createConnector();
      fetchMock.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      await expect(connector.dismissAlert('eob-42')).rejects.toThrow('OWL update failed');
    });
  });

  describe('completeTask', () => {
    it('calls PATCH with status "done"', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.completeTask('act-1');

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain('/api/action-queue/actions/act-1');
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'done' });
    });
  });

  describe('updateTask', () => {
    it('writes back "done" status to DI', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.updateTask('act-1', { status: 'done' });

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'done' });
    });

    it('writes back "dismissed" for cancelled status', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.updateTask('act-1', { status: 'cancelled' });

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'dismissed' });
    });

    it.each(['todo', 'in_progress'] as const)(
      'writes back "pending" when status changes to %s',
      async (status) => {
        fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
        const connector = await createConnector();

        await connector.updateTask('act-1', { status });

        const patchCall = fetchMock.mock.calls.find(
          (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
        );
        expect(patchCall).toBeDefined();
        expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'pending' });
      },
    );
  });

  describe('fetchTasks', () => {
    it('maps DI actions to TaskItems with preview metadata', async () => {
      const actions = [{
        id: 'act-1',
        document_id: 42,
        document_title: 'Invoice #123',
        action_type: 'pay',
        urgency: 'high',
        due_date: '2026-07-30',
        amount: 250,
        correspondent: 'Acme Corp',
        summary: 'Pay invoice',
        status: 'pending',
        created_at: '2026-07-20T12:00:00Z',
        document_url: 'http://paperless.example:8000/documents/42',
      }];

      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(actions), { status: 200 }))
      );
      const connector = await createConnector();

      const tasks = (await Array.fromAsync(connector.fetchTasks())).flat();

      expect(tasks).toHaveLength(1);
      expect(tasks[0].metadata.previewUrl).toBe('http://paperless.example:8000/api/documents/42/preview/');
      expect(tasks[0].metadata.previewType).toBe('pdf');
      expect(tasks[0].metadata.previewLabel).toBe('View in Paperless-ngx');
    });
  });

  describe('fetchNotifications', () => {
    it('maps missing statements to notifications with preview metadata', async () => {
      const statements = [{
        id: 1,
        correspondent: 'First National Bank',
        correspondent_id: 7,
        expected_period: '2026-06',
        frequency: 'monthly',
        last_received_date: '2026-05-15',
        days_overdue: 20,
      }];

      // First call returns statements, second returns empty EOBs
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(statements), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const connector = await createConnector();
      const notifications = await connector.fetchNotifications();

      expect(notifications.length).toBeGreaterThanOrEqual(1);
      const stmtNotification = notifications.find(a => a.id.includes('stmt'));
      expect(stmtNotification).toBeDefined();
      expect(stmtNotification!.metadata.previewUrl).toContain('paperless.example');
      expect(stmtNotification!.metadata.previewType).toBe('external');
      expect(stmtNotification!.metadata.previewLabel).toBe('View in Paperless-ngx');
    });

    it('maps unmatched EOBs to notifications with preview metadata', async () => {
      const eobs = [{
        id: 1,
        provider: 'Dr. Smith',
        amount: 350,
        date_of_service: '2026-06-15',
        patient_responsibility: 125,
        document_url: 'http://paperless.example:8000/documents/99',
        created_at: '2026-07-01T10:00:00Z',
      }];

      // First call returns empty statements, second returns EOBs
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(eobs), { status: 200 }));

      const connector = await createConnector();
      const notifications = await connector.fetchNotifications();

      expect(notifications.length).toBeGreaterThanOrEqual(1);
      const eobNotification = notifications.find(a => a.id.includes('eob'));
      expect(eobNotification).toBeDefined();
      expect(eobNotification!.metadata.previewUrl).toBe('http://paperless.example:8000/documents/99');
      expect(eobNotification!.metadata.previewType).toBe('external');
      expect(eobNotification!.metadata.previewLabel).toBe('View in Paperless-ngx');
    });
  });

  describe('testConnection', () => {
    it('succeeds when DI API is reachable', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })));
      const connector = await createConnector();
      const result = await connector.testConnection();
      expect(result.success).toBe(true);
    });

    it('fails when DI API is unreachable', async () => {
      // Use single-module config to avoid unhandled parallel rejections
      const singleModuleConfig = {
        ...BASE_CONFIG,
        settings: {
          ...BASE_CONFIG.settings,
          modules: { actionQueue: true, statements: false, eobMatching: false },
        },
      };
      fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
      const connector = await createConnector(singleModuleConfig);
      const result = await connector.testConnection();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Connection failed');
    });
  });
});
