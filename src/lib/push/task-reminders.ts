import 'server-only';

import type {
  TaskReminderDeliveryContext,
  TaskReminderRepository,
} from '@/db/persistence/task-reminders';
import { getTimezone } from '@/lib/mode';
import { wakeNotificationDeliveryDispatcher } from '@/lib/notifications/dispatcher-wake';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import { getApnsConfiguration } from './apns-config';
import logger from '@/lib/logger';

export const TASK_REMINDER_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const TASK_REMINDER_MAX_ATTEMPTS = 5;
export const DEFAULT_TASK_REMINDER_BATCH_SIZE = 100;
export const MAX_TASK_REMINDER_BATCH_SIZE = 500;
export const MAX_TASK_REMINDER_RETRY_DELAY_MS = 15 * 60 * 1_000;

export interface TaskReminderRunResult {
  examined: number;
  claimed: number;
  fired: number;
  cancelled: number;
  failed: number;
}

export interface RunDueTaskRemindersOptions {
  now?: Date;
  batchSize?: number;
  repository?: TaskReminderRepository;
  delivery?: TaskReminderDeliveryContext;
}

export function calculateTaskReminderRetryDelayMs(attemptCount: number): number {
  return Math.min(
    2 ** Math.max(0, attemptCount - 1) * 60 * 1_000,
    MAX_TASK_REMINDER_RETRY_DELAY_MS,
  );
}

function getCurrentHour(now: Date, timezone: string): number {
  return Number.parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now), 10);
}

function configuredGlobalLimit(): number {
  const configured = Number.parseInt(process.env.PUSH_GLOBAL_MAX_PER_HOUR ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 100;
}

function resolveDeliveryContext(now: Date): TaskReminderDeliveryContext {
  let apns: TaskReminderDeliveryContext['apns'] = null;
  try {
    const configuration = getApnsConfiguration();
    apns = {
      environment: configuration.environment,
      topic: configuration.topic,
    };
  } catch {
    // Missing APNs configuration is recorded as a durable channel suppression.
  }
  return {
    currentHour: getCurrentHour(now, getTimezone()),
    webPushConfigured: Boolean(
      process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
    ),
    apns,
    globalMaxPerHour: configuredGlobalLimit(),
  };
}

async function resolveRepository(
  repository?: TaskReminderRepository,
): Promise<TaskReminderRepository> {
  return repository ?? (await getWorkerPersistenceRepositories()).reminders;
}

export async function runDueTaskReminders(
  options: RunDueTaskRemindersOptions = {},
): Promise<TaskReminderRunResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(
    1,
    Math.min(
      Math.floor(options.batchSize ?? DEFAULT_TASK_REMINDER_BATCH_SIZE),
      MAX_TASK_REMINDER_BATCH_SIZE,
    ),
  );
  const repository = await resolveRepository(options.repository);
  const delivery = options.delivery ?? resolveDeliveryContext(now);
  const result: TaskReminderRunResult = {
    examined: 0,
    claimed: 0,
    fired: 0,
    cancelled: 0,
    failed: 0,
  };

  result.cancelled = await repository.cancelInvalidated({ now, limit: batchSize });
  result.failed = await repository.recordInvalidTimestamps({
    now,
    limit: batchSize,
    maxAttempts: TASK_REMINDER_MAX_ATTEMPTS,
  });

  while (result.examined < batchSize) {
    const claim = await repository.claimNext({
      now,
      leaseMs: TASK_REMINDER_CLAIM_LEASE_MS,
      maxAttempts: TASK_REMINDER_MAX_ATTEMPTS,
    });
    if (!claim) break;
    result.examined += 1;
    result.claimed += 1;

    try {
      const fired = await repository.fire(claim, { now, delivery });
      if (fired.outcome === 'fired') {
        result.fired += 1;
        if (fired.pendingDelivery) wakeNotificationDeliveryDispatcher();
      } else if (fired.outcome === 'cancelled') {
        result.cancelled += 1;
      } else {
        result.failed += 1;
        logger.warn(
          { taskId: claim.taskId, occurrenceId: claim.id },
          'Task reminder finalization rejected after claim ownership changed',
        );
      }
    } catch {
      const exhausted = claim.attemptCount >= TASK_REMINDER_MAX_ATTEMPTS;
      const nextAttemptAt = exhausted
        ? null
        : new Date(
            now.getTime() + calculateTaskReminderRetryDelayMs(claim.attemptCount),
          ).toISOString();
      const retained = await repository.fail(claim, {
        now,
        nextAttemptAt,
        lastError: exhausted ? 'retry_limit_exhausted' : 'task_reminder_delivery_failed',
      });
      result.failed += 1;
      if (retained) {
        logger.error(
          { taskId: claim.taskId, occurrenceId: claim.id },
          'Task reminder delivery failed',
        );
      } else {
        logger.warn(
          { taskId: claim.taskId, occurrenceId: claim.id },
          'Task reminder failure rejected after claim ownership changed',
        );
      }
    }
  }

  return result;
}
