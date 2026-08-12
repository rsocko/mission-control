import type { Logger } from 'pino';

/**
 * Extract a human-readable message from any thrown value.
 * Replaces the repeated pattern: `err instanceof Error ? err.message : String(err)`
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Structured error logging helper.
 * Logs with a consistent shape: { err, ...context } + message.
 */
export function logError(
  log: Logger,
  err: unknown,
  context: Record<string, unknown>,
  message: string,
): void {
  log.error({ err, ...context }, message);
}

/**
 * Typed error for connector operations (auth failures, API errors, etc.).
 */
export class ConnectorError extends Error {
  public readonly code: string;
  public readonly connectorType?: string;
  public readonly connectorId?: string;
  public readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      code: string;
      connectorType?: string;
      connectorId?: string;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.code = opts.code;
    this.connectorType = opts.connectorType;
    this.connectorId = opts.connectorId;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Typed error for sync operations.
 */
export class SyncError extends Error {
  public readonly code: string;
  public readonly connectorId?: string;
  public readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      code: string;
      connectorId?: string;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'SyncError';
    this.code = opts.code;
    this.connectorId = opts.connectorId;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Determines whether an error is likely transient and worth retrying.
 * Covers network failures, rate limits, and known transient HTTP statuses.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ConnectorError || err instanceof SyncError) {
    return err.retryable;
  }

  const message = formatError(err).toLowerCase();

  // Network-level transient errors
  if (
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('abort')
  ) {
    return true;
  }

  // HTTP 429 / 5xx patterns
  if (message.includes('429') || message.includes('rate limit')) return true;
  if (/\b5\d{2}\b/.test(message)) return true;

  return false;
}
