import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

const tempDirectories: string[] = [];

function health(
  overrides: Partial<{
    status: 'ok' | 'degraded';
    mode: 'demo' | 'live';
    reachable: boolean;
    authenticated: boolean;
    authState: 'unauthenticated' | 'connected' | 'expired' | 'degraded';
  }> = {},
) {
  return {
    contractVersion: '1.0' as const,
    status: 'ok' as const,
    mode: 'live' as const,
    reachable: true,
    authenticated: true,
    authState: 'connected' as const,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-monarch-contract-version': '1.0',
    },
  });
}

async function loadHarness(existingPath?: string) {
  const directory = existingPath ?? mkdtempSync(join(tmpdir(), 'mc-monarch-recovery-'));
  if (!existingPath) tempDirectories.push(directory);
  process.env.MC_DB_PATH = join(directory, 'recovery.db');
  process.env.TYRION_OPERATIONS_URL = 'https://operations.example';
  process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS = 'operations.example';
  vi.doUnmock('@/db');
  vi.doUnmock('drizzle-orm');
  vi.resetModules();
  const [dbModule, schema, recovery] = await Promise.all([
    import('@/db'),
    import('@/db/schema'),
    import('@/lib/connectors/monarch-money/connection-recovery'),
  ]);
  return {
    directory,
    db: dbModule.default,
    sqlite: dbModule.sqlite,
    schema,
    recovery,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MC_DB_PATH;
  delete process.env.TYRION_OPERATIONS_URL;
  delete process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS;
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('Monarch connection-loss recovery', () => {
  it('suppresses transient failures and escalates at the exact 15 minute and 4 hour boundaries', async () => {
    const harness = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    const observation = { kind: 'unavailable' as const, errorCode: 'bridge_unavailable' };

    expect(harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: startedAt,
    })).toMatchObject({ status: 'transient', notificationCreated: false, taskCreated: false });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 15 * 60_000 - 1),
    });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(0);

    expect(harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 15 * 60_000),
    })).toMatchObject({ status: 'degraded', notificationCreated: true, taskCreated: false });
    const notificationRows = await harness.db.select().from(harness.schema.notifications);
    const actionRows = await harness.db.select().from(harness.schema.notificationActions);
    expect(notificationRows).toHaveLength(1);
    expect(notificationRows[0]).toMatchObject({
      level: 'action_needed',
      sourceState: 'active',
      isActionable: true,
    });
    expect(actionRows.map((action) => action.label)).toEqual([
      'Reconnect Monarch',
      'Open Finance settings',
    ]);
    expect(JSON.stringify(actionRows)).not.toMatch(
      /cookie|session_id|csrftoken|returnUrl|assertion/i,
    );

    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 - 1),
    });
    expect(await harness.db.select().from(harness.schema.tasks)).toHaveLength(0);

    expect(harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000),
    })).toMatchObject({ taskCreated: true });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 5 * 60 * 60_000),
    });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(1);
    expect(await harness.db.select().from(harness.schema.tasks)).toHaveLength(1);
    expect(await harness.db.select().from(harness.schema.myDayItems)).toHaveLength(1);
    expect((await harness.db.select().from(harness.schema.tasks))[0]).toMatchObject({
      title: 'Reconnect Monarch',
      priority: 'high',
    });
    harness.sqlite.close();
  });

  it('routes verified authentication loss immediately and retains one outage transition group', async () => {
    const harness = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    const expired = {
      kind: 'health' as const,
      health: health({ authenticated: false, authState: 'expired', status: 'degraded' }),
    };
    expect(harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: expired,
      now: startedAt,
    })).toMatchObject({ status: 'authentication_expired', notificationCreated: true });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: new Date(startedAt.getTime() + 16 * 60_000),
    });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 60 * 60_000),
    });
    expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .toMatchObject({ status: 'recovery_pending', canVerifyRecovery: true });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000),
    });
    const [notification] = await harness.db.select().from(harness.schema.notifications);
    expect(notification).toMatchObject({
      level: 'urgent',
      groupKey: 'finance-connection:finance-one',
      templateKey: 'connectorAuthenticationExpired',
    });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(1);
    expect((await harness.db.select().from(harness.schema.tasks))[0])
      .toMatchObject({ title: 'Verify Monarch recovery', priority: 'critical' });
    harness.sqlite.close();
  });

  it('preserves episode timing across process restart', async () => {
    const first = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    first.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: startedAt,
    });
    first.sqlite.close();

    const restarted = await loadHarness(first.directory);
    restarted.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: new Date(startedAt.getTime() + 15 * 60_000),
    });
    const [episode] = await restarted.db.select().from(
      restarted.schema.financeConnectionOutages,
    );
    expect(episode.startedAt).toBe(startedAt.toISOString());
    expect(await restarted.db.select().from(restarted.schema.notifications)).toHaveLength(1);
    restarted.sqlite.close();
  });

  it('settles only after connected health, a bounded sync, and a second connected health check', async () => {
    const harness = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: {
        kind: 'health',
        health: health({ authenticated: false, authState: 'expired', status: 'degraded' }),
      },
      now: startedAt,
    });
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 60_000),
    });
    expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .toMatchObject({ status: 'recovery_pending', staleData: true });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(health()))
      .mockResolvedValueOnce(jsonResponse({ contractVersion: '1.0', status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(health()));
    vi.stubGlobal('fetch', fetchMock);
    const config: ConnectorConfig = {
      id: 'finance-one',
      type: 'finance-manager',
      name: 'Tyrion',
      enabled: true,
      syncMode: 'poll',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: false,
        tags: true,
        tagWriteBack: false,
      },
      credentials: { serviceToken: 'invented-service-token-with-32-characters' },
      settings: { bridgeUrl: 'http://localhost:8100', maxRetries: 0 },
      syncedLists: [],
    };
    await expect(harness.recovery.verifyFinanceConnectionRecovery({
      config,
      now: new Date(startedAt.getTime() + 2 * 60_000),
    })).resolves.toEqual({ recovered: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8100/health',
      'http://localhost:8100/sync?days=30',
      'http://localhost:8100/health',
    ]);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
    expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one')).toBeNull();
    expect((await harness.db.select().from(harness.schema.notifications))[0])
      .toMatchObject({ sourceState: 'resolved', isActionable: false });

    const secondEpisodeAt = new Date(startedAt.getTime() + 5 * 60_000);
    harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: {
        kind: 'health',
        health: health({ authenticated: false, authState: 'expired', status: 'degraded' }),
      },
      now: secondEpisodeAt,
    });
    expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .toMatchObject({
        status: 'authentication_expired',
        startedAt: secondEpisodeAt.toISOString(),
      });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(2);
    harness.sqlite.close();
  });
});
