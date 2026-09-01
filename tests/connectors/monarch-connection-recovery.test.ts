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

    expect(await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: startedAt,
    })).toMatchObject({ status: 'transient', notificationCreated: false, taskCreated: false });
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 15 * 60_000 - 1),
    });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(0);

    expect(await harness.recovery.reconcileFinanceConnectionObservation({
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

    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000 - 1),
    });
    expect(await harness.db.select().from(harness.schema.tasks)).toHaveLength(0);

    expect(await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation,
      now: new Date(startedAt.getTime() + 4 * 60 * 60_000),
    })).toMatchObject({ taskCreated: true });
    await harness.recovery.reconcileFinanceConnectionObservation({
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
    expect(await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: expired,
      now: startedAt,
    })).toMatchObject({ status: 'authentication_expired', notificationCreated: true });
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: new Date(startedAt.getTime() + 16 * 60_000),
    });
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 60 * 60_000),
    });
    expect(await harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .toMatchObject({ status: 'recovery_pending', canVerifyRecovery: true });
    await harness.recovery.reconcileFinanceConnectionObservation({
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
    await first.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: startedAt,
    });
    first.sqlite.close();

    const restarted = await loadHarness(first.directory);
    await restarted.recovery.reconcileFinanceConnectionObservation({
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
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: {
        kind: 'health',
        health: health({ authenticated: false, authState: 'expired', status: 'degraded' }),
      },
      now: startedAt,
    });
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 60_000),
    });
    expect(await harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
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
    expect(await harness.recovery.getFinanceConnectionRecoveryView('finance-one')).toBeNull();
    expect((await harness.db.select().from(harness.schema.notifications))[0])
      .toMatchObject({ sourceState: 'resolved', isActionable: false });

    const secondEpisodeAt = new Date(startedAt.getTime() + 5 * 60_000);
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: {
        kind: 'health',
        health: health({ authenticated: false, authState: 'expired', status: 'degraded' }),
      },
      now: secondEpisodeAt,
    });
    expect(await harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .toMatchObject({
        status: 'authentication_expired',
        startedAt: secondEpisodeAt.toISOString(),
      });
    expect(await harness.db.select().from(harness.schema.notifications)).toHaveLength(2);
    harness.sqlite.close();
  });

  it('ignores delayed observations that would roll back newer recovery state', async () => {
    const harness = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: startedAt,
    });
    const healthyAt = new Date(startedAt.getTime() + 2 * 60_000);
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: healthyAt,
    });

    await expect(harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'delayed_unavailable' },
      now: new Date(startedAt.getTime() + 60_000),
    })).resolves.toMatchObject({ status: 'recovery_pending' });
    await expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .resolves.toMatchObject({
        status: 'recovery_pending',
        lastObservedAt: healthyAt.toISOString(),
      });
    harness.sqlite.close();
  });

  it('does not settle an episode after a newer unhealthy observation', async () => {
    const harness = await loadHarness();
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    await harness.recovery.reconcileFinanceConnectionObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: startedAt,
    });
    const recoveryAt = new Date(startedAt.getTime() + 2 * 60_000);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(health()))
      .mockResolvedValueOnce(jsonResponse({ contractVersion: '1.0', status: 'ok' }))
      .mockImplementationOnce(async () => {
        await harness.recovery.reconcileFinanceConnectionObservation({
          connectorId: 'finance-one',
          observation: { kind: 'unavailable', errorCode: 'concurrent_unavailable' },
          now: new Date(recoveryAt.getTime() + 60_000),
        });
        return jsonResponse(health());
      });
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
      now: recoveryAt,
    })).resolves.toEqual({
      recovered: false,
      reason: 'outage_episode_changed',
    });
    await expect(harness.recovery.getFinanceConnectionRecoveryView('finance-one'))
      .resolves.toMatchObject({
        status: 'transient',
        lastObservedAt: new Date(recoveryAt.getTime() + 60_000).toISOString(),
      });
    harness.sqlite.close();
  });

  it('fences bounded sync outcomes against newer observations on SQLite', async () => {
    const harness = await loadHarness();
    const persistence = (
      await (await import('@/lib/persistence/worker-runtime')).getWorkerPersistenceRepositories()
    ).finance.recovery;
    const startedAt = new Date('2026-08-22T12:00:00.000Z');
    await persistence.reconcileObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'bridge_unavailable' },
      now: startedAt,
    });
    const episode = await persistence.getActiveEpisode('finance-one');
    expect(episode).not.toBeNull();

    await persistence.reconcileObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 60_000),
    });
    await expect(persistence.recordBoundedSyncFailure({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      errorCode: 'delayed_failure',
      now: startedAt,
    })).resolves.toBe(false);
    await expect(persistence.recordBoundedSyncSuccess({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 2 * 60_000),
    })).resolves.toBe(true);

    await persistence.reconcileObservation({
      connectorId: 'finance-one',
      observation: { kind: 'unavailable', errorCode: 'newer_unavailable' },
      now: new Date(startedAt.getTime() + 3 * 60_000),
    });
    await expect(persistence.recordBoundedSyncSuccess({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 4 * 60_000),
    })).resolves.toBe(false);
    await expect(persistence.recordBoundedSyncFailure({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      errorCode: 'bounded_sync_failed',
      now: new Date(startedAt.getTime() + 4 * 60_000),
    })).resolves.toBe(false);

    await persistence.reconcileObservation({
      connectorId: 'finance-one',
      observation: { kind: 'health', health: health() },
      now: new Date(startedAt.getTime() + 5 * 60_000),
    });
    await expect(persistence.settleEpisode({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 6 * 60_000),
    })).resolves.toBe(false);
    await expect(persistence.recordBoundedSyncSuccess({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 7 * 60_000),
    })).resolves.toBe(true);
    await expect(persistence.settleEpisode({
      connectorId: 'finance-one',
      episodeId: episode!.episodeId,
      now: new Date(startedAt.getTime() + 8 * 60_000),
    })).resolves.toBe(true);
    harness.sqlite.close();
  });

  it('blocks bounded recovery sync without contacting Monarch while quarantined', async () => {
    const harness = await loadHarness();
    const now = '2026-08-22T12:00:00.000Z';
    const config: ConnectorConfig = {
      id: 'finance-quarantined',
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
    harness.db.insert(harness.schema.connectorConfigs).values({
      ...config,
      createdAt: now,
      updatedAt: now,
    }).run();
    harness.db.insert(harness.schema.connectorSyncControls).values({
      connectorId: config.id,
      schedulerState: 'quarantined',
      quarantineId: 'quarantine-recovery-test',
      quarantinedAt: now,
      updatedAt: now,
    }).run();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(harness.recovery.verifyFinanceConnectionRecovery({
      config,
      now: new Date(now),
    })).resolves.toEqual({
      recovered: false,
      reason: 'connector_sync_quarantined',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    harness.sqlite.close();
  });
});
