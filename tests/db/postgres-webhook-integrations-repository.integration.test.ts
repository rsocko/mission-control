import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, QueryResultRow } from 'pg';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresWebhookIntegrationsRepository,
} from '@/db/postgres/repositories/webhook-integrations-repository';
import type { WebhookIntegrationsPersistence } from '@/db/persistence/webhook-integrations';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

/**
 * Live-PostgreSQL behavior coverage for the Layer L20 webhook port. It runs the
 * same scenarios as tests/db/sqlite-webhook-integrations-repository.test.ts —
 * deterministic ordering, atomic replay claiming under concurrency, transaction
 * rollback, failure persistence, CRUD, connector lookup/status, and outbound
 * configuration — against the PostgreSQL adapter.
 */

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-webhook-integrations',
        }),
      }
    : {}),
});
let initialized = false;
let repository: WebhookIntegrationsPersistence;

const BASE_TIME = '2026-09-04T12:00:00.000Z';
const WEBHOOK_ID = 'pg-inbound-webhook-1';
const OTHER_WEBHOOK_ID = 'pg-inbound-webhook-2';
const CONNECTOR_ID = 'pg-webhook-connector';

async function pool(): Promise<Pool> {
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  if (!initialized) {
    assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repository = createPostgresWebhookIntegrationsRepository(backend.context.pool);
    initialized = true;
  }
  return backend.context.pool;
}

async function rows<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await (await pool()).query(sql, [...params])).rows as T[];
}

async function reset(): Promise<void> {
  const database = await pool();
  await database.query(
    `DELETE FROM inbound_webhook_replays WHERE webhook_id = ANY($1::text[])`,
    [[WEBHOOK_ID, OTHER_WEBHOOK_ID]],
  );
  await database.query(
    `DELETE FROM inbound_webhook_log WHERE webhook_id = ANY($1::text[])`,
    [[WEBHOOK_ID, OTHER_WEBHOOK_ID]],
  );
  await database.query(`DELETE FROM external_agents WHERE id = 'pg-webhook-agent'`);
  await database.query(
    `DELETE FROM notification_push_rules WHERE connector_instance_id = ANY($1::text[])`,
    [[WEBHOOK_ID, OTHER_WEBHOOK_ID]],
  );
  await database.query(
    `DELETE FROM notification_actions WHERE notification_id IN (
       SELECT id FROM notifications WHERE connector_instance_id = ANY($1::text[])
     ) OR id = 'pg-duplicate-action'`,
    [[WEBHOOK_ID, CONNECTOR_ID, 'n8n', 'rymessage-webhook']],
  );
  await database.query(
    `DELETE FROM notifications WHERE connector_instance_id = ANY($1::text[])`,
    [[WEBHOOK_ID, CONNECTOR_ID, 'n8n', 'rymessage-webhook']],
  );
  await database.query(
    `DELETE FROM tasks WHERE connector_instance_id = ANY($1::text[])`,
    [[WEBHOOK_ID, CONNECTOR_ID, 'pg-webhook-github']],
  );
  await database.query(`DELETE FROM sync_log WHERE connector_id = $1`, [CONNECTOR_ID]);
  await database.query(
    `DELETE FROM inbound_webhooks WHERE id = ANY($1::text[])`,
    [[WEBHOOK_ID, OTHER_WEBHOOK_ID]],
  );
  await database.query(
    `DELETE FROM outbound_webhooks WHERE id = ANY($1::text[])`,
    [['pg-outbound-a', 'pg-outbound-b']],
  );
  await database.query(`DELETE FROM integration_configs WHERE id = 'pg-n8n'`);
  await database.query(`DELETE FROM connector_configs WHERE id = $1`, [CONNECTOR_ID]);
}

async function seedWebhook(
  overrides: { id?: string; secret?: string | null; createdAt?: string } = {},
): Promise<void> {
  await repository.inbound.create({
    id: overrides.id ?? WEBHOOK_ID,
    name: 'Home Server',
    sourceLabel: 'Automation',
    secret: overrides.secret === undefined ? 'shhh' : overrides.secret,
    defaultAction: 'auto',
    fieldMappings: { title: 'data.title' },
    createdAt: overrides.createdAt ?? BASE_TIME,
    updatedAt: BASE_TIME,
  });
}

async function seedExternalAgent(deletedAt: string | null = null): Promise<void> {
  await (await pool()).query(
    `
      INSERT INTO external_agents (
        id, name, type, transport, execution_locality, auth_type, capabilities,
        input_format, output_format, inbound_webhook_id, data_policy, enabled,
        created_at, updated_at, deleted_at
      ) VALUES (
        'pg-webhook-agent', 'Reviewer', 'manual', 'webhook', 'remote', 'none', '{}'::jsonb,
        'mc-tasks', 'mc-tasks', $1, '{}'::jsonb, true, $2, $2, $3
      )
    `,
    [WEBHOOK_ID, BASE_TIME, deletedAt],
  );
}

function logEntry(id: string, receivedAt: string) {
  return {
    id,
    webhookId: WEBHOOK_ID,
    status: 'success',
    httpStatus: 201,
    createdType: 'task',
    createdId: `task-${id}`,
    errorMessage: null,
    payloadPreview: '{"ok":true}',
    receivedAt,
  };
}

afterAll(async () => {
  if (!initialized) return;
  await reset();
  await backend.shutdown();
});

describePostgres('postgres webhook integrations repository', () => {
  beforeEach(async () => {
    await pool();
    await reset();
  });

  it('lists inbound webhooks redacted, newest first, with a stable id tie-breaker', async () => {
    await seedWebhook({ id: OTHER_WEBHOOK_ID });
    await seedWebhook({ id: WEBHOOK_ID, secret: null });

    const listed = (await repository.inbound.list())
      .filter((webhook) => [WEBHOOK_ID, OTHER_WEBHOOK_ID].includes(webhook.id));

    expect(listed.map((webhook) => webhook.id)).toEqual([OTHER_WEBHOOK_ID, WEBHOOK_ID]);
    expect(listed[0]).toMatchObject({
      sourceLabel: 'Automation',
      enabled: true,
      defaultAction: 'auto',
      fieldMappings: { title: 'data.title' },
      totalReceived: 0,
      hasSecret: true,
    });
    expect(listed[1].hasSecret).toBe(false);
    expect(listed.every((webhook) => !('secret' in webhook))).toBe(true);
  });

  it('applies only the supplied patch fields and always stamps updatedAt', async () => {
    await seedWebhook();

    expect(await repository.inbound.update({
      id: WEBHOOK_ID,
      patch: { name: 'Renamed', enabled: false },
      updatedAt: '2026-09-05T00:00:00.000Z',
    })).toBe('updated');

    expect(await rows(
      `SELECT name, source_label AS "sourceLabel", enabled, secret,
              updated_at AS "updatedAt"
       FROM inbound_webhooks WHERE id = $1`,
      [WEBHOOK_ID],
    )).toEqual([{
      name: 'Renamed',
      sourceLabel: 'Automation',
      enabled: false,
      secret: 'shhh',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }]);
  });

  it('refuses to clear a secret an active external agent depends on', async () => {
    await seedWebhook();
    await seedExternalAgent();

    expect(await repository.inbound.update({
      id: WEBHOOK_ID,
      patch: { name: 'Renamed', secret: null },
      updatedAt: '2026-09-05T00:00:00.000Z',
    })).toBe('secret-referenced');
    expect(await rows(
      'SELECT secret, name FROM inbound_webhooks WHERE id = $1',
      [WEBHOOK_ID],
    )).toEqual([{ secret: 'shhh', name: 'Home Server' }]);
  });

  it('clears the secret when the referencing agent is soft deleted', async () => {
    await seedWebhook();
    await seedExternalAgent(BASE_TIME);

    expect(await repository.inbound.update({
      id: WEBHOOK_ID,
      patch: { secret: null },
      updatedAt: '2026-09-05T00:00:00.000Z',
    })).toBe('updated');
    expect(await rows('SELECT secret FROM inbound_webhooks WHERE id = $1', [WEBHOOK_ID]))
      .toEqual([{ secret: null }]);
  });

  it('deletes the webhook and its push rules in one transaction', async () => {
    await seedWebhook();
    await (await pool()).query(
      `
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level, preview,
          max_per_hour, created_at, updated_at
        ) VALUES ('pg-webhook-rule', $1, '*', true, 'urgent', 'title_only', NULL, $2, $2)
      `,
      [WEBHOOK_ID, BASE_TIME],
    );

    expect(await repository.inbound.delete(WEBHOOK_ID)).toBe('deleted');
    expect(await rows('SELECT id FROM inbound_webhooks WHERE id = $1', [WEBHOOK_ID]))
      .toEqual([]);
    expect(await rows(
      'SELECT id FROM notification_push_rules WHERE connector_instance_id = $1',
      [WEBHOOK_ID],
    )).toEqual([]);
  });

  it('leaves the webhook and its push rules intact when an agent still references it', async () => {
    await seedWebhook();
    await seedExternalAgent();
    await (await pool()).query(
      `
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level, preview,
          max_per_hour, created_at, updated_at
        ) VALUES ('pg-webhook-rule', $1, '*', true, 'urgent', 'title_only', NULL, $2, $2)
      `,
      [WEBHOOK_ID, BASE_TIME],
    );

    expect(await repository.inbound.delete(WEBHOOK_ID)).toBe('agent-referenced');
    expect(await rows('SELECT id FROM inbound_webhooks WHERE id = $1', [WEBHOOK_ID]))
      .toHaveLength(1);
    expect(await rows(
      'SELECT id FROM notification_push_rules WHERE connector_instance_id = $1',
      [WEBHOOK_ID],
    )).toHaveLength(1);
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
    await expect(repository.inbound.findForDelivery('pg-missing')).resolves.toBeNull();
  });

  it('orders log entries by received_at desc with a stable id tie-breaker', async () => {
    await seedWebhook();
    for (const entry of [
      logEntry('pg-log-a', '2026-09-04T10:00:00.000Z'),
      logEntry('pg-log-c', '2026-09-04T11:00:00.000Z'),
      logEntry('pg-log-b', '2026-09-04T11:00:00.000Z'),
    ]) {
      await repository.inbound.appendLog({ entry, compaction: null });
    }

    const entries = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 10 });
    expect(entries.map((entry) => entry.id)).toEqual(['pg-log-c', 'pg-log-b', 'pg-log-a']);
    expect(entries[2]).toMatchObject({ status: 'success', httpStatus: 201 });
  });

  it('persists failure entries with their status and message', async () => {
    await seedWebhook();
    await repository.inbound.appendLog({
      entry: {
        id: 'pg-log-error',
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
    });
  });

  it('compacts by retention cutoff and by the newest retained window', async () => {
    await seedWebhook();
    for (const entry of [
      logEntry('pg-log-old', '2026-01-01T00:00:00.000Z'),
      logEntry('pg-log-1', '2026-09-04T10:00:00.000Z'),
      logEntry('pg-log-2', '2026-09-04T11:00:00.000Z'),
    ]) {
      await repository.inbound.appendLog({ entry, compaction: null });
    }

    await repository.inbound.appendLog({
      entry: logEntry('pg-log-3', '2026-09-04T12:00:00.000Z'),
      compaction: { retentionCutoff: '2026-06-01T00:00:00.000Z', retainLatest: 2 },
    });

    const entries = await repository.inbound.listLog({ webhookId: WEBHOOK_ID, limit: 10 });
    expect(entries.map((entry) => entry.id)).toEqual(['pg-log-3', 'pg-log-2']);
  });

  it('claims a delivery once and rejects the replay inside the five-minute window', async () => {
    await seedWebhook();
    const claim = (receivedAt: string) => repository.inbound.claimDelivery({
      id: crypto.randomUUID(),
      webhookId: WEBHOOK_ID,
      deliveryKey: 'payload:abc',
      receivedAt,
      expiresAt: new Date(Date.parse(receivedAt) + 5 * 60 * 1_000).toISOString(),
      sweepExpiredBefore: null,
    });

    await expect(claim(BASE_TIME)).resolves.toBe(true);
    await expect(claim('2026-09-04T12:04:59.000Z')).resolves.toBe(false);
    await expect(claim('2026-09-04T12:05:01.000Z')).resolves.toBe(true);
  });

  it('is idempotent when concurrent claims race for the same delivery key', async () => {
    await seedWebhook();
    const claim = () => repository.inbound.claimDelivery({
      id: crypto.randomUUID(),
      webhookId: WEBHOOK_ID,
      deliveryKey: 'payload:concurrent',
      receivedAt: BASE_TIME,
      expiresAt: '2026-09-04T12:05:00.000Z',
      sweepExpiredBefore: null,
    });

    const results = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rows(
      'SELECT id FROM inbound_webhook_replays WHERE webhook_id = $1 AND delivery_key = $2',
      [WEBHOOK_ID, 'payload:concurrent'],
    )).toHaveLength(1);
  });

  it('releases a claim so the same payload can be retried immediately', async () => {
    await seedWebhook();
    const claim = () => repository.inbound.claimDelivery({
      id: crypto.randomUUID(),
      webhookId: WEBHOOK_ID,
      deliveryKey: 'payload:release',
      receivedAt: BASE_TIME,
      expiresAt: '2026-09-04T12:05:00.000Z',
      sweepExpiredBefore: null,
    });

    await expect(claim()).resolves.toBe(true);
    await repository.inbound.releaseDelivery({
      webhookId: WEBHOOK_ID,
      deliveryKey: 'payload:release',
    });
    await expect(claim()).resolves.toBe(true);
  });

  it('sweeps expired claims across every webhook when asked', async () => {
    await seedWebhook();
    await seedWebhook({ id: OTHER_WEBHOOK_ID });
    await (await pool()).query(
      `
        INSERT INTO inbound_webhook_replays (id, webhook_id, delivery_key, received_at, expires_at)
        VALUES ('pg-stale', $1, 'payload:stale', $2, '2026-09-04T11:00:00.000Z')
      `,
      [OTHER_WEBHOOK_ID, BASE_TIME],
    );

    await repository.inbound.claimDelivery({
      id: 'pg-fresh',
      webhookId: WEBHOOK_ID,
      deliveryKey: 'payload:fresh',
      receivedAt: BASE_TIME,
      expiresAt: '2026-09-04T12:05:00.000Z',
      sweepExpiredBefore: BASE_TIME,
    });

    expect(await rows(
      `SELECT id FROM inbound_webhook_replays WHERE webhook_id = ANY($1::text[])`,
      [[WEBHOOK_ID, OTHER_WEBHOOK_ID]],
    )).toEqual([{ id: 'pg-fresh' }]);
  });

  it('does not deadlock concurrent claims that also sweep expired deliveries', async () => {
    await seedWebhook();
    await Promise.all(Array.from({ length: 4 }, (_, index) => (
      repository.inbound.claimDelivery({
        id: `pg-sweeping-${index}`,
        webhookId: WEBHOOK_ID,
        deliveryKey: `payload:sweeping-${index}`,
        receivedAt: BASE_TIME,
        expiresAt: '2026-09-04T12:05:00.000Z',
        sweepExpiredBefore: BASE_TIME,
      })
    )));

    expect(await rows(
      `SELECT id FROM inbound_webhook_replays
       WHERE webhook_id = $1 AND delivery_key LIKE 'payload:sweeping-%'`,
      [WEBHOOK_ID],
    )).toHaveLength(4);
  });

  it('increments the received counter and records the last status', async () => {
    await seedWebhook();
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

    expect(await rows(
      `SELECT total_received AS "totalReceived", last_status AS "lastStatus",
              last_received_at AS "lastReceivedAt"
       FROM inbound_webhooks WHERE id = $1`,
      [WEBHOOK_ID],
    )).toEqual([{
      totalReceived: 2,
      lastStatus: 500,
      lastReceivedAt: '2026-09-04T12:01:00.000Z',
    }]);
  });

  it('creates the webhook task with its source attribution', async () => {
    await seedWebhook();
    await repository.inbound.createTask({
      id: 'pg-task-1',
      sourceId: `inbound:${WEBHOOK_ID}:pg-task-1`,
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

    expect(await rows(
      `SELECT source_id AS "sourceId", source_list_name AS "sourceListName", depth,
              is_checklist_item AS "isChecklistItem"
       FROM tasks WHERE id = $1`,
      ['pg-task-1'],
    )).toEqual([{
      sourceId: `inbound:${WEBHOOK_ID}:pg-task-1`,
      sourceListName: 'Automation',
      depth: 0,
      isChecklistItem: false,
    }]);
  });

  it('creates the alert and its primary action atomically', async () => {
    await seedWebhook();
    const result = await repository.inbound.createAlert({
      notification: {
        id: 'pg-alert-1',
        sourceId: `inbound:${WEBHOOK_ID}:pg-alert-1`,
        connectorType: 'inbound-webhook',
        connectorInstanceId: WEBHOOK_ID,
        title: 'Webhook Alert',
        body: null,
        level: 'fyi',
        category: 'Automation',
        templateKey: null,
        state: 'unread',
        isActionable: true,
        primaryActionId: 'pg-action-1',
        receivedAt: BASE_TIME,
        sortAt: BASE_TIME,
        expiresAt: '2026-09-05T12:00:00.000Z',
        metadata: { webhookId: WEBHOOK_ID },
        presentation: {},
      },
      action: {
        id: 'pg-action-1',
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

    expect(result).toMatchObject({ id: 'pg-alert-1', created: true });
    expect(await rows(
      `SELECT primary_action_id AS "primaryActionId", is_actionable AS "isActionable",
              expires_at AS "expiresAt"
       FROM notifications WHERE id = $1`,
      ['pg-alert-1'],
    )).toEqual([{
      primaryActionId: 'pg-action-1',
      isActionable: true,
      expiresAt: '2026-09-05T12:00:00.000Z',
    }]);
    expect(await rows(
      `SELECT id, action_type AS "actionType" FROM notification_actions
       WHERE notification_id = $1`,
      ['pg-alert-1'],
    )).toEqual([{ id: 'pg-action-1', actionType: 'open_url' }]);
  });

  it('creates, lists, finds, patches, and deletes outbound subscriptions', async () => {
    for (const [id, createdAt] of [
      ['pg-outbound-b', '2026-09-04T10:00:00.000Z'],
      ['pg-outbound-a', '2026-09-04T11:00:00.000Z'],
    ] as const) {
      await repository.outbound.create({
        id,
        name: `Hook ${id}`,
        url: 'https://example.test/hook',
        secret: 'signing-secret',
        eventTypes: ['sync.completed'],
        createdAt,
      });
    }

    const listed = (await repository.outbound.list())
      .filter((webhook) => webhook.id.startsWith('pg-outbound-'));
    expect(listed.map((webhook) => webhook.id)).toEqual(['pg-outbound-a', 'pg-outbound-b']);
    expect(listed[0]).toMatchObject({
      url: 'https://example.test/hook',
      secret: 'signing-secret',
      eventTypes: ['sync.completed'],
      enabled: true,
      lastTriggeredAt: null,
      lastStatus: null,
    });

    await repository.outbound.update('pg-outbound-a', {
      enabled: false,
      eventTypes: ['task.created', 'task.completed'],
      secret: null,
    });
    await expect(repository.outbound.find('pg-outbound-a')).resolves.toMatchObject({
      enabled: false,
      name: 'Hook pg-outbound-a',
      secret: null,
      eventTypes: ['task.created', 'task.completed'],
    });

    await repository.outbound.delete('pg-outbound-a');
    await expect(repository.outbound.find('pg-outbound-a')).resolves.toBeNull();
  });

  it('upserts and reads the integration configuration', async () => {
    await repository.integrations.save({
      id: 'pg-n8n',
      type: 'n8n',
      name: 'n8n',
      baseUrl: 'https://n8n.test',
      apiKey: 'api-key',
      enabled: true,
      settings: { webhookSecret: 'secret' },
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
    });
    await repository.integrations.save({
      id: 'pg-n8n',
      type: 'n8n',
      name: 'n8n',
      baseUrl: 'https://n8n2.test',
      apiKey: 'api-key-2',
      enabled: false,
      settings: { webhookSecret: 'secret' },
      createdAt: BASE_TIME,
      updatedAt: '2026-09-05T00:00:00.000Z',
    });

    await expect(repository.integrations.find('pg-n8n')).resolves.toMatchObject({
      baseUrl: 'https://n8n2.test',
      apiKey: 'api-key-2',
      enabled: false,
      createdAt: BASE_TIME,
      updatedAt: '2026-09-05T00:00:00.000Z',
    });

    await repository.integrations.updateSettings({
      id: 'pg-n8n',
      settings: { connected: true, workflowCount: 3, lastError: null },
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
    await expect(repository.integrations.find('pg-n8n')).resolves.toMatchObject({
      settings: { connected: true, workflowCount: 3, lastError: null },
      updatedAt: '2026-09-06T00:00:00.000Z',
    });
    await expect(repository.integrations.find('pg-missing')).resolves.toBeNull();
  });

  it('reads connector identity, enablement, and settings', async () => {
    const database = await pool();
    await database.query(
      `
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials, settings,
          synced_lists, created_at, updated_at
        ) VALUES ($1, 'custom-rest', 'Custom REST', true, 'webhook', '{}'::jsonb, '{}'::jsonb,
          '{"webhookSecret":"abc"}'::jsonb, '[]'::jsonb, $2, $2)
      `,
      [CONNECTOR_ID, BASE_TIME],
    );

    await expect(repository.ingest.findConnector(CONNECTOR_ID)).resolves.toEqual({
      id: CONNECTOR_ID,
      type: 'custom-rest',
      enabled: true,
      settings: { webhookSecret: 'abc' },
    });

    await database.query('UPDATE connector_configs SET enabled = false WHERE id = $1', [
      CONNECTOR_ID,
    ]);
    await expect(repository.ingest.findConnector(CONNECTOR_ID)).resolves.toMatchObject({
      enabled: false,
    });
    await expect(repository.ingest.findConnector('pg-missing')).resolves.toBeNull();
  });

  it('creates, finds, and updates ingested tasks', async () => {
    await repository.ingest.createTask({
      id: 'pg-ingest-task',
      sourceId: 'github:pg-42',
      connectorType: 'github-issues',
      connectorInstanceId: 'pg-webhook-github',
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

    await repository.ingest.createTask({
      id: 'pg-ingest-task-other-connector',
      sourceId: 'github:pg-42',
      connectorType: 'github-issues',
      connectorInstanceId: 'pg-webhook-github-other',
      title: 'Other connector',
      priority: 'none',
      status: 'in_progress',
      completedAt: null,
      statusReason: null,
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      syncStatus: 'synced',
      lastSyncedAt: BASE_TIME,
    });

    await expect(repository.ingest.findTaskBySource({
      connectorInstanceId: 'pg-webhook-github',
      sourceId: 'github:pg-42',
    })).resolves.toEqual({
      id: 'pg-ingest-task',
      status: 'todo',
      completedAt: null,
      statusReason: null,
    });
    await expect(repository.ingest.findTaskBySource({
      connectorInstanceId: 'pg-webhook-github-other',
      sourceId: 'github:pg-42',
    })).resolves.toMatchObject({
      id: 'pg-ingest-task-other-connector',
      status: 'in_progress',
    });

    await repository.ingest.updateTask('pg-ingest-task', {
      title: 'Closed',
      status: 'done',
      completedAt: '2026-09-05T00:00:00.000Z',
      statusReason: 'completed',
      updatedAt: '2026-09-05T00:00:00.000Z',
    });

    expect(await rows(
      `SELECT title, status, completed_at AS "completedAt",
              status_reason AS "statusReason", description
       FROM tasks WHERE id = $1`,
      ['pg-ingest-task'],
    )).toEqual([{
      title: 'Closed',
      status: 'done',
      completedAt: '2026-09-05T00:00:00.000Z',
      statusReason: 'completed',
      description: 'Body',
    }]);
    await expect(repository.ingest.findTaskBySource({
      connectorInstanceId: 'pg-webhook-github',
      sourceId: 'github:pg-missing',
    })).resolves.toBeNull();
  });

  it('creates a notification with extra actions and returns its search projection', async () => {
    const search = await repository.ingest.createNotification({
      notification: {
        id: 'pg-notification-1',
        sourceId: 'webhook:pg-1',
        connectorType: 'custom-rest',
        connectorInstanceId: CONNECTOR_ID,
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
        id: 'pg-action-extra',
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
      id: 'pg-notification-1',
      title: 'Garage door open',
      body: 'Detail',
      category: 'webhook',
      connectorType: 'custom-rest',
    });
    expect(await rows(
      `SELECT template_key AS "templateKey" FROM notifications WHERE id = $1`,
      ['pg-notification-1'],
    )).toEqual([{ templateKey: 'door_open' }]);
    expect(await rows(
      'SELECT id FROM notification_actions WHERE notification_id = $1',
      ['pg-notification-1'],
    )).toEqual([{ id: 'pg-action-extra' }]);
  });

  it('rolls the whole notification write back when an action insert fails', async () => {
    await (await pool()).query(
      `
        INSERT INTO notification_actions (
          id, notification_id, action_type, label, variant, is_primary, sort_order,
          payload, opens_external, created_by
        ) VALUES ('pg-duplicate-action', 'pg-unrelated', 'open_url', 'Open', 'primary',
          true, 0, '{}'::jsonb, true, 'connector')
      `,
    );

    await expect(repository.ingest.createNotification({
      notification: {
        id: 'pg-notification-rollback',
        sourceId: 'webhook:pg-rollback',
        connectorType: 'custom-rest',
        connectorInstanceId: CONNECTOR_ID,
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
        id: 'pg-duplicate-action',
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

    expect(await rows('SELECT id FROM notifications WHERE id = $1', [
      'pg-notification-rollback',
    ])).toEqual([]);
    await (await pool()).query(
      `DELETE FROM notification_actions WHERE id = 'pg-duplicate-action'`,
    );
  });

  it('upserts by source identity and replaces the open_url action', async () => {
    const insert = {
      id: 'pg-shipment-1',
      sourceId: 'shipment:pg-1',
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

    expect(await repository.ingest.upsertNotificationBySource({
      match: { connectorType: 'n8n', sourceId: 'shipment:pg-1' },
      insert,
      update: { title: 'Shipment update' },
      openUrlAction: { url: 'https://example.test/first', label: 'Open' },
    })).toMatchObject({ id: 'pg-shipment-1', created: true });

    const updated = await repository.ingest.upsertNotificationBySource({
      match: { connectorType: 'n8n', sourceId: 'shipment:pg-1' },
      insert: { ...insert, id: 'pg-unused-id' },
      update: { title: 'Delivered', body: 'Delivered', sortAt: '2026-09-05T00:00:00.000Z' },
      openUrlAction: { url: 'https://example.test/second', label: 'Open' },
    });

    expect(updated).toMatchObject({ id: 'pg-shipment-1', created: false });
    expect(updated.search).toMatchObject({ title: 'Delivered', body: 'Delivered' });
    expect(await rows('SELECT id FROM notifications WHERE source_id = $1', [
      'shipment:pg-1',
    ])).toHaveLength(1);
    expect(await rows<{ payload: { url: string } }>(
      'SELECT payload FROM notification_actions WHERE notification_id = $1',
      ['pg-shipment-1'],
    )).toEqual([{ payload: { url: 'https://example.test/second' } }]);
  });

  it('serializes concurrent notification upserts by source identity', async () => {
    const createInput = (id: string) => ({
      match: { connectorType: 'n8n', sourceId: 'shipment:pg-concurrent' },
      insert: {
        id,
        sourceId: 'shipment:pg-concurrent',
        connectorType: 'n8n',
        connectorInstanceId: 'n8n',
        title: 'Shipment update',
        body: 'In transit',
        level: 'fyi',
        levelRank: 3,
        category: 'shipment',
        state: 'unread',
        isActionable: false,
        receivedAt: BASE_TIME,
        sortAt: BASE_TIME,
        expiresAt: null,
        metadata: {},
        presentation: {},
      },
      update: { title: 'Shipment update' },
    });

    const results = await Promise.all([
      repository.ingest.upsertNotificationBySource(createInput('pg-concurrent-a')),
      repository.ingest.upsertNotificationBySource(createInput('pg-concurrent-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await rows('SELECT id FROM notifications WHERE source_id = $1', [
      'shipment:pg-concurrent',
    ])).toHaveLength(1);
  });

  it('deletes a notification with its actions and reports the deleted id', async () => {
    await repository.ingest.createNotification({
      notification: {
        id: 'pg-rymessage-1',
        sourceId: 'rymessage:pg-key',
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
      sourceId: 'rymessage:pg-key',
    })).resolves.toBe('pg-rymessage-1');
    expect(await rows('SELECT id FROM notifications WHERE id = $1', ['pg-rymessage-1']))
      .toEqual([]);
    expect(await rows(
      'SELECT id FROM notification_actions WHERE notification_id = $1',
      ['pg-rymessage-1'],
    )).toEqual([]);
    await expect(repository.ingest.deleteNotificationBySource({
      connectorType: 'rymessage',
      sourceId: 'rymessage:pg-key',
    })).resolves.toBeNull();
  });

  it('snoozes a notification by source identity', async () => {
    await repository.ingest.createNotification({
      notification: {
        id: 'pg-rymessage-2',
        sourceId: 'rymessage:pg-snooze',
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
      sourceId: 'rymessage:pg-snooze',
      snoozedUntil: '2026-09-05T00:00:00.000Z',
      metadata: { snoozedUntil: 1 },
    })).resolves.toBe('pg-rymessage-2');

    expect(await rows(
      `SELECT snoozed_until AS "snoozedUntil", expires_at AS "expiresAt"
       FROM notifications WHERE id = $1`,
      ['pg-rymessage-2'],
    )).toEqual([{
      snoozedUntil: '2026-09-05T00:00:00.000Z',
      expiresAt: '2026-09-05T00:00:00.000Z',
    }]);
    await expect(repository.ingest.snoozeNotificationBySource({
      connectorType: 'rymessage',
      sourceId: 'rymessage:pg-missing',
      snoozedUntil: null,
      metadata: {},
    })).resolves.toBeNull();
  });

  it('appends the webhook sync-log entry', async () => {
    await repository.ingest.appendSyncLog({
      id: 'pg-sync-1',
      connectorId: CONNECTOR_ID,
      success: true,
      tasksAdded: 1,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 1,
      errors: '[]',
      syncedAt: BASE_TIME,
    });

    expect(await rows(
      `SELECT connector_id AS "connectorId", success, tasks_added AS "tasksAdded",
              alerts_added AS "notificationsAdded", errors, synced_at AS "syncedAt"
       FROM sync_log WHERE id = $1`,
      ['pg-sync-1'],
    )).toEqual([{
      connectorId: CONNECTOR_ID,
      success: true,
      tasksAdded: 1,
      notificationsAdded: 1,
      errors: '[]',
      syncedAt: BASE_TIME,
    }]);
  });
});
