import type {
  AlertReconciliation,
  ConnectorFactory,
  IConnector,
  NotificationSourceHealth,
} from '../index';
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

type HomeAssistantSource =
  | 'entityAlerts'
  | 'updates'
  | 'persistentNotifications'
  | 'repairs';

type SourceReconciliationState = {
  status: 'ok' | 'disabled' | 'failed';
  activeIds: Set<string>;
  uncertainEntityIds?: Set<string>;
  error?: string;
};

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
  readonly reconcileAlertsBatchSize = null;
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
  private lastSourceReconciliation: Record<HomeAssistantSource, SourceReconciliationState> | null = null;

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
    this.lastSourceReconciliation = null;
  }

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    void since;
    const notifications: InboundNotification[] = [];
    let failedSourceCount = 0;
    const failures: Error[] = [];
    const reconciliation: Record<HomeAssistantSource, SourceReconciliationState> = {
      entityAlerts: {
        status: this.settings.sources.entityAlerts.enabled ? 'failed' : 'disabled',
        activeIds: new Set(),
      },
      updates: {
        status: this.settings.sources.updates.enabled ? 'failed' : 'disabled',
        activeIds: new Set(),
        uncertainEntityIds: new Set(),
      },
      persistentNotifications: {
        status: this.settings.sources.persistentNotifications.enabled ? 'failed' : 'disabled',
        activeIds: new Set(),
      },
      repairs: {
        status: this.settings.sources.repairs.enabled ? 'failed' : 'disabled',
        activeIds: new Set(),
      },
    };
    const needsStates = this.settings.sources.entityAlerts.enabled || this.settings.sources.updates.enabled;

    if (needsStates) {
      try {
        const states = await this.client!.fetchStates();
        if (this.settings.sources.entityAlerts.enabled) {
          reconciliation.entityAlerts.status = 'ok';
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
                reconciliation.entityAlerts.activeIds.add(notification.id);
              }
            }
          }
          const packageNotifications = checkPackages(matching, undefined, this.type, this.id).map(notification => ({
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
          }));
          notifications.push(...packageNotifications);
          packageNotifications.forEach(notification => {
            reconciliation.entityAlerts.activeIds.add(notification.id);
          });
        }
        if (this.settings.sources.updates.enabled) {
          reconciliation.updates.status = 'ok';
          states
            .filter(state => (
              state.entity_id.startsWith('update.')
              && (state.state === 'unknown' || state.state === 'unavailable')
            ))
            .forEach(state => reconciliation.updates.uncertainEntityIds?.add(state.entity_id));
          const updateNotifications = buildUpdateNotifications({
            states,
            connectorType: this.type,
            connectorInstanceId: this.id,
            instanceName: this.config?.name || this.displayName,
            baseUrl: this.settings.baseUrl,
            actionsEnabled: this.settings.actions.enabled,
            criticalEntityPatterns: this.settings.sources.updates.criticalEntityPatterns,
            updatePush: this.settings.outboundDelivery.updatePush,
            immediateCriticalUpdates: this.settings.outboundDelivery.immediateCriticalUpdates,
          });
          notifications.push(...updateNotifications);
          updateNotifications.forEach(notification => {
            reconciliation.updates.activeIds.add(notification.id);
          });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        if (this.settings.sources.entityAlerts.enabled) {
          reconciliation.entityAlerts.error = failure.message;
        }
        if (this.settings.sources.updates.enabled) {
          reconciliation.updates.error = failure.message;
        }
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
          reconciliation.persistentNotifications.status = 'ok';
          const persistentNotifications = buildPersistentNotifications({
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
          });
          notifications.push(...persistentNotifications);
          persistentNotifications.forEach(notification => {
            reconciliation.persistentNotifications.activeIds.add(notification.id);
          });
        }
        if (result.repairs) {
          reconciliation.repairs.status = 'ok';
          const repairNotifications = buildRepairNotifications({
            issues: result.repairs,
            connectorType: this.type,
            connectorInstanceId: this.id,
            instanceName: this.config?.name || this.displayName,
            baseUrl: this.settings.baseUrl,
            actionsEnabled: this.settings.actions.enabled,
            immediateActionNeeded:
              this.settings.outboundDelivery.immediateActionNeededRepairs,
          });
          notifications.push(...repairNotifications);
          repairNotifications.forEach(notification => {
            reconciliation.repairs.activeIds.add(notification.id);
          });
        }
        for (const error of Object.values(result.errors)) {
          failures.push(new Error(error));
          failedSourceCount += 1;
        }
        if (result.errors.persistentNotifications) {
          reconciliation.persistentNotifications.error = result.errors.persistentNotifications;
        }
        if (result.errors.repairs) {
          reconciliation.repairs.error = result.errors.repairs;
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        websocketSources.forEach(source => {
          reconciliation[source].error = failure.message;
        });
        failedSourceCount += websocketSources.length;
      }
    }

    const sourceCount =
      Number(this.settings.sources.entityAlerts.enabled)
      + Number(this.settings.sources.updates.enabled)
      + websocketSources.length;
    if (sourceCount > 0 && failedSourceCount >= sourceCount) {
      this.lastSourceReconciliation = reconciliation;
      throw new AggregateError(failures, 'All enabled Home Assistant sources failed');
    }
    this.lastSourceReconciliation = reconciliation;
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
    return null;
  }

  getNotificationSourceHealth(): NotificationSourceHealth[] {
    if (!this.lastSourceReconciliation) return [];
    const sourceIds: Record<HomeAssistantSource, string> = {
      entityAlerts: 'entity-alerts',
      updates: 'updates',
      persistentNotifications: 'persistent-notifications',
      repairs: 'repairs',
    };
    return (Object.keys(sourceIds) as HomeAssistantSource[]).map(source => ({
      sourceId: sourceIds[source],
      status: this.lastSourceReconciliation![source].status,
      ...(this.lastSourceReconciliation![source].error
        ? { error: this.lastSourceReconciliation![source].error }
        : {}),
    }));
  }

  async reconcileAlerts(sourceIds: string[]): Promise<AlertReconciliation[]> {
    const cycle = this.lastSourceReconciliation;
    if (!cycle) {
      return sourceIds.map(sourceId => ({ sourceId, resolved: false, verified: false }));
    }

    const connectorPrefix = `${this.id}:`;
    return sourceIds.map((sourceId): AlertReconciliation => {
      const localId = sourceId.startsWith(connectorPrefix)
        ? sourceId.slice(connectorPrefix.length)
        : sourceId;
      const source: HomeAssistantSource = localId.startsWith('update:')
        ? 'updates'
        : localId.startsWith('persistent:')
          ? 'persistentNotifications'
          : localId.startsWith('repair:')
            ? 'repairs'
            : 'entityAlerts';
      const state = cycle[source];

      if (state.status === 'failed') {
        return { sourceId, resolved: false, verified: false };
      }
      if (source === 'updates') {
        const encodedEntityId = localId.slice('update:'.length).split(':', 1)[0] ?? '';
        let entityId = encodedEntityId;
        try {
          entityId = decodeURIComponent(encodedEntityId);
        } catch {
          return { sourceId, resolved: false, verified: false };
        }
        if (state.uncertainEntityIds?.has(entityId)) {
          return { sourceId, resolved: false, verified: false };
        }
      }

      const resolved = state.status === 'disabled' || !state.activeIds.has(localId);
      return {
        sourceId,
        resolved,
        verified: true,
        ...(resolved ? { reason: state.status === 'disabled' ? 'source_disabled' : 'not_in_source' } : {}),
      };
    });
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