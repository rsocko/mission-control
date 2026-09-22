import { isDatabaseContentionError } from '@/db/contention';
import { isRetryablePostgresError } from '@/db/postgres/errors';
import { initializeRuntimeDatabase } from '@/db/runtime';
import { dbLogger } from '@/lib/logger';
import '@/lib/connectors';
import '@/lib/semantic-index/publication';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;

export interface DatabaseStartupOptions<T> {
  initialize?: () => T | Promise<T>;
  maxAttempts?: number;
  retryBaseMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isRetryableDatabaseStartupError(error: unknown): boolean {
  return isDatabaseContentionError(error) || isRetryablePostgresError(error);
}

export async function initializeDatabaseWithRetry<T = void>(
  options: DatabaseStartupOptions<T> = {},
): Promise<T> {
  const initialize = options.initialize ?? (initializeRuntimeDatabase as () => Promise<T>);
  const maxAttempts = options.maxAttempts ?? positiveInteger(
    process.env.MC_DB_STARTUP_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
  );
  const retryBaseMs = options.retryBaseMs ?? positiveInteger(
    process.env.MC_DB_STARTUP_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
  );
  const sleep = options.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await initialize();
      if (attempt > 1) {
        dbLogger.info({ attempt }, 'Database startup initialization recovered');
      }
      return result;
    } catch (error) {
      if (!isRetryableDatabaseStartupError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = Math.min(
        retryBaseMs * (2 ** (attempt - 1)),
        MAX_RETRY_DELAY_MS,
      );
      dbLogger.warn(
        { err: error, attempt, maxAttempts, delayMs },
        'Database startup initialization is locked; retrying',
      );
      await sleep(delayMs);
    }
  }

  // Unreachable in practice (the loop always returns or throws for
  // maxAttempts >= 1), but TypeScript's control-flow analysis can't prove
  // that, and a non-positive maxAttempts would otherwise fall through
  // without a value.
  throw new Error('Database startup initialization failed: no attempts were made');
}
