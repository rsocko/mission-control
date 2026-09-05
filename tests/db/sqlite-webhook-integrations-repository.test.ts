import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { WebhookIntegrationsPersistence } from '@/db/persistence/webhook-integrations';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

const BASE_TIME = '2026-09-04T12:00:00.000Z';
const WEBHOOK_ID = 'inbound-webhook-1';

let sqlite: Database.Database;
let repository: WebhookIntegrationsPersistence;

beforeAll(async () => {
  const database = await importInitializedSqliteDatabase();
  sqlite = database.sqlite;
  const { createSqliteWebhookIntegrationsRepository } = await import(
    '@/db/persistence/sqlite-webhook-integrations-repository'
  );
  repository = createSqliteWebhookIntegrationsRepository(sqlite, database.default);
});

afterAll(async () => {
  sqlite.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM inbound_webhook_replays;
    DELETE FROM inbound_webhook_log;
    DELETE FROM inbound_webhooks;
    DELETE FROM outbound_webhooks;
    DELETE FROM integration_configs;
    DELETE FROM external_agents;
    DELETE FROM notification_push_rules;
    DELETE FROM notification_actions;
    DELETE FROM notifications;
    DELETE FROM tasks;
    DELETE FROM sync_log;
    DELETE FROM connector_configs;
  `);
});

async function seedWebhook(overrides: { id?: string; secret?: string | null } = {}) {
  await repository.inbound.create({
    id: overrides.id ?? WEBHOOK_ID,
    name: 'Home Server',
    sourceLabel: 'Automation',
    secret: overrides.secret === undefined ? 'shhh' : overrides.secret,
    defaultAction: 'auto',
    fieldMappings: { title: 'data.title' },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  });
}

function seedExternalAgent(webhookId: string, deletedAt: string | null = null) {
  sqlite.prepare(`
    INSERT INTO external_agents (
      id, name, type, transport, execution_locality, auth_type, capabilities,
      input_format, output_format, inbound_webhook_id, data_policy, enabled,
      created_at, updated_at, deleted_at
    ) VALUES (
      'agent-1', 'Reviewer', 'manual', 'webhook', 'remote', 'none', '{}',
      'mc-tasks', 'mc-tasks', ?, '{}', 1, ?, ?, ?
    )
  `).run(webhookId, BASE_TIME, BASE_TIME, deletedAt);
}

function logRow(id: string, receivedAt: string, status = 'success') {
  return {
    id,
    webhookId: WEBHOOK_ID,
    status,
    httpStatus: 201,
    createdType: 'task',
    createdId: `task-${id}`,
    errorMessage: null,
    payloadPreview: '{"ok":true}',
    receivedAt,
  };
}

describe('sqlite webhook integrations repository', () => {
  describe('inbound webhook configuration', () => {
    it('lists webhooks redacted, newest first, with a stable id tie-breaker', async () => {
      await seedWebhook({ id: 'webhook-b', secret: 'kept' });
      await repository.inbound.create({
        id: 'webhook-a',
        name: 'Second',
        sourceLabel: 'webhook',
        secret: null,
        defaultAction: 'task',
        fieldMappings: {},
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
      });

      const webhooks = await repository.inbound.list();

      expect(webhooks.map((webhook) => webhook.id)).toEqual(['webhook-b', 'webhook-a']);
      expect(webhooks[0]).toMatchObject({
        id: 'webhook-b',
        name: 'Home Server',
        sourceLabel: 'Automation',
        enabled: true,
        defaultAction: 'auto',
        fieldMappings: { title: 'data.title' },
        totalReceived: 0,
        lastReceivedAt: null,
        lastStatus: null,
        hasSecret: true,
      });
      expect(webhooks[1].hasSecret).toBe(false);
      expect(webhooks.every((webhook) => !('secret' in webhook))).toBe(true);
    });

    it('applies only the supplied patch fields and always stamps updatedAt', async () => {
      await seedWebhook();

      const outcome = await repository.inbound.update({
        id: WEBHOOK_ID,
        patch: { name: 'Renamed', enabled: false },
        updatedAt: '2026-09-05T00:00:00.000Z',
      });

      expect(outcome).toBe('updated');
      const stored = sqlite.prepare(
        'SELECT name, source_label AS sourceLabel, enabled, secret, updated_at AS updatedAt'
        + ' FROM inbound_webhooks WHERE id = ?',
      ).get(WEBHOOK_ID);
      expect(stored).toMatchObject({
        name: 'Renamed',
        sourceLabel: 'Automation',
        enabled: 0,
        secret: 'shhh',
        updatedAt: '2026-09-05T00:00:00.000Z',
      });
    });

    it('refuses to clear a secret an active external agent depends on', async () => {
      await seedWebhook();
      seedExternalAgent(WEBHOOK_ID);

      const outcome = await repository.inbound.update({
        id: WEBHOOK_ID,
        patch: { name: 'Renamed', secret: null },
        updatedAt: '2026-09-05T00:00:00.000Z',
      });

      expect(outcome).toBe('secret-referenced');
      expect(sqlite.prepare('SELECT secret, name FROM inbound_webhooks WHERE id = ?')
        .get(WEBHOOK_ID)).toMatchObject({ secret: 'shhh', name: 'Home Server' });
    });

    it('clears the secret when the referencing agent is soft deleted', async () => {
      await seedWebhook();
      seedExternalAgent(WEBHOOK_ID, BASE_TIME);

      expect(await repository.inbound.update({
        id: WEBHOOK_ID,
        patch: { secret: null },
        updatedAt: '2026-09-05T00:00:00.000Z',
      })).toBe('updated');
      expect(sqlite.prepare('SELECT secret FROM inbound_webhooks WHERE id = ?')
        .get(WEBHOOK_ID)).toEqual({ secret: null });
    });

    it('deletes the webhook and its push rules in one transaction', async () => {
      await seedWebhook();
      sqlite.prepare(`
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level, preview,
          max_per_hour, created_at, updated_at
        ) VALUES ('rule-1', ?, '*', 1, 'urgent', 'title_only', NULL, ?, ?)
      `).run(WEBHOOK_ID, BASE_TIME, BASE_TIME);

      expect(await repository.inbound.delete(WEBHOOK_ID)).toBe('deleted');
      expect(sqlite.prepare('SELECT count(*) AS count FROM inbound_webhooks').get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare(
        'SELECT count(*) AS count FROM notification_push_rules WHERE connector_instance_id = ?',
      ).get(WEBHOOK_ID)).toEqual({ count: 0 });
    });

    it('leaves the webhook and its push rules intact when an agent still references it', async () => {
      await seedWebhook();
      seedExternalAgent(WEBHOOK_ID);
      sqlite.prepare(`
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level, preview,
          max_per_hour, created_at, updated_at
        ) VALUES ('rule-1', ?, '*', 1, 'urgent', 'title_only', NULL, ?, ?)
      `).run(WEBHOOK_ID, BASE_TIME, BASE_TIME);

      expect(await repository.inbound.delete(WEBHOOK_ID)).toBe('agent-referenced');
      expect(sqlite.prepare('SELECT count(*) AS count FROM inbound_webhooks').get())
        .toEqual({ count: 1 });
      expect(sqlite.prepare('SELECT count(*) AS count FROM notification_push_rules').get())
        .toEqual({ count: 1 });
    });

    it('returns the verification secret only on the delivery-config read', async () => {
      await seedWebhook();

      await expect(repository.inbound.findForDelivery(WEBHOOK_ID)).resolves.toEqual({
        id: WEBHOOK_ID,
        name: 'Home Server',
        sourceLabel: 'Automation',
        secret: 'shhh',
        enabled: true,
        defaultAction: 'auto',
        fieldMappings: { title: 'data.title' },
      });
      await expect(repository.inbound.findForDelivery('missing')).resolves.toBeNull();
    });
  });

  describe('delivery log', () => {
    beforeEach(async () => {
      await seedWebhook();
    });

    it('orders entries by received_at desc with a stable id tie-breaker', async () => {
      for (const entry of [
        logRow('log-a', '2026-09-04T10:00:00.000Z'),
        logRow('log-c', '2026-09-04T11:00:00.000Z'),
        logRow('log-b', '2026-09-04T11:00:00.000Z'),
      ]) {
        await repository.inbound.appendLog({ entry, compaction: null });
      }

      const entries = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 10 });
      expect(entries.map((entry) => entry.id)).toEqual(['log-c', 'log-b', 'log-a']);
      expect(entries[2]).toMatchObject({
        webhookId: WEBHOOK_ID,
        status: 'success',
        httpStatus: 201,
        createdType: 'task',
        payloadPreview: '{"ok":true}',
      });
    });

    it('persists failure entries with their status and message', async () => {
      await repository.inbound.appendLog({
        entry: {
          id: 'log-error',
          webhookId: WEBHOOK_ID,
          status: 'error',
          httpStatus: 500,
          createdType: null,
          createdId: null,
          errorMessage: 'Processing failed',
          payloadPreview: '[unparseable payload omitted]',
          receivedAt: BASE_TIME,
        },
        compaction: null,
      });

      const [entry] = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 10 });
      expect(entry).toMatchObject({
        status: 'error',
        httpStatus: 500,
        errorMessage: 'Processing failed',
        createdType: null,
        createdId: null,
      });
    });

    it('compacts by retention cutoff and by the newest retained window', async () => {
      for (const entry of [
        logRow('log-old', '2026-01-01T00:00:00.000Z'),
        logRow('log-1', '2026-09-04T10:00:00.000Z'),
        logRow('log-2', '2026-09-04T11:00:00.000Z'),
      ]) {
        await repository.inbound.appendLog({ entry, compaction: null });
      }

      await repository.inbound.appendLog({
        entry: logRow('log-3', '2026-09-04T12:00:00.000Z'),
        compaction: { retentionCutoff: '2026-06-01T00:00:00.000Z', retainLatest: 2 },
      });

      const entries = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 10 });
      expect(entries.map((entry) => entry.id)).toEqual(['log-3', 'log-2']);
    });

    it('honours the requested limit', async () => {
      for (const entry of [
        logRow('log-1', '2026-09-04T10:00:00.000Z'),
        logRow('log-2', '2026-09-04T11:00:00.000Z'),
      ]) {
        await repository.inbound.appendLog({ entry, compaction: null });
      }

      const entries = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 1 });
      expect(entries.map((entry) => entry.id)).toEqual(['log-2']);
    });
  });

  describe('replay claims', () => {
    function claim(overrides: { id?: string; receivedAt?: string; expiresAt?: string } = {}) {
      const receivedAt = overrides.receivedAt ?? BASE_TIME;
      return repository.inbound.claimDelivery({
        id: overrides.id ?? crypto.randomUUID(),
        webhookId: WEBHOOK_ID,
        deliveryKey: 'payload:abc',
        receivedAt,
        expiresAt: overrides.expiresAt
          ?? new Date(Date.parse(receivedAt) + 5 * 60 * 1_000).toISOString(),
        sweepExpiredBefore: null,
      });
    }

    it('claims once and rejects the replay inside the five-minute window', async () => {
      await expect(claim()).resolves.toBe(true);
      await expect(claim({ receivedAt: '2026-09-04T12:04:59.000Z' })).resolves.toBe(false);
      expect(sqlite.prepare('SELECT count(*) AS count FROM inbound_webhook_replays').get())
        .toEqual({ count: 1 });
    });

    it('is idempotent under concurrent claims of the same delivery key', async () => {
      const results = await Promise.all([claim(), claim(), claim()]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('re-claims once the window has expired', async () => {
      await expect(claim()).resolves.toBe(true);
      await expect(claim({ receivedAt: '2026-09-04T12:05:01.000Z' })).resolves.toBe(true);
    });

    it('releases a claim so the same payload can be retried immediately', async () => {
      await expect(claim()).resolves.toBe(true);
      await repository.inbound.releaseDelivery({
        webhookId: WEBHOOK_ID,
        deliveryKey: 'payload:abc',
      });
      await expect(claim()).resolves.toBe(true);
    });

    it('sweeps expired claims across every webhook when asked', async () => {
      sqlite.prepare(`
        INSERT INTO inbound_webhook_replays (id, webhook_id, delivery_key, received_at, expires_at)
        VALUES ('stale', 'other-webhook', 'payload:stale', ?, '2026-09-04T11:00:00.000Z')
      `).run(BASE_TIME);

      await repository.inbound.claimDelivery({
        id: 'fresh',
        webhookId: WEBHOOK_ID,
        deliveryKey: 'payload:fresh',
        receivedAt: BASE_TIME,
        expiresAt: '2026-09-04T12:05:00.000Z',
        sweepExpiredBefore: BASE_TIME,
      });

      expect(sqlite.prepare('SELECT id FROM inbound_webhook_replays').all())
        .toEqual([{ id: 'fresh' }]);
    });
  });

  describe('delivery side effects', () => {
    beforeEach(async () => {
      await seedWebhook();
    });

    it('increments the received counter and records the last status', async () => {
      await repository.inbound.recordDeliveryStats({
        webhookId: WEBHOOK_ID,
        receivedAt: BASE_TIME,
        lastStatus: 201,
        updatedAt: BASE_TIME,
      });
      await repository.inbound.recordDeliveryStats({
        webhookId: WEBHOOK_ID,
        receivedAt: '2026-09-04T12:01:00.000Z',
        lastStatus: 500,
        updatedAt: '2026-09-04T12:01:00.000Z',
      });

      expect(sqlite.prepare(
        'SELECT total_received AS totalReceived, last_status AS lastStatus,'
        + ' last_received_at AS lastReceivedAt FROM inbound_webhooks WHERE id = ?',
      ).get(WEBHOOK_ID)).toEqual({
        totalReceived: 2,
        lastStatus: 500,
        lastReceivedAt: '2026-09-04T12:01:00.000Z',
      });
    });

    it('creates the webhook task with its source attribution', async () => {
      await repository.inbound.createTask({
        id: 'task-1',
        sourceId: `inbound:${WEBHOOK_ID}:task-1`,
        connectorType: 'inbound-webhook',
        connectorInstanceId: WEBHOOK_ID,
        title: 'Webhook Task',
        description: null,
        status: 'todo',
        priority: 'none',
        dueDate: null,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        sourceListId: null,
        sourceListName: 'Automation',
        assignee: null,
        metadata: { webhookId: WEBHOOK_ID },
        syncStatus: 'synced',
        lastSyncedAt: BASE_TIME,
      });

      expect(sqlite.prepare(
        'SELECT id, source_id AS sourceId, connector_type AS connectorType,'
        + ' source_list_name AS sourceListName, depth, is_checklist_item AS isChecklistItem'
        + ' FROM tasks WHERE id = ?',
      ).get('task-1')).toEqual({
        id: 'task-1',
        sourceId: `inbound:${WEBHOOK_ID}:task-1`,
        connectorType: 'inbound-webhook',
        sourceListName: 'Automation',
        depth: 0,
        isChecklistItem: 0,
      });
    });

    it('creates the alert and its primary action atomically', async () => {
      const result = await repository.inbound.createAlert({
        notification: {
          id: 'alert-1',
          sourceId: `inbound:${WEBHOOK_ID}:alert-1`,
          connectorType: 'inbound-webhook',
          connectorInstanceId: WEBHOOK_ID,
          title: 'Webhook Alert',
          body: null,
          level: 'fyi',
          category: 'Automation',
          templateKey: null,
          state: 'unread',
          isActionable: true,
          primaryActionId: 'action-1',
          receivedAt: BASE_TIME,
          sortAt: BASE_TIME,
          expiresAt: null,
          metadata: { webhookId: WEBHOOK_ID },
          presentation: {},
        },
        action: {
          id: 'action-1',
          actionType: 'open_url',
          label: 'Open Automation',
          icon: 'external-link',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: { url: 'https://example.test/alert' },
          opensExternal: true,
          createdBy: 'connector',
        },
      });

      expect(result).toMatchObject({ id: 'alert-1', created: true });
      expect(sqlite.prepare(
        'SELECT id, primary_action_id AS primaryActionId, is_actionable AS isActionable'
        + ' FROM notifications WHERE id = ?',
      ).get('alert-1')).toEqual({
        id: 'alert-1',
        primaryActionId: 'action-1',
        isActionable: 1,
      });
      expect(sqlite.prepare(
        'SELECT id, action_type AS actionType FROM notification_actions WHERE notification_id = ?',
      ).all('alert-1')).toEqual([{ id: 'action-1', actionType: 'open_url' }]);
    });
  });

  describe('outbound webhook subscriptions', () => {
    async function seedOutbound(id: string, createdAt: string) {
      await repository.outbound.create({
        id,
        name: `Hook ${id}`,
        url: 'https://example.test/hook',
        secret: 'signing-secret',
        eventTypes: ['sync.completed'],
        createdAt,
      });
    }

    it('creates, lists, finds, patches, and deletes subscriptions', async () => {
      await seedOutbound('outbound-b', '2026-09-04T10:00:00.000Z');
      await seedOutbound('outbound-a', '2026-09-04T11:00:00.000Z');

      const listed = await repository.outbound.list();
      expect(listed.map((webhook) => webhook.id)).toEqual(['outbound-a', 'outbound-b']);
      expect(listed[0]).toMatchObject({
        url: 'https://example.test/hook',
        secret: 'signing-secret',
        eventTypes: ['sync.completed'],
        enabled: true,
        lastTriggeredAt: null,
        lastStatus: null,
      });

      await repository.outbound.update('outbound-a', {
        enabled: false,
        eventTypes: ['task.created', 'task.completed'],
      });
      await expect(repository.outbound.find('outbound-a')).resolves.toMatchObject({
        enabled: false,
        name: 'Hook outbound-a',
        eventTypes: ['task.created', 'task.completed'],
      });

      await repository.outbound.delete('outbound-a');
      await expect(repository.outbound.find('outbound-a')).resolves.toBeNull();
      expect((await repository.outbound.list()).map((webhook) => webhook.id))
        .toEqual(['outbound-b']);
    });

    it('clears a stored secret when the patch sets it to null', async () => {
      await seedOutbound('outbound-a', BASE_TIME);
      await repository.outbound.update('outbound-a', { secret: null });
      await expect(repository.outbound.find('outbound-a')).resolves.toMatchObject({
        secret: null,
      });
    });
  });

  describe('integration configuration', () => {
    it('upserts and reads the n8n configuration', async () => {
      await repository.integrations.save({
        id: 'n8n',
        type: 'n8n',
        name: 'n8n',
        baseUrl: 'https://n8n.test',
        apiKey: 'api-key',
        enabled: true,
        settings: { webhookSecret: 'secret' },
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
      });

      await expect(repository.integrations.find('n8n')).resolves.toMatchObject({
        id: 'n8n',
        baseUrl: 'https://n8n.test',
        apiKey: 'api-key',
        enabled: true,
        settings: { webhookSecret: 'secret' },
        createdAt: BASE_TIME,
      });

      await repository.integrations.save({
        id: 'n8n',
        type: 'n8n',
        name: 'n8n',
        baseUrl: 'https://n8n2.test',
        apiKey: 'api-key-2',
        enabled: false,
        settings: { webhookSecret: 'secret' },
        createdAt: BASE_TIME,
        updatedAt: '2026-09-05T00:00:00.000Z',
      });

      await expect(repository.integrations.find('n8n')).resolves.toMatchObject({
        baseUrl: 'https://n8n2.test',
        enabled: false,
        createdAt: BASE_TIME,
        updatedAt: '2026-09-05T00:00:00.000Z',
      });

      await repository.integrations.updateSettings({
        id: 'n8n',
        settings: { connected: true, workflowCount: 3, lastError: null },
        updatedAt: '2026-09-06T00:00:00.000Z',
      });

      await expect(repository.integrations.find('n8n')).resolves.toMatchObject({
        settings: { connected: true, workflowCount: 3, lastError: null },
        updatedAt: '2026-09-06T00:00:00.000Z',
      });
      await expect(repository.integrations.find('missing')).resolves.toBeNull();
    });
  });

  describe('webhook ingestion', () => {
    function seedConnector(enabled: boolean) {
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials, settings,
          synced_lists, created_at, updated_at
        ) VALUES ('custom-rest', 'custom-rest', 'Custom REST', ?, 'webhook', '{}', '{}',
          '{"webhookSecret":"abc"}', '[]', ?, ?)
      `).run(enabled ? 1 : 0, BASE_TIME, BASE_TIME);
    }

    it('reads connector identity, enablement, and settings', async () => {
      seedConnector(true);
      await expect(repository.ingest.findConnector('custom-rest')).resolves.toEqual({
        id: 'custom-rest',
        type: 'custom-rest',
        enabled: true,
        settings: { webhookSecret: 'abc' },
      });
      await expect(repository.ingest.findConnector('missing')).resolves.toBeNull();
    });

    it('reports a disabled connector without hiding it', async () => {
      seedConnector(false);
      await expect(repository.ingest.findConnector('custom-rest')).resolves.toMatchObject({
        enabled: false,
      });
    });

    it('creates, finds, and updates ingested tasks', async () => {
      await repository.ingest.createTask({
        id: 'task-1',
        sourceId: 'github:42',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Original',
        description: 'Body',
        priority: 'none',
        status: 'todo',
        completedAt: null,
        statusReason: null,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        syncStatus: 'synced',
        lastSyncedAt: BASE_TIME,
      });

      await expect(repository.ingest.findTaskBySourceId('github:42')).resolves.toEqual({
        id: 'task-1',
        status: 'todo',
        completedAt: null,
        statusReason: null,
      });

      await repository.ingest.updateTask('task-1', {
        title: 'Closed',
        status: 'done',
        completedAt: '2026-09-05T00:00:00.000Z',
        statusReason: 'completed',
        updatedAt: '2026-09-05T00:00:00.000Z',
      });

      expect(sqlite.prepare(
        'SELECT title, status, completed_at AS completedAt, status_reason AS statusReason,'
        + ' description FROM tasks WHERE id = ?',
      ).get('task-1')).toEqual({
        title: 'Closed',
        status: 'done',
        completedAt: '2026-09-05T00:00:00.000Z',
        statusReason: 'completed',
        description: 'Body',
      });
      await expect(repository.ingest.findTaskBySourceId('missing')).resolves.toBeNull();
    });

    it('creates a notification with extra actions and a synced open_url action', async () => {
      const search = await repository.ingest.createNotification({
        notification: {
          id: 'notification-1',
          sourceId: 'webhook:1',
          connectorType: 'custom-rest',
          connectorInstanceId: 'custom-rest',
          title: 'Garage door open',
          body: 'Detail',
          level: 'fyi',
          levelRank: 3,
          category: 'webhook',
          templateKey: 'door_open',
          state: 'unread',
          isActionable: true,
          receivedAt: BASE_TIME,
          sortAt: BASE_TIME,
          expiresAt: null,
          metadata: { id: 'door-42' },
          presentation: {},
        },
        actions: [{
          id: 'action-extra',
          actionType: 'open_url',
          label: 'Open',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: { url: 'https://example.test/a' },
          opensExternal: true,
          createdBy: 'connector',
        }],
      });

      expect(search).toEqual({
        id: 'notification-1',
        title: 'Garage door open',
        body: 'Detail',
        category: 'webhook',
        connectorType: 'custom-rest',
      });
      expect(sqlite.prepare(
        'SELECT template_key AS templateKey FROM notifications WHERE id = ?',
      ).get('notification-1')).toEqual({ templateKey: 'door_open' });
      expect(sqlite.prepare(
        'SELECT id FROM notification_actions WHERE notification_id = ?',
      ).all('notification-1')).toEqual([{ id: 'action-extra' }]);
    });

    it('rolls the whole notification write back when an action insert fails', async () => {
      sqlite.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, label, variant, is_primary, sort_order,
          payload, opens_external, requires_confirmation, created_by
        ) VALUES ('duplicate-action', 'unrelated', 'open_url', 'Open', 'primary', 1, 0,
          '{}', 1, 0, 'connector')
      `).run();

      await expect(repository.ingest.createNotification({
        notification: {
          id: 'notification-rollback',
          sourceId: 'webhook:rollback',
          connectorType: 'custom-rest',
          connectorInstanceId: 'custom-rest',
          title: 'Rollback',
          body: null,
          level: 'fyi',
          levelRank: 3,
          category: 'webhook',
          state: 'unread',
          isActionable: true,
          receivedAt: BASE_TIME,
          sortAt: BASE_TIME,
          metadata: {},
          presentation: {},
        },
        actions: [{
          id: 'duplicate-action',
          actionType: 'open_url',
          label: 'Open',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: {},
          opensExternal: true,
          createdBy: 'connector',
        }],
      })).rejects.toThrow();

      expect(sqlite.prepare('SELECT count(*) AS count FROM notifications WHERE id = ?')
        .get('notification-rollback')).toEqual({ count: 0 });
    });

    it('upserts by source identity and replaces the open_url action', async () => {
      const insert = {
        id: 'shipment-1',
        sourceId: 'shipment:1',
        connectorType: 'n8n',
        connectorInstanceId: 'n8n',
        title: 'Shipment update',
        body: 'In transit',
        level: 'fyi',
        levelRank: 3,
        category: 'shipment',
        state: 'unread',
        isActionable: true,
        receivedAt: BASE_TIME,
        sortAt: BASE_TIME,
        expiresAt: null,
        metadata: { step: 1 },
        presentation: {},
      };

      const created = await repository.ingest.upsertNotificationBySource({
        match: { connectorType: 'n8n', sourceId: 'shipment:1' },
        insert,
        update: { title: 'Shipment update' },
        openUrlAction: { url: 'https://example.test/first', label: 'Open' },
      });
      expect(created).toMatchObject({ id: 'shipment-1', created: true });

      const updated = await repository.ingest.upsertNotificationBySource({
        match: { connectorType: 'n8n', sourceId: 'shipment:1' },
        insert: { ...insert, id: 'unused-id' },
        update: { title: 'Delivered', body: 'Delivered', sortAt: '2026-09-05T00:00:00.000Z' },
        openUrlAction: { url: 'https://example.test/second', label: 'Open' },
      });

      expect(updated).toMatchObject({ id: 'shipment-1', created: false });
      expect(updated.search).toMatchObject({ title: 'Delivered', body: 'Delivered' });
      expect(sqlite.prepare('SELECT count(*) AS count FROM notifications').get())
        .toEqual({ count: 1 });
      const actions = sqlite.prepare(
        'SELECT payload FROM notification_actions WHERE notification_id = ?',
      ).all('shipment-1') as Array<{ payload: string }>;
      expect(actions).toHaveLength(1);
      expect(JSON.parse(actions[0].payload)).toEqual({ url: 'https://example.test/second' });
    });

    it('deletes a notification with its actions and reports the deleted id', async () => {
      await repository.ingest.createNotification({
        notification: {
          id: 'rymessage-1',
          sourceId: 'rymessage:key',
          connectorType: 'rymessage',
          connectorInstanceId: 'rymessage-webhook',
          title: 'Action',
          body: null,
          level: 'fyi',
          levelRank: 3,
          category: 'message',
          state: 'unread',
          isActionable: false,
          receivedAt: BASE_TIME,
          sortAt: BASE_TIME,
          metadata: {},
          presentation: {},
        },
        openUrlAction: { url: 'https://example.test/x', label: 'Open' },
      });

      await expect(repository.ingest.deleteNotificationBySource({
        connectorType: 'rymessage',
        sourceId: 'rymessage:key',
      })).resolves.toBe('rymessage-1');
      expect(sqlite.prepare('SELECT count(*) AS count FROM notifications').get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare('SELECT count(*) AS count FROM notification_actions').get())
        .toEqual({ count: 0 });
      await expect(repository.ingest.deleteNotificationBySource({
        connectorType: 'rymessage',
        sourceId: 'rymessage:key',
      })).resolves.toBeNull();
    });

    it('snoozes a notification by source identity', async () => {
      await repository.ingest.createNotification({
        notification: {
          id: 'rymessage-2',
          sourceId: 'rymessage:snooze',
          connectorType: 'rymessage',
          connectorInstanceId: 'rymessage-webhook',
          title: 'Action',
          body: null,
          level: 'fyi',
          levelRank: 3,
          category: 'message',
          state: 'unread',
          isActionable: false,
          receivedAt: BASE_TIME,
          sortAt: BASE_TIME,
          metadata: {},
          presentation: {},
        },
      });

      await expect(repository.ingest.snoozeNotificationBySource({
        connectorType: 'rymessage',
        sourceId: 'rymessage:snooze',
        snoozedUntil: '2026-09-05T00:00:00.000Z',
        metadata: { snoozedUntil: 1 },
      })).resolves.toBe('rymessage-2');

      expect(sqlite.prepare(
        'SELECT snoozed_until AS snoozedUntil, expires_at AS expiresAt'
        + ' FROM notifications WHERE id = ?',
      ).get('rymessage-2')).toEqual({
        snoozedUntil: '2026-09-05T00:00:00.000Z',
        expiresAt: '2026-09-05T00:00:00.000Z',
      });
      await expect(repository.ingest.snoozeNotificationBySource({
        connectorType: 'rymessage',
        sourceId: 'missing',
        snoozedUntil: null,
        metadata: {},
      })).resolves.toBeNull();
    });

    it('appends the webhook sync-log entry', async () => {
      await repository.ingest.appendSyncLog({
        id: 'sync-1',
        connectorId: 'custom-rest',
        success: true,
        tasksAdded: 1,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 1,
        errors: '[]',
        syncedAt: BASE_TIME,
      });

      expect(sqlite.prepare(
        'SELECT connector_id AS connectorId, success, tasks_added AS tasksAdded,'
        + ' alerts_added AS notificationsAdded, synced_at AS syncedAt FROM sync_log WHERE id = ?',
      ).get('sync-1')).toEqual({
        connectorId: 'custom-rest',
        success: 1,
        tasksAdded: 1,
        notificationsAdded: 1,
        syncedAt: BASE_TIME,
      });
    });
  });
});
