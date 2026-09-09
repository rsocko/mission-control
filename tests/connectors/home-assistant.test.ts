import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectorConfig } from '@/types';
import {
  HomeAssistantActionError,
  HomeAssistantConnector,
} from '@/lib/connectors/home-assistant';
import { createHAClient } from '@/lib/connectors/home-assistant/ha-client';
import {
  DEFAULT_HOME_ASSISTANT_SETTINGS,
  normalizeHomeAssistantSettings,
} from '@/lib/connectors/home-assistant/settings';
import {
  buildPersistentNotifications,
  buildRepairNotifications,
  buildUpdateNotifications,
} from '@/lib/connectors/home-assistant/source-transformers';
import { homeAssistantNotificationProvider } from '@/lib/notifications/providers/home-assistant';

const nativeWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
});

describe('Home Assistant settings', () => {
  it('migrates legacy settings into the v2 source and delivery model', () => {
    const settings = normalizeHomeAssistantSettings({
      baseUrl: 'https://ha.example.test///',
      entityPatterns: ['binary_sensor.*'],
      alertRules: DEFAULT_HOME_ASSISTANT_SETTINGS.alertRules,
      updateDigest: { enabled: false, time: '07:30' },
      enableActions: true,
    });

    expect(settings.baseUrl).toBe('https://ha.example.test');
    expect(settings.sources.entityAlerts.enabled).toBe(true);
    expect(settings.sources.updates.enabled).toBe(true);
    expect(settings.outboundDelivery).toMatchObject({
      updatePush: 'off',
      dailySummaryTime: '07:30',
    });
    expect(settings.actions.enabled).toBe(true);
  });

  it('rejects unsafe or malformed Home Assistant URLs', () => {
    expect(() => normalizeHomeAssistantSettings({ baseUrl: 'file:///etc/passwd' }))
      .toThrow('Home Assistant URL must use http or https');
    expect(() => normalizeHomeAssistantSettings({ baseUrl: 'not a url' }))
      .toThrow();
  });
});

describe('Home Assistant source transformers', () => {
  const common = {
    connectorType: 'home-assistant',
    connectorInstanceId: 'ha-lake',
    instanceName: 'Lake House',
    baseUrl: 'https://ha.example.test',
    actionsEnabled: true,
  };

  it('creates one independently actionable notification per active update', () => {
    const notifications = buildUpdateNotifications({
      ...common,
      states: [
        {
          entity_id: 'update.home_assistant_core_update',
          state: 'on',
          attributes: {
            friendly_name: 'Home Assistant Core',
            installed_version: '2025.6.0',
            latest_version: '2025.7.3',
            supported_features: 9,
          },
          last_updated: '2025-07-01T12:00:00.000Z',
        },
        {
          entity_id: 'update.esphome_update',
          state: 'off',
          attributes: { friendly_name: 'ESPHome' },
        },
      ],
      criticalEntityPatterns: ['update.home_assistant_*'],
      updatePush: 'daily_summary',
      immediateCriticalUpdates: true,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: 'update:update.home_assistant_core_update:2025.7.3',
      level: 'action_needed',
      templateKey: 'ha_update_critical',
      actionUrl: 'https://ha.example.test/config/updates',
    });
    expect(notifications[0].metadata).toMatchObject({
      instanceName: 'Lake House',
      installedVersion: '2025.6.0',
      latestVersion: '2025.7.3',
      supportsInstall: true,
      supportsBackup: true,
      pushDelivery: 'immediate',
    });
  });

  it('maps persistent notifications and repairs to stable source identities', () => {
    const persistent = buildPersistentNotifications({
      ...common,
      items: [{
        notification_id: 'water_filter',
        title: 'Replace water filter',
        message: 'Filter life is below 5%.',
        created_at: '2025-07-01T12:00:00.000Z',
      }],
      criticalNotificationPatterns: ['water_*'],
      immediateCritical: true,
    });
    const repairs = buildRepairNotifications({
      ...common,
      issues: [{
        domain: 'mqtt',
        issue_id: 'broker_unavailable',
        severity: 'error',
        title: 'MQTT broker unavailable',
        is_fixable: true,
      }],
      immediateActionNeeded: true,
    });

    expect(persistent[0]).toMatchObject({
      id: 'persistent:water_filter',
      level: 'action_needed',
      templateKey: 'ha_persistent_critical',
    });
    expect(repairs[0]).toMatchObject({
      id: 'repair:mqtt:broker_unavailable',
      level: 'action_needed',
      templateKey: 'ha_repair_error',
    });
    expect(repairs[0].metadata).toMatchObject({
      domain: 'mqtt',
      issueId: 'broker_unavailable',
      pushDelivery: 'immediate',
    });
  });
});

describe('Home Assistant notification presentation', () => {
  const present = homeAssistantNotificationProvider.signatures[0].present;
  const notification = {
    id: 'ha-update',
    sourceId: 'update.router',
    connectorType: 'home-assistant',
    connectorInstanceId: 'ha-lake',
    title: 'Router update',
    level: 'heads_up' as const,
    category: 'system',
    isRead: false,
    isActionable: true,
    receivedAt: '2025-07-01T12:00:00.000Z',
    hubProjectIds: [],
    tags: [],
  };

  it('does not offer update mutations when install is unsupported or already in progress', () => {
    const unsupported = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        actionsEnabled: true,
        supportsInstall: false,
        canSkip: true,
        baseUrl: 'https://ha.example.test',
      },
    });
    const inProgress = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        actionsEnabled: true,
        supportsInstall: true,
        canSkip: true,
        inProgress: true,
        baseUrl: 'https://ha.example.test',
      },
    });

    expect(unsupported.actions?.map(action => action.actionType)).toEqual([
      'open_url',
      'create_task',
    ]);
    expect(inProgress.actions?.map(action => action.actionType)).toEqual([
      'open_url',
      'create_task',
    ]);
  });

  it('offers install and skip only for an installable idle update', () => {
    const result = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        actionsEnabled: true,
        supportsInstall: true,
        canSkip: true,
        inProgress: false,
        baseUrl: 'https://ha.example.test',
      },
    });

    expect(result.actions?.map(action => action.actionType)).toEqual([
      'install_update',
      'skip_update',
      'open_url',
      'create_task',
    ]);
  });
});

describe('Home Assistant WebSocket client', () => {
  it('authenticates once and correlates independent source responses by id', async () => {
    class FakeWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string) {
        queueMicrotask(() => this.emit({ type: 'auth_required' }));
      }

      send(data: string) {
        const message = JSON.parse(data) as Record<string, unknown>;
        if (message.type === 'auth') {
          queueMicrotask(() => this.emit({ type: 'auth_ok' }));
        } else if (message.type === 'persistent_notification/get') {
          queueMicrotask(() => this.emit({
            id: message.id,
            type: 'result',
            success: true,
            result: [{ notification_id: 'notice-1', title: 'Notice' }],
          }));
        } else if (message.type === 'repairs/list_issues') {
          queueMicrotask(() => this.emit({
            id: message.id,
            type: 'result',
            success: true,
            result: { issues: [{ domain: 'mqtt', issue_id: 'offline' }] },
          }));
        }
      }

      close() {}

      private emit(message: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const result = await createHAClient({
      baseUrl: 'https://ha.example.test',
      accessToken: 'secret',
    }).fetchWebSocketSources(['persistentNotifications', 'repairs']);

    expect(result.errors).toEqual({});
    expect(result.persistentNotifications?.[0].notification_id).toBe('notice-1');
    expect(result.repairs?.[0]).toMatchObject({ domain: 'mqtt', issue_id: 'offline' });
  });
});

describe('HomeAssistantConnector', () => {
  const config: ConnectorConfig = {
    id: 'ha-lake',
    type: 'home-assistant',
    name: 'Lake House',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 5,
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: true,
      tags: false,
      tagWriteBack: false,
      notificationOnly: true,
      listSelectionMode: 'not-applicable',
    },
    credentials: { accessToken: 'secret' },
    settings: {
      baseUrl: 'https://ha.example.test',
      sources: {
        entityAlerts: { enabled: false },
        updates: { enabled: true, criticalEntityPatterns: [] },
        persistentNotifications: {
          enabled: true,
          criticalNotificationPatterns: [],
        },
        repairs: { enabled: true },
      },
      actions: { enabled: true },
    },
    syncedLists: [],
  };

  it('keeps successful source items but disables reconciliation after a partial failure', async () => {
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchStates: async () => [{
          entity_id: 'update.router',
          state: 'on',
          attributes: {
            friendly_name: 'Router',
            installed_version: '1.0',
            latest_version: '1.1',
            supported_features: 1,
          },
        }],
        fetchWebSocketSources: async () => ({
          persistentNotifications: [{
            notification_id: 'notice',
            title: 'Notice',
          }],
          errors: { repairs: 'Repairs unavailable' },
        }),
      },
    });

    const notifications = await connector.fetchNotifications();
    expect(notifications.map(item => item.id)).toEqual([
      'update:update.router:1.1',
      'persistent:notice',
    ]);
    await expect(connector.getActiveAlertSourceIds()).resolves.toBeNull();
  });

  it('uses only stored notification metadata for an update action target', async () => {
    const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchStates: async () => [{
          entity_id: 'update.router',
          state: 'on',
          attributes: {
            latest_version: '1.1',
            supported_features: 9,
          },
        }],
        callService: async (domain: string, service: string, data: Record<string, unknown>) => {
          calls.push({ domain, service, data });
        },
      },
    });

    await connector.executeNotificationAction(
      'install_update',
      { entityId: 'update.router', latestVersion: '1.1', supportsBackup: true },
      { entityId: 'update.attacker_controlled', createBackup: true },
    );
    expect(calls).toEqual([{
      domain: 'update',
      service: 'install',
      data: { entity_id: 'update.router', backup: true },
    }]);
  });

  it('rejects a stale update version before calling Home Assistant', async () => {
    const calls: unknown[] = [];
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchStates: async () => [{
          entity_id: 'update.router',
          state: 'on',
          attributes: {
            latest_version: '2.0',
            supported_features: 1,
          },
        }],
        callService: async (...args: unknown[]) => calls.push(args),
      },
    });

    await expect(connector.executeNotificationAction(
      'install_update',
      { entityId: 'update.router', latestVersion: '1.1', supportsBackup: false },
      {},
    )).rejects.toEqual(expect.objectContaining({ status: 409 }));
    expect(calls).toEqual([]);
  });

  it('rejects an action when the source item is no longer active', async () => {
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchStates: async () => [],
      },
    });

    await expect(connector.executeNotificationAction(
      'install_update',
      { entityId: 'update.router', supportsBackup: false },
      {},
    )).rejects.toEqual(expect.objectContaining({
      status: 409,
      name: HomeAssistantActionError.name,
    }));
  });
});
