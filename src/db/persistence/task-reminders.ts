export const TASK_REMINDER_SOURCE_PREFIX = 'task-reminder';
export const TASK_REMINDER_CONNECTOR_TYPE = 'system';
export const TASK_REMINDER_CONNECTOR_ID = 'push-triggers';
export const TASK_REMINDER_TEMPLATE_KEY = 'task_reminder';
export const TASK_REMINDER_OFFSET_TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$';

export interface ClaimedTaskReminder {
  id: string;
  taskId: string;
  scheduledAt: string;
  attemptCount: number;
  claimToken: string;
}

export interface TaskReminderDeliveryContext {
  currentHour: number;
  webPushConfigured: boolean;
  apns: {
    environment: 'development' | 'production';
    topic: string;
  } | null;
  globalMaxPerHour: number;
}

export interface TaskReminderFireResult {
  outcome: 'fired' | 'cancelled' | 'lost';
  pendingDelivery: boolean;
}

export interface TaskReminderRepository {
  cancelInvalidated(input: {
    now: Date;
    limit: number;
  }): Promise<number>;
  recordInvalidTimestamps(input: {
    now: Date;
    limit: number;
    maxAttempts: number;
  }): Promise<number>;
  claimNext(input: {
    now: Date;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedTaskReminder | null>;
  fail(
    claim: ClaimedTaskReminder,
    input: {
      now: Date;
      nextAttemptAt: string | null;
      lastError: string;
    },
  ): Promise<boolean>;
  fire(
    claim: ClaimedTaskReminder,
    input: {
      now: Date;
      delivery: TaskReminderDeliveryContext;
    },
  ): Promise<TaskReminderFireResult>;
}

export interface TaskReminderPushRule {
  templateKey: string;
  enabled: boolean;
  minLevel: string;
  preview: string;
  maxPerHour: number | null;
}

export interface TaskReminderDeliveryState {
  channelEnabled: boolean;
  doNotDisturb: boolean;
  quietHours: boolean;
  webPushSubscriptions: boolean;
  apnsRegistrations: boolean;
  globalActiveCount: number;
  ruleActiveCount: number;
}

export interface TaskReminderDeliveryPlan {
  channel: 'web_push' | 'apns';
  status: 'pending' | 'suppressed';
  suppressionReason: string | null;
  policySnapshot: Record<string, unknown>;
  payloadSnapshot: {
    notificationId: string;
    title: string;
    body?: string;
    tag: string;
    url: string;
    kind: 'task_reminder';
  };
}

const LEVEL_RANKS: Readonly<Record<string, number>> = {
  urgent: 0,
  action_needed: 1,
  heads_up: 2,
  fyi: 3,
  digest: 4,
};

export function isValidTaskReminderTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
    .exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function redactPushText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '******')
    .replace(
      /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
      'Authorization: [redacted]',
    )
    .replace(
      /["']?\b(access[_-]?token|api[_-]?key|password|secret|token|credential|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, maxLength);
}

export function createTaskReminderDeliveryPlans(input: {
  notificationId: string;
  title: string;
  body: string;
  navigationTarget: string;
  rule: TaskReminderPushRule | null;
  state: TaskReminderDeliveryState;
  context: TaskReminderDeliveryContext;
}): TaskReminderDeliveryPlan[] {
  const rule = input.rule ?? {
    templateKey: TASK_REMINDER_TEMPLATE_KEY,
    enabled: true,
    minLevel: 'heads_up',
    preview: 'title_and_body',
    maxPerHour: null,
  };
  const sourceDetail = input.rule
    ? (input.rule.templateKey === '*' ? 'wildcard' : 'exact')
    : 'recommended';
  const shouldPush = rule.enabled
    && (LEVEL_RANKS.heads_up ?? 2) <= (LEVEL_RANKS[rule.minLevel] ?? LEVEL_RANKS.digest);
  const payload = {
    notificationId: input.notificationId,
    title: redactPushText(input.title, 160),
    ...(rule.preview === 'title_and_body'
      ? { body: redactPushText(input.body, 512) }
      : {}),
    tag: `mc:${input.notificationId}`,
    url: input.navigationTarget,
    kind: 'task_reminder' as const,
  };

  return (['web_push', 'apns'] as const).map((channel) => {
    const channelConfigured = channel === 'web_push'
      ? input.context.webPushConfigured
      : input.context.apns !== null;
    const hasSubscriptions = channel === 'web_push'
      ? input.state.webPushSubscriptions
      : input.state.apnsRegistrations;
    const gates = {
      channelEnabled: input.state.channelEnabled,
      channelConfigured,
      dnd: input.state.doNotDisturb,
      quietHours: input.state.quietHours,
      hasSubscriptions,
    };
    const suppressionReason = !input.state.channelEnabled
      ? 'channel_disabled'
      : !channelConfigured
        ? 'channel_unconfigured'
        : input.state.doNotDisturb
          ? 'dnd'
          : input.state.quietHours
            ? 'quiet_hours'
            : !rule.enabled
              ? 'rule_disabled'
              : !shouldPush
                ? 'below_minimum_level'
                : !hasSubscriptions
                  ? 'no_subscription'
                  : input.state.globalActiveCount >= input.context.globalMaxPerHour
                    ? 'rate_limited'
                    : rule.maxPerHour !== null
                      && input.state.ruleActiveCount >= rule.maxPerHour
                      ? 'rate_limited'
                      : null;
    const status = suppressionReason ? 'suppressed' as const : 'pending' as const;
    return {
      channel,
      status,
      suppressionReason,
      policySnapshot: {
        version: 1,
        channel,
        connectorType: TASK_REMINDER_CONNECTOR_TYPE,
        connectorInstanceId: TASK_REMINDER_CONNECTOR_ID,
        templateKey: TASK_REMINDER_TEMPLATE_KEY,
        source: input.rule ? 'user' : 'connector',
        sourceDetail,
        minLevel: rule.minLevel,
        preview: rule.preview,
        maxPerHour: rule.maxPerHour,
        gates,
        decision: status,
        suppressionReason,
      },
      payloadSnapshot: payload,
    };
  });
}
