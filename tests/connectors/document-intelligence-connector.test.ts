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

      await expect(connector.dismissAlert('eob-42')).rejects.toThrow('OWL request failed');
    });
  });

  describe('completeTask', () => {
    it('calls PATCH with status "completed"', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.completeTask('act-1');

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain('/api/action-queue/actions/act-1');
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'completed' });
    });
  });

  describe('updateTask', () => {
    it('writes back completed status to OWL', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.updateTask('act-1', { status: 'done' });

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'completed' });
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

    it('writes back pending when a task is reopened', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.updateTask('act-1', { status: 'todo' });

      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) => (call[1] as RequestInit)?.method === 'PATCH'
      );
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ status: 'pending' });
    });

    it('rejects statuses OWL cannot represent', async () => {
      const connector = await createConnector();

      await expect(connector.updateTask('act-1', { status: 'in_progress' }))
        .rejects.toThrow('OWL does not support task status "in_progress"');
      expect(fetchMock).not.toHaveBeenCalled();
    });
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

    it('paginates the flat OWL response by offset and uses updated_at freshness', async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: `act-${index + 1}`,
        document_id: index + 1,
        document_title: `Invoice ${index + 1}`,
        action_type: 'pay',
        urgency: 'high',
        amount: 250,
        summary: 'Pay invoice',
        status: 'pending',
        created_at: '2026-07-20T12:00:00Z',
        updated_at: '2026-08-20T12:00:00Z',
      }));
      const secondPage = [{
          id: 'act-101',
          document_id: 101,
          document_title: 'Reply',
          action_type: 'respond',
          urgency: 'medium',
          summary: 'Reply to letter',
          status: 'completed',
          created_at: '2026-07-20T12:00:00Z',
          updated_at: '2026-08-21T12:00:00Z',
      }];
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(secondPage), { status: 200 }));
      const connector = await createConnector();

      const tasks = (await Array.fromAsync(
        connector.fetchTasks(new Date('2026-08-01T00:00:00Z')),
      )).flat();

      expect(tasks).toHaveLength(101);
      expect(tasks.at(-1)?.status).toBe('done');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0][0])).toContain('status=all');
      expect(String(fetchMock.mock.calls[0][0])).toContain('offset=0');
      expect(String(fetchMock.mock.calls[1][0])).toContain('offset=100');
    });

    it('reconciles legacy actions without updated_at during incremental pulls', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 'act-legacy',
        document_id: 44,
        document_title: 'Legacy bill',
        action_type: 'pay',
        urgency: 'low',
        summary: 'Legacy action completed after creation',
        status: 'completed',
        created_at: '2026-01-01T12:00:00Z',
      }]), { status: 200 }));
      const connector = await createConnector();

      const tasks = (await Array.fromAsync(
        connector.fetchTasks(new Date('2026-08-01T00:00:00Z')),
      )).flat();

      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        sourceId: 'act-legacy',
        status: 'done',
      });
    });
  });

  describe('OWL task actions', () => {
    it('sends source-side snooze and classifier feedback payloads', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const connector = await createConnector();

      await connector.snoozeAction('act-1', '2026-08-23T13:00:00.000Z');
      await connector.submitActionFeedback('act-1', { feedback_type: 'not_an_action' });
      await connector.submitActionFeedback('act-1', {
        feedback_type: 'wrong_amount',
        corrected_amount: 125.5,
      });

      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('/api/action-queue/actions/act-1/snooze'),
        expect.stringContaining('/api/action-queue/actions/act-1/feedback'),
        expect.stringContaining('/api/action-queue/actions/act-1/feedback'),
      ]);
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
        until: '2026-08-23T13:00:00.000Z',
      });
      expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
        feedback_type: 'wrong_amount',
        corrected_amount: 125.5,
      });
    });
  });

  describe('fetchTriageItems', () => {
    it('paginates the complete pending action queue', async () => {
      const makeAction = (index: number) => ({
        id: `triage-${index}`,
        document_id: index,
        document_title: `Document ${index}`,
        action_type: 'review',
        urgency: 'medium',
        summary: `Review document ${index}`,
        status: 'pending',
        created_at: '2026-08-20T12:00:00Z',
        updated_at: '2026-08-20T12:00:00Z',
      });
      fetchMock
        .mockResolvedValueOnce(new Response(
          JSON.stringify(Array.from({ length: 100 }, (_, index) => makeAction(index))),
          { status: 200 },
        ))
        .mockResolvedValueOnce(new Response(JSON.stringify([makeAction(100)]), { status: 200 }));
      const connector = await createConnector();

      const items = await connector.fetchTriageItems();

      expect(items).toHaveLength(101);
      expect(String(fetchMock.mock.calls[0][0])).toContain('status=pending');
      expect(String(fetchMock.mock.calls[1][0])).toContain('offset=100');
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
