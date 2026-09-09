import type { NotificationLevel } from '@/types';
import type { AlertRule } from './entity-transformer';

export const DEFAULT_HOME_ASSISTANT_URL = 'http://localhost:8123';
export const DEFAULT_HOME_ASSISTANT_ENTITY_PATTERNS = [
  'sensor.mail_*',
  'binary_sensor.*_door*',
  'sensor.*_battery',
];
export const DEFAULT_HOME_ASSISTANT_CRITICAL_UPDATE_PATTERNS = [
  'update.home_assistant_core_update',
  'update.home_assistant_supervisor_update',
  'update.home_assistant_operating_system_update',
];

export interface HomeAssistantSourceSettings {
  entityAlerts: { enabled: boolean };
  updates: {
    enabled: boolean;
    criticalEntityPatterns: string[];
  };
  persistentNotifications: {
    enabled: boolean;
    criticalNotificationPatterns: string[];
  };
  repairs: { enabled: boolean };
}

export interface HomeAssistantOutboundDeliverySettings {
  updatePush: 'immediate' | 'daily_summary' | 'off';
  dailySummaryTime: string;
  immediateCriticalUpdates: boolean;
  immediateActionNeededRepairs: boolean;
  immediateUrgentEntityAlerts: boolean;
  immediateCriticalPersistentNotifications: boolean;
}

export interface HomeAssistantSettings {
  settingsVersion: 2;
  baseUrl: string;
  entityPatterns: string[];
  alertRules: AlertRule[];
  sources: HomeAssistantSourceSettings;
  actions: { enabled: boolean };
  outboundDelivery: HomeAssistantOutboundDeliverySettings;
}

export interface HomeAssistantCredentials {
  accessToken: string;
}

export const DEFAULT_HOME_ASSISTANT_ALERT_RULES: AlertRule[] = [
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

export const DEFAULT_HOME_ASSISTANT_SETTINGS: HomeAssistantSettings = {
  settingsVersion: 2,
  baseUrl: DEFAULT_HOME_ASSISTANT_URL,
  entityPatterns: [...DEFAULT_HOME_ASSISTANT_ENTITY_PATTERNS],
  alertRules: [...DEFAULT_HOME_ASSISTANT_ALERT_RULES],
  sources: {
    entityAlerts: { enabled: true },
    updates: {
      enabled: true,
      criticalEntityPatterns: [...DEFAULT_HOME_ASSISTANT_CRITICAL_UPDATE_PATTERNS],
    },
    persistentNotifications: {
      enabled: true,
      criticalNotificationPatterns: [],
    },
    repairs: { enabled: true },
  },
  actions: { enabled: false },
  outboundDelivery: {
    updatePush: 'daily_summary',
    dailySummaryTime: '08:00',
    immediateCriticalUpdates: true,
    immediateActionNeededRepairs: true,
    immediateUrgentEntityAlerts: true,
    immediateCriticalPersistentNotifications: true,
  },
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.flatMap(item => (
    typeof item === 'string' && item.trim() ? [item.trim()] : []
  ));
}

function alertRules(value: unknown): AlertRule[] {
  if (!Array.isArray(value)) return [...DEFAULT_HOME_ASSISTANT_ALERT_RULES];
  const rules = value.flatMap((item): AlertRule[] => {
    const candidate = record(item);
    const condition = candidate.condition;
    const level = candidate.level;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.entityPattern !== 'string'
      || !['equals', 'above', 'below', 'changed'].includes(String(condition))
      || !['urgent', 'action_needed', 'heads_up', 'fyi', 'digest'].includes(String(level))
      || typeof candidate.category !== 'string'
      || typeof candidate.title !== 'string'
    ) {
      return [];
    }
    return [{
      id: candidate.id,
      entityPattern: candidate.entityPattern,
      condition: condition as AlertRule['condition'],
      ...(typeof candidate.value === 'string' ? { value: candidate.value } : {}),
      level: level as NotificationLevel,
      category: candidate.category,
      title: candidate.title,
      ...(typeof candidate.cooldownMinutes === 'number'
        ? { cooldownMinutes: candidate.cooldownMinutes }
        : {}),
    }];
  });
  return rules.length > 0 ? rules : [...DEFAULT_HOME_ASSISTANT_ALERT_RULES];
}

export function normalizeHomeAssistantBaseUrl(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_HOME_ASSISTANT_URL;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Home Assistant URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('Home Assistant URL cannot include credentials, query parameters, or a fragment');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function normalizeHomeAssistantSettings(value: unknown): HomeAssistantSettings {
  const raw = record(value);
  const sources = record(raw.sources);
  const updates = record(sources.updates);
  const persistent = record(sources.persistentNotifications);
  const actions = record(raw.actions);
  const outbound = record(raw.outboundDelivery);
  const legacyDigest = record(raw.updateDigest);
  const updatePush = ['immediate', 'daily_summary', 'off'].includes(String(outbound.updatePush))
    ? outbound.updatePush as HomeAssistantOutboundDeliverySettings['updatePush']
    : typeof legacyDigest.enabled === 'boolean'
      ? legacyDigest.enabled ? 'daily_summary' : 'off'
    : DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.updatePush;
  const dailySummaryTime = typeof outbound.dailySummaryTime === 'string'
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(outbound.dailySummaryTime)
    ? outbound.dailySummaryTime
    : typeof legacyDigest.time === 'string'
      && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(legacyDigest.time)
      ? legacyDigest.time
    : DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.dailySummaryTime;

  return {
    settingsVersion: 2,
    baseUrl: normalizeHomeAssistantBaseUrl(raw.baseUrl),
    entityPatterns: stringArray(raw.entityPatterns, DEFAULT_HOME_ASSISTANT_ENTITY_PATTERNS),
    alertRules: alertRules(raw.alertRules),
    sources: {
      entityAlerts: {
        enabled: booleanValue(
          record(sources.entityAlerts).enabled,
          DEFAULT_HOME_ASSISTANT_SETTINGS.sources.entityAlerts.enabled,
        ),
      },
      updates: {
        enabled: booleanValue(updates.enabled, DEFAULT_HOME_ASSISTANT_SETTINGS.sources.updates.enabled),
        criticalEntityPatterns: stringArray(
          updates.criticalEntityPatterns,
          DEFAULT_HOME_ASSISTANT_CRITICAL_UPDATE_PATTERNS,
        ),
      },
      persistentNotifications: {
        enabled: booleanValue(
          persistent.enabled,
          DEFAULT_HOME_ASSISTANT_SETTINGS.sources.persistentNotifications.enabled,
        ),
        criticalNotificationPatterns: stringArray(persistent.criticalNotificationPatterns, []),
      },
      repairs: {
        enabled: booleanValue(
          record(sources.repairs).enabled,
          DEFAULT_HOME_ASSISTANT_SETTINGS.sources.repairs.enabled,
        ),
      },
    },
    actions: {
      enabled: booleanValue(
        actions.enabled,
        booleanValue(raw.enableActions, DEFAULT_HOME_ASSISTANT_SETTINGS.actions.enabled),
      ),
    },
    outboundDelivery: {
      updatePush,
      dailySummaryTime,
      immediateCriticalUpdates: booleanValue(
        outbound.immediateCriticalUpdates,
        DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.immediateCriticalUpdates,
      ),
      immediateActionNeededRepairs: booleanValue(
        outbound.immediateActionNeededRepairs,
        DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.immediateActionNeededRepairs,
      ),
      immediateUrgentEntityAlerts: booleanValue(
        outbound.immediateUrgentEntityAlerts,
        DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.immediateUrgentEntityAlerts,
      ),
      immediateCriticalPersistentNotifications: booleanValue(
        outbound.immediateCriticalPersistentNotifications,
        DEFAULT_HOME_ASSISTANT_SETTINGS.outboundDelivery.immediateCriticalPersistentNotifications,
      ),
    },
  };
}

export function readHomeAssistantCredentials(
  credentials: unknown,
  legacySettings?: unknown,
): HomeAssistantCredentials {
  const stored = record(credentials);
  const legacy = record(legacySettings);
  const accessToken = [
    stored.accessToken,
    stored.token,
    legacy.accessToken,
    process.env.HOME_ASSISTANT_TOKEN,
  ].find(value => typeof value === 'string' && value.trim());
  return { accessToken: typeof accessToken === 'string' ? accessToken.trim() : '' };
}
