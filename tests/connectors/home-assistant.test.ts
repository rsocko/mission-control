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
const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.WebSocket = nativeWebSocket;
  globalThis.fetch = nativeFetch;
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
            entity_picture: '/api/brands/integration/homeassistant/icon.png',
            icon: 'mdi:home-assistant',
            device_class: 'firmware',
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
      entityPicture: '/api/brands/integration/homeassistant/icon.png',
      mdiIcon: 'mdi:home-assistant',
      deviceClass: 'firmware',
      updateType: 'software',
      supportsInstall: true,
      supportsBackup: true,
      supportsReleaseNotes: false,
      pushDelivery: 'immediate',
    });
  });

  it('advertises full release notes and links the release announcement when provided', () => {
    const [notification] = buildUpdateNotifications({
      ...common,
      states: [{
        entity_id: 'update.battery_notes',
        state: 'on',
        attributes: {
          friendly_name: 'Battery Notes',
          installed_version: '3.4.8',
          latest_version: '3.6.3',
          release_summary: 'Bug fixes and sensor improvements.',
          release_url: 'https://github.com/example/battery-notes/releases/tag/3.6.3',
          title: 'Battery Notes',
          update_percentage: 42,
          supported_features: 17,
        },
      }],
      criticalEntityPatterns: [],
      updatePush: 'daily_summary',
      immediateCriticalUpdates: true,
    });

    expect(notification.body).toBe('Bug fixes and sensor improvements.');
    expect(notification.title).toBe('Update available: Battery Notes');
    expect(notification.metadata).toMatchObject({
      supportsInstall: true,
      supportsReleaseNotes: true,
      releaseUrl: 'https://github.com/example/battery-notes/releases/tag/3.6.3',
    });
    expect(homeAssistantNotificationProvider.signatures[0].present(notification)
      .presentation?.richContent).toMatchObject({
        progress: {
          value: 42,
          max: 100,
          label: '42% installed',
        },
        links: [{
          label: 'Read release announcement',
          url: 'https://github.com/example/battery-notes/releases/tag/3.6.3',
        }],
      });
  });

  it('identifies Supervisor add-on updates as app updates', () => {
    const notifications = buildUpdateNotifications({
      ...common,
      states: [{
        entity_id: 'update.mosquitto_broker_update',
        state: 'on',
        attributes: {
          friendly_name: 'Mosquitto broker Update',
          installed_version: '7.0.0',
          latest_version: '7.1.1',
          supported_features: 9,
          entity_picture: '/api/hassio/addons/core_mosquitto/icon',
        },
      }],
      criticalEntityPatterns: [],
      updatePush: 'daily_summary',
      immediateCriticalUpdates: true,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].metadata).toMatchObject({
      entityPicture: '/api/hassio/addons/core_mosquitto/icon',
      updateType: 'app',
    });

    const presented = homeAssistantNotificationProvider.signatures[0].present(notifications[0]);
    expect(presented.presentation?.subtitle).toBe('App update');
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
      actionUrl: 'https://ha.example.test',
    });
    expect(repairs[0]).toMatchObject({
      id: 'repair:mqtt:broker_unavailable',
      level: 'action_needed',
      templateKey: 'ha_repair_error',
      actionUrl: 'https://ha.example.test/config/repairs',
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

  it('exposes a notification-scoped icon URL for canonical Home Assistant brand images', () => {
    const presented = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        entityPicture: '/api/brands/integration/bambu_lab/icon.png',
      },
    });

    expect(presented.presentation).toMatchObject({
      subjectIconUrl: '/api/notifications/ha-update/subject-icon',
    });
    expect(presented.presentation?.subjectIcon).toBeUndefined();
  });

  it('uses the Home Assistant entity icon when no brand image is available', () => {
    const explicit = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'entity_alerts',
        entityId: 'binary_sensor.garage_motion',
        state: 'on',
        attributes: { icon: 'mdi:motion-sensor' },
      },
    });
    const lock = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'entity_alerts',
        entityId: 'lock.rear_door',
        state: 'unlocked',
        attributes: { icon: 'https://example.com/not-an-icon' },
      },
    });

    expect(explicit.presentation).toMatchObject({
      subjectIcon: 'mdi:motion-sensor',
    });
    expect(lock.presentation).toMatchObject({
      subjectIcon: 'mdi:lock-open-alert',
    });
  });

  it('uses Home Assistant generic update artwork when an update has no brand image', () => {
    const presented = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        entityId: 'update.advanced_camera_card_update',
        state: 'on',
      },
    });

    expect(presented.presentation).toMatchObject({
      subjectIcon: 'mdi:package-up',
    });
  });

  it('uses authenticated Supervisor add-on artwork for non-HACS updates', () => {
    const presented = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        entityId: 'update.matter_server_update',
        state: 'on',
        entityPicture: '/api/hassio/addons/core_matter_server/icon',
      },
    });

    expect(presented.presentation).toMatchObject({
      subjectIconUrl: '/api/notifications/ha-update/subject-icon',
      subjectIcon: 'mdi:package-up',
    });
  });

  it('uses a repair integration domain but rejects arbitrary entity image URLs', () => {
    const repair = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'repairs',
        domain: 'mqtt',
      },
    });
    const arbitraryImage = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource: 'entity_alerts',
        attributes: { entity_picture: 'https://example.com/private-camera.jpg' },
      },
    });

    expect(repair.presentation).toMatchObject({
      subjectIconUrl: '/api/notifications/ha-update/subject-icon',
    });
    expect(arbitraryImage.presentation?.subjectIconUrl).toBeUndefined();
  });

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
      actionUrl: 'https://ha.example.test/config/updates',
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
    expect(result.actions?.find(action => action.actionType === 'open_url')?.payload).toEqual({
      url: 'https://ha.example.test/config/updates',
    });
  });

  it('upgrades a persisted root action URL for an update notification', () => {
    const result = present({
      ...notification,
      actionUrl: 'https://ha.example.test',
      metadata: {
        schemaVersion: 2,
        haSource: 'updates',
        actionsEnabled: false,
        baseUrl: 'https://ha.example.test',
      },
    });

    expect(result.actions?.find(action => action.actionType === 'open_url')?.payload).toEqual({
      url: 'https://ha.example.test/config/updates',
    });
  });

  it.each([
    ['updates', {}, 'https://ha.example.test/config/updates'],
    ['repairs', {}, 'https://ha.example.test/config/repairs'],
    ['entity_alerts', { entityId: 'binary_sensor.garage_door' }, 'https://ha.example.test/config/entities?domain=binary_sensor'],
    ['persistent_notifications', {}, 'https://ha.example.test/'],
  ])('restores the %s destination for notifications stored before action URLs', (
    haSource,
    sourceMetadata,
    expectedUrl,
  ) => {
    const result = present({
      ...notification,
      metadata: {
        schemaVersion: 2,
        haSource,
        actionsEnabled: false,
        baseUrl: 'https://ha.example.test/',
        ...sourceMetadata,
      },
    });

    expect(result.actions?.find(action => action.actionType === 'open_url')?.payload).toEqual({
      url: expectedUrl,
    });
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

  it('fetches Markdown release notes for a supported update entity', async () => {
    const sent: Record<string, unknown>[] = [];
    class FakeWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        queueMicrotask(() => this.emit({ type: 'auth_required' }));
      }

      send(data: string) {
        const message = JSON.parse(data) as Record<string, unknown>;
        sent.push(message);
        if (message.type === 'auth') {
          queueMicrotask(() => this.emit({ type: 'auth_ok' }));
        } else if (message.type === 'update/release_notes') {
          queueMicrotask(() => this.emit({
            id: message.id,
            type: 'result',
            success: true,
            result: '## Bug fixes\n\n- Fixed discovery.',
          }));
        }
      }

      close() {}

      private emit(message: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const notes = await createHAClient({
      baseUrl: 'https://ha.example.test',
      accessToken: 'secret',
    }).fetchUpdateReleaseNotes('update.battery_notes');

    expect(notes).toBe('## Bug fixes\n\n- Fixed discovery.');
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'update/release_notes',
      entity_id: 'update.battery_notes',
    }));
  });
});

describe('Home Assistant REST client', () => {
  it('fetches PNG brand images with the connector authorization header', async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret',
      });
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });

    const client = createHAClient({
      baseUrl: 'https://ha.example.test',
      accessToken: 'secret',
    });
    const image = await client.fetchImage('/api/brands/integration/bambu_lab/icon.png');

    expect(image.contentType).toBe('image/png');
    expect(Array.from(new Uint8Array(image.body))).toEqual([137, 80, 78, 71]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://ha.example.test/api/brands/integration/bambu_lab/icon.png',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('includes Home Assistant response details when a service request fails', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: 'Entity update.router does not support installation' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );

    const client = createHAClient({
      baseUrl: 'https://ha.example.test',
      accessToken: 'secret',
    });

    await expect(client.callService('update', 'install', {
      entity_id: 'update.router',
    })).rejects.toThrow(
      'Home Assistant request failed: HTTP 400: Entity update.router does not support installation',
    );
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

  it('reconciles successful sources without clearing a failed sibling source', async () => {
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
    await expect(connector.reconcileAlerts([
      'ha-lake:update:update.router:1.1',
      'ha-lake:persistent:old-notice',
      'ha-lake:repair:mqtt:offline',
    ])).resolves.toEqual([
      {
        sourceId: 'ha-lake:update:update.router:1.1',
        resolved: false,
        verified: true,
      },
      {
        sourceId: 'ha-lake:persistent:old-notice',
        resolved: true,
        verified: true,
        reason: 'not_in_source',
      },
      {
        sourceId: 'ha-lake:repair:mqtt:offline',
        resolved: false,
        verified: false,
      },
    ]);
    expect(connector.getNotificationSourceHealth()).toEqual([
      { sourceId: 'entity-alerts', status: 'disabled' },
      { sourceId: 'updates', status: 'ok' },
      { sourceId: 'persistent-notifications', status: 'ok' },
      { sourceId: 'repairs', status: 'failed', error: 'Repairs unavailable' },
    ]);
  });

  it('preserves an existing update while Home Assistant reports it unavailable', async () => {
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchStates: async () => [{
          entity_id: 'update.router',
          state: 'unavailable',
          attributes: {
            latest_version: '1.1',
          },
        }],
        fetchWebSocketSources: async () => ({
          persistentNotifications: [],
          repairs: [],
          errors: {},
        }),
      },
    });

    await expect(connector.fetchNotifications()).resolves.toEqual([]);
    await expect(connector.reconcileAlerts([
      'ha-lake:update:update.router:1.1',
    ])).resolves.toEqual([{
      sourceId: 'ha-lake:update:update.router:1.1',
      resolved: false,
      verified: false,
    }]);
  });

  it('resolves notifications after their Home Assistant source is disabled', async () => {
    const connector = new HomeAssistantConnector();
    await connector.initialize({
      ...config,
      settings: {
        ...config.settings,
        sources: {
          entityAlerts: { enabled: false },
          updates: { enabled: false, criticalEntityPatterns: [] },
          persistentNotifications: {
            enabled: false,
            criticalNotificationPatterns: [],
          },
          repairs: { enabled: false },
        },
      },
    });

    await expect(connector.fetchNotifications()).resolves.toEqual([]);
    expect(connector.reconcileAlertsBatchSize).toBeNull();
    await expect(connector.reconcileAlerts([
      'ha-lake:update:update.router:1.1',
      'ha-lake:persistent:notice',
      'ha-lake:repair:mqtt:offline',
      'ha-lake:rule:door-open:binary_sensor.garage',
    ])).resolves.toEqual([
      expect.objectContaining({ resolved: true, reason: 'source_disabled' }),
      expect.objectContaining({ resolved: true, reason: 'source_disabled' }),
      expect.objectContaining({ resolved: true, reason: 'source_disabled' }),
      expect.objectContaining({ resolved: true, reason: 'source_disabled' }),
    ]);
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

  it('skips an available update through the update service', async () => {
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
            supported_features: 1,
            auto_update: false,
          },
        }],
        callService: async (domain: string, service: string, data: Record<string, unknown>) => {
          calls.push({ domain, service, data });
        },
      },
    });

    await connector.executeNotificationAction(
      'skip_update',
      { entityId: 'update.router', latestVersion: '1.1', canSkip: true },
      {},
    );

    expect(calls).toEqual([{
      domain: 'update',
      service: 'skip',
      data: { entity_id: 'update.router' },
    }]);
  });

  it('dismisses an active persistent notification through the persistent notification service', async () => {
    const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchWebSocketSources: async () => ({
          persistentNotifications: [{ notification_id: 'water_filter' }],
          errors: {},
        }),
        callService: async (domain: string, service: string, data: Record<string, unknown>) => {
          calls.push({ domain, service, data });
        },
      },
    });

    await connector.executeNotificationAction(
      'dismiss_persistent_notification',
      { notificationId: 'water_filter' },
      {},
    );

    expect(calls).toEqual([{
      domain: 'persistent_notification',
      service: 'dismiss',
      data: { notification_id: 'water_filter' },
    }]);
  });

  it('ignores an active repair through the repairs WebSocket API', async () => {
    const calls: Array<{ domain: string; issueId: string }> = [];
    const connector = new HomeAssistantConnector();
    await connector.initialize(config);
    Object.assign(connector, {
      client: {
        fetchWebSocketSources: async () => ({
          repairs: [{ domain: 'mqtt', issue_id: 'broker_unavailable', ignored: false }],
          errors: {},
        }),
        ignoreRepair: async (domain: string, issueId: string) => {
          calls.push({ domain, issueId });
        },
      },
    });

    await connector.executeNotificationAction(
      'ignore_repair',
      { domain: 'mqtt', issueId: 'broker_unavailable' },
      {},
    );

    expect(calls).toEqual([{ domain: 'mqtt', issueId: 'broker_unavailable' }]);
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
