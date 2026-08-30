import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Alertmanager integration operations', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let operations: typeof import('@/lib/alertmanager/operations');

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN = 'test-token-with-at-least-32-characters';
    process.env.MC_ALERTMANAGER_INTEGRATION_ID = 'homelab';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    [db, { sqlite }, schema, operations] = await Promise.all([
      import('@/db').then(module => module.default),
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/alertmanager/operations'),
    ]);
  }, 30_000);

  beforeEach(async () => {
    sqlite.exec('DROP TRIGGER IF EXISTS fail_alertmanager_operator_audit');
    await db.delete(schema.alertmanagerIntegrationEvents);
    await db.delete(schema.homelabAlertReceipts);
    await db.delete(schema.notificationActions);
    await db.delete(schema.notificationDeliveryEvents);
    await db.delete(schema.notifications);
    await db.delete(schema.appSettings);
  });

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
    delete process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN;
    delete process.env.MC_ALERTMANAGER_INTEGRATION_ID;
  });

  it('distinguishes configured, connected, and degraded states from durable outcomes', async () => {
    let status = await operations.getAlertmanagerIntegrationStatus();
    expect(status).toMatchObject({
      configured: true,
      connected: false,
      state: 'awaiting_delivery',
    });

    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'projected',
      authenticated: true,
      httpStatus: 200,
      result: { accepted: 2, applied: 2, created: 1, updated: 1 },
      occurredAt: new Date('2026-08-29T20:00:00.000Z'),
    });
    status = await operations.getAlertmanagerIntegrationStatus();
    expect(status).toMatchObject({
      connected: true,
      state: 'connected',
      counts: { requests: 1, accepted: 2, applied: 2 },
    });

    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'authentication_failed',
      authenticated: false,
      httpStatus: 401,
      occurredAt: new Date('2026-08-29T20:00:30.000Z'),
    });
    status = await operations.getAlertmanagerIntegrationStatus();
    expect(status).toMatchObject({
      connected: true,
      state: 'connected',
      counts: { requests: 2, failures: 0 },
    });
    expect(status.recentFailures).toEqual([]);

    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'invalid_batch',
      authenticated: true,
      httpStatus: 422,
      detail: 'alerts.0: invalid',
      occurredAt: new Date('2026-08-29T20:01:00.000Z'),
    });
    status = await operations.getAlertmanagerIntegrationStatus();
    expect(status).toMatchObject({
      connected: true,
      state: 'degraded',
      counts: { requests: 3, failures: 1 },
    });
    expect(status.recentFailures[0]).toMatchObject({
      outcome: 'invalid_batch',
      detail: 'alerts.0: invalid',
    });
  });

  it('persists pause and resume as audited operator actions', async () => {
    await operations.setAlertmanagerPaused('homelab', true, 'Settings');
    expect(await operations.getAlertmanagerControl()).toMatchObject({ paused: true });
    expect(await operations.getAlertmanagerIntegrationStatus()).toMatchObject({
      enabled: false,
      paused: true,
      state: 'paused',
    });

    await operations.setAlertmanagerPaused('homelab', false, 'Settings');
    expect(await operations.getAlertmanagerControl()).toMatchObject({ paused: false });
    const events = await db.select().from(schema.alertmanagerIntegrationEvents);
    expect(events.map(event => event.outcome)).toEqual(['paused', 'resumed']);
    expect(events.every(event => event.detail?.includes('Settings'))).toBe(true);
  });

  it('rolls back pause state when its audit event cannot be persisted', async () => {
    sqlite.exec(`
      CREATE TRIGGER fail_alertmanager_operator_audit
      BEFORE INSERT ON alertmanager_integration_events
      WHEN NEW.kind = 'operator_action'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END
    `);

    await expect(
      operations.setAlertmanagerPaused('homelab', true, 'Settings'),
    ).rejects.toThrow(/simulated audit failure/);
    expect(await operations.getAlertmanagerControl()).toMatchObject({ paused: false });
  });

  it('runs and cleans up one safe deduplicated synthetic lifecycle', async () => {
    const result = await operations.runSyntheticAlertmanagerLifecycle('homelab');

    expect(result).toMatchObject({
      success: true,
      lifecycle: ['firing', 'duplicate_firing', 'resolved'],
      projectionCount: 1,
      receiptCount: 2,
      duplicateReceipts: 1,
    });
    expect(await db.select().from(schema.notifications)).toEqual([]);
    expect(await db.select().from(schema.homelabAlertReceipts)).toEqual([]);
    expect(await db.select().from(schema.notificationDeliveryEvents)).toEqual([]);
  });

  it('never exposes the configured bearer token in status', async () => {
    const statusJson = JSON.stringify(await operations.getAlertmanagerIntegrationStatus());
    expect(statusJson).not.toContain(process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN);
  });

  it('retains the last successful projection beyond the recent display window', async () => {
    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'projected',
      authenticated: true,
      httpStatus: 200,
      occurredAt: new Date('2026-08-29T18:00:00.000Z'),
    });
    await db.insert(schema.alertmanagerIntegrationEvents).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `auth-failure-${index}`,
        integration: 'homelab',
        kind: 'webhook_request' as const,
        outcome: 'authentication_failed',
        authenticated: false,
        httpStatus: 401,
        occurredAt: new Date(Date.parse('2026-08-29T19:00:00.000Z') + index).toISOString(),
      })),
    );

    expect(await operations.getAlertmanagerIntegrationStatus()).toMatchObject({
      connected: true,
      state: 'connected',
    });
  });

  it('retains the latest authenticated failure beyond the event history window', async () => {
    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'projected',
      authenticated: true,
      httpStatus: 200,
      occurredAt: new Date('2026-08-29T18:00:00.000Z'),
    });
    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'webhook_request',
      outcome: 'invalid_batch',
      authenticated: true,
      httpStatus: 422,
      detail: 'preserve this health landmark',
      occurredAt: new Date('2026-08-29T18:30:00.000Z'),
    });
    await db.insert(schema.alertmanagerIntegrationEvents).values(
      Array.from({ length: 1_001 }, (_, index) => ({
        id: `distributed-auth-failure-${index}`,
        integration: 'homelab',
        kind: 'webhook_request' as const,
        outcome: 'authentication_failed',
        authenticated: false,
        httpStatus: 401,
        occurredAt: new Date(Date.parse('2026-08-29T19:00:00.000Z') + index).toISOString(),
      })),
    );
    await operations.recordAlertmanagerIntegrationEvent({
      integration: 'homelab',
      kind: 'operator_action',
      outcome: 'resumed',
      authenticated: true,
      httpStatus: 200,
      occurredAt: new Date('2026-08-29T20:00:00.000Z'),
    });

    const status = await operations.getAlertmanagerIntegrationStatus();
    expect(status).toMatchObject({
      connected: true,
      state: 'degraded',
    });
    expect(status.recentFailures[0]).toMatchObject({
      outcome: 'invalid_batch',
      detail: 'preserve this health landmark',
    });
  });
});
