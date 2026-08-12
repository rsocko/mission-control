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
import type { AlertRule } from './entity-transformer';

export type { AlertRule } from './entity-transformer';
export type { HomeAssistantState } from './ha-client';

export interface HomeAssistantConfig {
  baseUrl: string;
  accessToken: string;
  entityPatterns: string[];
  alertRules: AlertRule[];
}

const DEFAULT_HOME_ASSISTANT_URL = 'http://localhost:8123';
const DEFAULT_ENTITY_PATTERNS = [
  'sensor.mail_*',
  'binary_sensor.*_door*',
  'sensor.*_battery',
];

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: 'door-open',
    entityPattern: 'binary_sensor.*_door*',
    condition: 'equals',
    value: 'on',
    level: 'action_needed',
    category: 'security',
    title: '{{friendly_name}} left open',
    cooldownMinutes: 30,
  },
  {
    id: 'low-battery',
    entityPattern: 'sensor.*_battery',
    condition: 'below',
    value: '20',
    level: 'heads_up',
    category: 'device',
    title: '{{friendly_name}} low battery ({{state}}%)',
    cooldownMinutes: 1440,
  },
  {
    id: 'motion',
    entityPattern: 'binary_sensor.*_motion*',
    condition: 'equals',
    value: 'on',
    level: 'fyi',
    category: 'security',
    title: 'Motion detected: {{friendly_name}}',
    cooldownMinutes: 60,
  },
  {
    id: 'device-offline',
    entityPattern: 'binary_sensor.*_status*',
    condition: 'equals',
    value: 'off',
    level: 'heads_up',
    category: 'device',
    title: '{{friendly_name}} offline',
    cooldownMinutes: 60,
  },
];

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
  private settings: HomeAssistantConfig = {
    baseUrl: DEFAULT_HOME_ASSISTANT_URL,
    accessToken: '',
    entityPatterns: [...DEFAULT_ENTITY_PATTERNS],
    alertRules: [...DEFAULT_ALERT_RULES],
  };
  private client: HAClient | null = null;

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

    this.settings = {
      baseUrl: this.normalizeBaseUrl(
        this.readString(rawSettings.baseUrl) ||
        config.credentials.baseUrl ||
        process.env.HOME_ASSISTANT_URL ||
        DEFAULT_HOME_ASSISTANT_URL
      ),
      accessToken:
        config.credentials.accessToken ||
        config.credentials.token ||
        this.readString(rawSettings.accessToken) ||
        process.env.HOME_ASSISTANT_TOKEN ||
        '',
      entityPatterns: this.readStringArray(rawSettings.entityPatterns) || envPatterns || [...DEFAULT_ENTITY_PATTERNS],
      alertRules: this.readAlertRules(rawSettings.alertRules) || [...DEFAULT_ALERT_RULES],
    };

    this.client = createHAClient({
      baseUrl: this.settings.baseUrl,
      accessToken: this.settings.accessToken,
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
  }

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    const notifications: InboundNotification[] = [];
    const states = await this.client!.fetchStates();
    const matching = states.filter((state) => matchesPatterns(state.entity_id, this.settings.entityPatterns));

    for (const rule of this.settings.alertRules) {
      const entities = matching.filter((state) => matchPattern(state.entity_id, rule.entityPattern));

      for (const entity of entities) {
        if (evaluateCondition(entity, rule, since)) {
          notifications.push(buildRuleNotification(entity, rule, this.type, this.id));
        }
      }
    }

    notifications.push(...checkPackages(matching, since, this.type, this.id));
    return notifications;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    const now = new Date().toISOString();
    return [
      { id: `${this.id}:packages`, connectorInstanceId: this.id, sourceId: 'packages', name: 'Package Tracking', type: 'folder', taskCount: 0, lastSyncedAt: now },
      { id: `${this.id}:security`, connectorInstanceId: this.id, sourceId: 'security', name: 'Security Sensors', type: 'folder', taskCount: 0, lastSyncedAt: now },
      { id: `${this.id}:devices`, connectorInstanceId: this.id, sourceId: 'devices', name: 'Device Status', type: 'folder', taskCount: 0, lastSyncedAt: now },
      { id: `${this.id}:environment`, connectorInstanceId: this.id, sourceId: 'environment', name: 'Environment', type: 'folder', taskCount: 0, lastSyncedAt: now },
    ];
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
    try {
      const notifications = await this.fetchNotifications(since);
      return notifications.map((notification) => notification.id);
    } catch {
      return null; // Fail-open: can't reach HA, don't resolve anything
    }
  }

  // ─── Private: Config Parsing ────────────────────────────────────────────

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/, '');
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const result = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return result.length > 0 ? result : null;
  }

  private readAlertRules(value: unknown): AlertRule[] | null {
    if (!Array.isArray(value)) return null;

    const rules = value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rule = item as Partial<AlertRule>;
      if (!rule.id || !rule.entityPattern || !rule.condition || !rule.level || !rule.category || !rule.title) {
        return [];
      }
      return [{
        id: rule.id,
        entityPattern: rule.entityPattern,
        condition: rule.condition,
        value: rule.value,
        level: rule.level,
        category: rule.category,
        title: rule.title,
        cooldownMinutes: rule.cooldownMinutes,
      }];
    });

    return rules.length > 0 ? rules : null;
  }
}

export const homeAssistantFactory: ConnectorFactory = {
  create: () => new HomeAssistantConnector(),
};