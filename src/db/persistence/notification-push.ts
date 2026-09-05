export const DEFAULT_NOTIFICATION_PUSH_PREFERENCES = {
  morningEnabled: true,
  morningHour: 8,
  triageNudgeEnabled: true,
  triageNudgeThreshold: 5,
  carryForwardEnabled: true,
  carryForwardHour: 18,
  quietStart: null,
  quietEnd: null,
  doNotDisturb: false,
} as const satisfies NotificationPushPreferences;

export interface NotificationPushPreferences {
  morningEnabled: boolean;
  morningHour: number;
  triageNudgeEnabled: boolean;
  triageNudgeThreshold: number;
  carryForwardEnabled: boolean;
  carryForwardHour: number;
  quietStart: number | null;
  quietEnd: number | null;
  doNotDisturb: boolean;
}

export interface SaveNotificationPushPreferencesInput {
  preferences: NotificationPushPreferences;
  pushDeliveryEnabled?: boolean;
  updatedAt: string;
}

export interface NotificationPushPersistence {
  getPreferences(): Promise<NotificationPushPreferences>;
  getPushDeliveryEnabled(): Promise<boolean>;
  savePreferences(input: SaveNotificationPushPreferencesInput): Promise<void>;
  getScheduledSummariesEnabled(): Promise<boolean>;
  setScheduledSummariesEnabled(enabled: boolean, updatedAt: string): Promise<void>;
  listActiveCalendarAccessTokens(): Promise<string[]>;
}

export function parseStoredBooleanSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === true;
}

export function extractAccessToken(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const credentials = value as Record<string, unknown>;
  const token = credentials.accessToken ?? credentials.access_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}
