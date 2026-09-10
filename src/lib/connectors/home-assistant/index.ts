import type { ConnectorFactory, IConnector } from '../index';
import type {
  InboundNotification,
  ConnectorCapabilities,
  ConnectorConfig,
  SourceList,
  TaskItem,
} from '@/types';

import { createHAClient } from './ha-client';
import type { HAClient } from './ha-client';
import {
  matchesPatterns,
  matchPattern,
  evaluateCondition,
  buildRuleNotification,
  checkPackages,
} from './entity-transformer';
import {
  DEFAULT_HOME_ASSISTANT_SETTINGS,
  normalizeHomeAssistantSettings,
  readHomeAssistantCredentials,
} from './settings';
import type { HomeAssistantSettings } from './settings';
import type { ConnectorNotificationTypeDefinition } from '@/lib/notifications/push-policy/catalog';
import {
  buildPersistentNotifications,
  buildRepairNotifications,
  buildUpdateNotifications,
} from './source-transformers';

export type { AlertRule } from './entity-transformer';
export type { HomeAssistantState } from './ha-client';
export {
  DEFAULT_HOME_ASSISTANT_ALERT_RULES as DEFAULT_ALERT_RULES,
  DEFAULT_HOME_ASSISTANT_SETTINGS,
  normalizeHomeAssistantSettings,
} from './settings';
export type {
  HomeAssistantCredentials,
  HomeAssistantSettings,
} from './settings';

export type HomeAssistantNotificationAction =
  | 'install_update'
  | 'skip_update'
  | 'dismiss_persistent_notification'
  | 'ignore_repair';

export class HomeAssistantActionError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 503,
  ) {
    super(message);
    this.name = 'HomeAssistantActionError';
  }
}

function notificationTypeCatalog(
  settings: HomeAssistantSettings,
): readonly ConnectorNotificationTypeDefinition[] {
  return [
      {
        key: 'home_assistant_entity_alert',
        label: 'Device alert',
        description: 'A Home Assistant entity matched an alert rule.',
        defaultLevel: 'heads_up',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.immediateUrgentEntityAlerts ? 'urgent_only' : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_update_available',
        label: 'Update available',
        description: 'A Home Assistant update is available.',
        defaultLevel: 'heads_up',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.updatePush === 'immediate'
          ? 'heads_up_or_higher'
          : settings.outboundDelivery.immediateCriticalUpdates
            ? 'urgent_only'
            : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_update_critical',
        label: 'Critical update available',
        description: 'An explicitly configured critical Home Assistant update is available.',
        defaultLevel: 'action_needed',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.immediateCriticalUpdates
          ? 'action_needed_or_higher'
          : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_persistent_notification',
        label: 'Persistent notification',
        description: 'Home Assistant created a persistent notification.',
        defaultLevel: 'heads_up',
        pushEligible: true,
        pushRecommendation: 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_persistent_critical',
        label: 'Critical persistent notification',
        description: 'Home Assistant created an explicitly configured critical persistent notification.',
        defaultLevel: 'action_needed',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.immediateCriticalPersistentNotifications
          ? 'action_needed_or_higher'
          : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_repair_warning',
        label: 'Repair warning',
        description: 'Home Assistant reported a repair warning.',
        defaultLevel: 'heads_up',
        pushEligible: true,
        pushRecommendation: 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_repair_error',
        label: 'Repair error',
        description: 'Home Assistant reported a repair error.',
        defaultLevel: 'action_needed',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.immediateActionNeededRepairs
          ? 'action_needed_or_higher'
          : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
      {
        key: 'ha_repair_critical',
        label: 'Critical repair issue',
        description: 'Home Assistant reported a critical repair issue.',
        defaultLevel: 'urgent',
        pushEligible: true,
        pushRecommendation: settings.outboundDelivery.immediateActionNeededRepairs
          ? 'action_needed_or_higher'
          : 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_and_body',
      },
  ];
}

export class HomeAssistantConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'home-assistant';
  readonly displayName = 'Home Assistant';
  readonly icon = '🏠';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: false,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: false,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable',
    notificationOnly: true,
  };

  private config: ConnectorConfig | null = null;
  private settings: HomeAssistantSettings = DEFAULT_HOME_ASSISTANT_SETTINGS;
  private accessToken = '';
  private client: HAClient | null = null;
  private lastActiveNotificationIds: string[] | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;

    const rawSettings = typeof config.settings === 'string'
      ? JSON.parse(config.settings)
      : (config.settings as Record<string, unknown> | null) || {};

    const envPatterns = process.env.HOME_ASSISTANT_ENTITIES
      ?.split(',')
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    this.settings = normalizeHomeAssistantSettings({
      ...rawSettings,
      baseUrl: this.readString(rawSettings.baseUrl)
        || config.credentials.baseUrl
        || process.env.HOME_ASSISTANT_URL
        || DEFAULT_HOME_ASSISTANT_SETTINGS.baseUrl,
      ...(rawSettings.entityPatterns === undefined && envPatterns
        ? { entityPatterns: envPatterns }
        : {}),
    });
    this.accessToken = readHomeAssistantCredentials(config.credentials, rawSettings).accessToken;

    this.client = createHAClient({
      baseUrl: this.settings.baseUrl,
      accessToken: this.accessToken,
    });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    const result = await this.client!.testConnection();
    if (result.ok) {
      return { success: true, message: `Connected (${result.serviceCount} service domains)` };
    }
    if (result.status) {
      return { success: false, message: `HTTP ${result.status}` };
    }
    return { success: false, message: `Connection failed: ${result.error}` };
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.client = null;
    this.accessToken = '';
    this.lastActiveNotificationIds = null;
  }

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    void since;
    const notifications: InboundNotification[] = [];
    let failedSourceCount = 0;
    const failures: Error[] = [];
    const needsStates = this.settings.sources.entityAlerts.enabled || this.settings.sources.updates.enabled;

    if (needsStates) {
      try {
        const states = await this.client!.fetchStates();
        if (this.settings.sources.entityAlerts.enabled) {
          const matching = states.filter((state) => matchesPatterns(state.entity_id, this.settings.entityPatterns));
          for (const rule of this.settings.alertRules) {
            const entities = matching.filter((state) => matchPattern(state.entity_id, rule.entityPattern));
            for (const entity of entities) {
              if (evaluateCondition(entity, rule)) {
                const notification = buildRuleNotification(entity, rule, this.type, this.id);
                const entityDomain = entity.entity_id.split('.', 1)[0];
                notification.templateKey = 'home_assistant_entity_alert';
                notification.actionUrl = `${this.settings.baseUrl}/config/entities?domain=${encodeURIComponent(entityDomain)}`;
                notification.metadata = {
                  ...notification.metadata,
                  schemaVersion: 2,
                  haSource: 'entity_alerts',
                  instanceName: this.config?.name || this.displayName,
                  baseUrl: this.settings.baseUrl,
                  pushDelivery: rule.level === 'urgent'
                    && this.settings.outboundDelivery.immediateUrgentEntityAlerts
                    ? 'immediate'
                    : 'default',
                };
                notifications.push(notification);
              }
            }
          }
          notifications.push(...checkPackages(matching, undefined, this.type, this.id).map(notification => ({
            ...notification,
            templateKey: 'home_assistant_entity_alert',
            actionUrl: `${this.settings.baseUrl}/config/entities?domain=${encodeURIComponent(notification.sourceId.split('.', 1)[0])}`,
            metadata: {
              ...notification.metadata,
              schemaVersion: 2,
              haSource: 'entity_alerts',
              instanceName: this.config?.name || this.displayName,
              baseUrl: this.settings.baseUrl,
              pushDelivery: 'default',
            },
          })));
        }
        if (this.settings.sources.updates.enabled) {
          notifications.push(...buildUpdateNotifications({
            states,
            connectorType: this.type,
            connectorInstanceId: this.id,
            instanceName: this.config?.name || this.displayName,
            baseUrl: this.settings.baseUrl,
            actionsEnabled: this.settings.actions.enabled,
            criticalEntityPatterns: this.settings.sources.updates.criticalEntityPatterns,
            updatePush: this.settings.outboundDelivery.updatePush,
            immediateCriticalUpdates: this.settings.outboundDelivery.immediateCriticalUpdates,
          }));
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        failedSourceCount += Number(this.settings.sources.entityAlerts.enabled)
          + Number(this.settings.sources.updates.enabled);
      }
    }

    const websocketSources = [
      ...(this.settings.sources.persistentNotifications.enabled
        ? ['persistentNotifications' as const]
        : []),
      ...(this.settings.sources.repairs.enabled ? ['repairs' as const] : []),
    ];
    if (websocketSources.length > 0) {
      try {
        const result = await this.client!.fetchWebSocketSources(websocketSources);
        if (result.persistentNotifications) {
          notifications.push(...buildPersistentNotifications({
            items: result.persistentNotifications,
            connectorType: this.type,
            connectorInstanceId: this.id,
            instanceName: this.config?.name || this.displayName,
            baseUrl: this.settings.baseUrl,
            actionsEnabled: this.settings.actions.enabled,
            criticalNotificationPatterns:
              this.settings.sources.persistentNotifications.criticalNotificationPatterns,
            immediateCritical:
              this.settings.outboundDelivery.immediateCriticalPersistentNotifications,
          }));
        }
        if (result.repairs) {
          notifications.push(...buildRepairNotifications({
            issues: result.repairs,
            connectorType: this.type,
            connectorInstanceId: this.id,
            instanceName: this.config?.name || this.displayName,
            baseUrl: this.settings.baseUrl,
            actionsEnabled: this.settings.actions.enabled,
            immediateActionNeeded:
              this.settings.outboundDelivery.immediateActionNeededRepairs,
          }));
        }
        for (const error of Object.values(result.errors)) {
          failures.push(new Error(error));
          failedSourceCount += 1;
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        failedSourceCount += websocketSources.length;
      }
    }

    const sourceCount =
      Number(this.settings.sources.entityAlerts.enabled)
      + Number(this.settings.sources.updates.enabled)
      + websocketSources.length;
    if (sourceCount > 0 && failedSourceCount >= sourceCount) {
      this.lastActiveNotificationIds = null;
      throw new AggregateError(failures, 'All enabled Home Assistant sources failed');
    }
    this.lastActiveNotificationIds = failedSourceCount === 0
      ? notifications.map(notification => notification.id)
      : null;
    return notifications;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    const now = new Date().toISOString();
    const lists: SourceList[] = [];
    if (this.settings.sources.entityAlerts.enabled) {
      lists.push({ id: `${this.id}:entity-alerts`, connectorInstanceId: this.id, sourceId: 'entity-alerts', name: 'Device Alerts', type: 'folder', taskCount: 0, lastSyncedAt: now });
    }
    if (this.settings.sources.updates.enabled) {
      lists.push({ id: `${this.id}:updates`, connectorInstanceId: this.id, sourceId: 'updates', name: 'Updates', type: 'folder', taskCount: 0, lastSyncedAt: now });
    }
    if (this.settings.sources.persistentNotifications.enabled) {
      lists.push({ id: `${this.id}:persistent-notifications`, connectorInstanceId: this.id, sourceId: 'persistent-notifications', name: 'Persistent Notifications', type: 'folder', taskCount: 0, lastSyncedAt: now });
    }
    if (this.settings.sources.repairs.enabled) {
      lists.push({ id: `${this.id}:repairs`, connectorInstanceId: this.id, sourceId: 'repairs', name: 'Repairs', type: 'folder', taskCount: 0, lastSyncedAt: now });
    }
    return lists;
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  /**
   * "Clear and refresh": re-evaluate all alert rules against current state.
   * If a condition no longer triggers (e.g. door is closed), the alert
   * won't be in this set and the sync engine will auto-resolve it.
   */
  async getActiveAlertSourceIds(since?: Date): Promise<string[] | null> {
    void since;
    return this.lastActiveNotificationIds;
  }

  async executeNotificationAction(
    action: HomeAssistantNotificationAction,
    metadata: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!this.settings.actions.enabled) {
      throw new HomeAssistantActionError('Home Assistant actions are disabled for this connector', 409);
    }

    try {
      if (action === 'install_update' || action === 'skip_update') {
        const entityId = typeof metadata.entityId === 'string' ? metadata.entityId : '';
        if (!entityId.startsWith('update.')) {
          throw new HomeAssistantActionError('The stored update target is invalid', 409);
        }
        const entity = (await this.client!.fetchStates()).find(state => state.entity_id === entityId);
        if (!entity || (entity.state !== 'on' && entity.state !== 'in_progress')) {
          throw new HomeAssistantActionError('This update is no longer available in Home Assistant', 409);
        }
        const attributes = entity.attributes ?? {};
        if (attributes.in_progress === true || entity.state === 'in_progress') {
          throw new HomeAssistantActionError('This update is already being installed', 409);
        }
        const storedVersion = typeof metadata.latestVersion === 'string'
          ? metadata.latestVersion
          : '';
        const currentVersion = typeof attributes.latest_version === 'string'
          ? attributes.latest_version
          : '';
        if (storedVersion && currentVersion !== storedVersion) {
          throw new HomeAssistantActionError(
            'The available update changed. Refresh notifications before taking action',
            409,
          );
        }
        const supportedFeatures = typeof attributes.supported_features === 'number'
          ? attributes.supported_features
          : 0;
        if (action === 'skip_update') {
          if (metadata.canSkip !== true || attributes.auto_update === true) {
            throw new HomeAssistantActionError('This update cannot be skipped', 409);
          }
          await this.client!.callService('update', 'skip', { entity_id: entityId });
          return;
        }

        const serviceData: Record<string, unknown> = { entity_id: entityId };
        if ((supportedFeatures & 1) === 0) {
          throw new HomeAssistantActionError('This update cannot be installed from Mission Control', 409);
        }
        if (input.createBackup === true) {
          if (metadata.supportsBackup !== true || (supportedFeatures & 8) === 0) {
            throw new HomeAssistantActionError('Backup before update is not supported for this item', 409);
          }
          serviceData.backup = true;
        }
        await this.client!.callService('update', 'install', serviceData);
        return;
      }

      if (action === 'dismiss_persistent_notification') {
        const notificationId = typeof metadata.notificationId === 'string' ? metadata.notificationId : '';
        if (!notificationId) {
          throw new HomeAssistantActionError('The stored notification target is invalid', 409);
        }
        const current = await this.client!.fetchWebSocketSources(['persistentNotifications']);
        if (!current.persistentNotifications?.some(item => item.notification_id === notificationId)) {
          throw new HomeAssistantActionError('This notification is no longer active in Home Assistant', 409);
        }
        await this.client!.callService('persistent_notification', 'dismiss', {
          notification_id: notificationId,
        });
        return;
      }

      const repairDomain = typeof metadata.domain === 'string' ? metadata.domain : '';
      const repairIssueId = typeof metadata.issueId === 'string' ? metadata.issueId : '';
      if (!repairDomain || !repairIssueId) {
        throw new HomeAssistantActionError('The stored repair target is invalid', 409);
      }
      const current = await this.client!.fetchWebSocketSources(['repairs']);
      if (!current.repairs?.some(issue => (
        issue.domain === repairDomain && issue.issue_id === repairIssueId && issue.ignored !== true
      ))) {
        throw new HomeAssistantActionError('This repair is no longer active in Home Assistant', 409);
      }
      await this.client!.ignoreRepair(repairDomain, repairIssueId);
    } catch (error) {
      if (error instanceof HomeAssistantActionError) throw error;
      throw new HomeAssistantActionError(
        error instanceof Error ? error.message : 'Home Assistant action failed',
        503,
      );
    }
  }

  // ─── Private: Config Parsing ────────────────────────────────────────────

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}

export const homeAssistantFactory: ConnectorFactory = {
  create: () => new HomeAssistantConnector(),
  getNotificationTypes(config) {
    return notificationTypeCatalog(normalizeHomeAssistantSettings(config.settings));
  },
};