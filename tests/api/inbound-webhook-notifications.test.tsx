import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { createHmac } from 'node:crypto';

describe('generic inbound webhook notifications', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let receive: typeof import('@/app/api/inbound-webhooks/[id]/receive/route').POST;
  let listNotifications: typeof import('@/app/api/notifications/route').GET;
  let executeAction: typeof import('@/app/api/notifications/[id]/actions/[actionId]/route').POST;
  let shutdownRuntimeDatabase: typeof import('@/db/runtime').shutdownRuntimeDatabase;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, runtimeModule] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/db/runtime'),
    ]);
    await runtimeModule.initializeRuntimeDatabase();
    const [receiveModule, notificationsModule, actionModule] = await Promise.all([
      import('@/app/api/inbound-webhooks/[id]/receive/route'),
      import('@/app/api/notifications/route'),
      import('@/app/api/notifications/[id]/actions/[actionId]/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    receive = receiveModule.POST;
    listNotifications = notificationsModule.GET;
    executeAction = actionModule.POST;
    shutdownRuntimeDatabase = runtimeModule.shutdownRuntimeDatabase;
  });

  beforeEach(async () => {
    sqlite.exec('DROP TRIGGER IF EXISTS fail_inbound_action_insert');
    await db.delete(schema.notificationActions);
    await db.delete(schema.notifications);
    await db.delete(schema.inboundWebhookLog);
    await db.delete(schema.inboundWebhookReplays);
    await db.delete(schema.inboundWebhooks);
    const now = new Date().toISOString();
    await db.insert(schema.inboundWebhooks).values({
      id: 'webhook-1',
      name: 'Home Server Alerts',
      sourceLabel: 'Home Server',
      secret: null,
      enabled: true,
      defaultAction: 'alert',
      fieldMappings: {},
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await shutdownRuntimeDatabase();
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  function postAlert(payload: Record<string, unknown>, headers?: HeadersInit) {
    return receive(new Request('http://localhost/api/inbound-webhooks/webhook-1/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    }), { params: Promise.resolve({ id: 'webhook-1' }) });
  }

  it('persists a non-actionable alert with object metadata when no URL is supplied', async () => {
    const response = await postAlert({
      title: 'Basement humidity',
      body: 'Humidity returned to normal.',
      severity: 'info',
      sensor: 'basement',
    });

    expect(response.status).toBe(201);
    const [notification] = await db.select().from(schema.notifications);
    const actions = await db.select().from(schema.notificationActions);
    expect(notification).toMatchObject({
      title: 'Basement humidity',
      isActionable: false,
      primaryActionId: null,
      metadata: {
        webhookId: 'webhook-1',
        webhookName: 'Home Server Alerts',
        originalPayload: expect.objectContaining({ sensor: 'basement' }),
      },
    });
    expect(actions).toHaveLength(0);
  });

  it('deduplicates replayed payloads before repeating side effects', async () => {
    const payload = {
      title: 'Repeated alert',
      severity: 'high',
      incidentId: 'incident-42',
    };
    expect((await postAlert(payload, { 'X-Request-Id': 'first-attempt' })).status).toBe(201);
    const duplicate = await postAlert(payload, { 'X-Request-Id': 'retry-attempt' });

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true });
    expect(await db.select().from(schema.notifications)).toHaveLength(1);
  });

  it('accepts the same payload after its replay claim expires', async () => {
    const payload = { title: 'Recurring alert', severity: 'info' };
    expect((await postAlert(payload)).status).toBe(201);
    sqlite.prepare(`
      UPDATE inbound_webhook_replays
      SET expires_at = ?
      WHERE webhook_id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), 'webhook-1');

    expect((await postAlert(payload)).status).toBe(201);
    expect(await db.select().from(schema.notifications)).toHaveLength(2);
  });

  it('rejects oversized payloads before parsing or persistence', async () => {
    const response = await receive(new Request(
      'http://localhost/api/inbound-webhooks/webhook-1/receive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'x'.repeat(256 * 1024) }),
      },
    ), { params: Promise.resolve({ id: 'webhook-1' }) });

    expect(response.status).toBe(413);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
    expect(await db.select().from(schema.inboundWebhookReplays)).toHaveLength(0);
  });

  it('verifies HMAC signatures over the raw payload bytes', async () => {
    await db.update(schema.inboundWebhooks)
      .set({ secret: 'test-secret' });
    const rawBody = JSON.stringify({ title: 'Signed alert', severity: 'info' });

    const missing = await receive(new Request(
      'http://localhost/api/inbound-webhooks/webhook-1/receive',
      { method: 'POST', body: rawBody },
    ), { params: Promise.resolve({ id: 'webhook-1' }) });
    expect(missing.status).toBe(401);

    const signature = createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    const accepted = await receive(new Request(
      'http://localhost/api/inbound-webhooks/webhook-1/receive',
      {
        method: 'POST',
        headers: { 'X-Webhook-Signature': `sha256=${signature}` },
        body: rawBody,
      },
    ), { params: Promise.resolve({ id: 'webhook-1' }) });
    expect(accepted.status).toBe(201);
  });

  it('hydrates, renders, and executes a valid primary external action', async () => {
    const actionUrl = 'https://home.example.test/incidents/42';
    const response = await postAlert({
      title: 'Garage door open',
      severity: 'high',
      actionUrl,
    }, 15_000);
    expect(response.status).toBe(201);

    const listResponse = await listNotifications(new Request('http://localhost/api/notifications'));
    const body = await listResponse.json();
    expect(body.notifications).toHaveLength(1);
    const notification = body.notifications[0];
    expect(notification).toMatchObject({
      isActionable: true,
      primaryActionId: expect.any(String),
      metadata: expect.objectContaining({ webhookId: 'webhook-1' }),
    });
    expect(notification.actions).toEqual([
      expect.objectContaining({
        id: notification.primaryActionId,
        label: 'Open Home Server',
        isPrimary: true,
        sortOrder: 0,
        payload: { url: actionUrl },
        opensExternal: true,
        createdBy: 'connector',
      }),
    ]);

    const { NotificationCard } = await import('@/components/notifications/NotificationCard');
    const onExecuteAction = vi.fn();
    render(
      <TooltipProvider>
        <NotificationCard
          notification={notification}
          isExpanded
          onExecuteAction={onExecuteAction}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Home Server' }));
    expect(onExecuteAction).toHaveBeenCalledWith(notification.primaryActionId);

    const actionResponse = await executeAction(new Request(
      `http://localhost/api/notifications/${notification.id}/actions/${notification.primaryActionId}`,
      { method: 'POST', body: '{}' },
    ), {
      params: Promise.resolve({
        id: notification.id,
        actionId: notification.primaryActionId,
      }),
    });
    await expect(actionResponse.json()).resolves.toMatchObject({
      success: true,
      result: { type: 'open_url', url: actionUrl },
    });
  });

  it('rejects non-http action URLs without creating an alert', async () => {
    const response = await postAlert({
      title: 'Unsafe action',
      severity: 'high',
      actionUrl: 'javascript:alert(1)',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Action URL must use http or https',
    });
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
    expect(await db.select().from(schema.notificationActions)).toHaveLength(0);
  });

  it('rolls back the notification when action persistence fails', async () => {
    sqlite.exec(`
      CREATE TRIGGER fail_inbound_action_insert
      BEFORE INSERT ON notification_actions
      BEGIN
        SELECT RAISE(ABORT, 'simulated action failure');
      END
    `);

    const response = await postAlert({
      title: 'Atomic alert',
      severity: 'critical',
      actionUrl: 'https://home.example.test/incidents/99',
    });

    expect(response.status).toBe(500);
    expect(await db.select().from(schema.notifications)).toHaveLength(0);
    expect(await db.select().from(schema.notificationActions)).toHaveLength(0);
  });
});
