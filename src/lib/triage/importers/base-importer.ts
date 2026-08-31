/**
 * Shared importer utilities: rate-limited fetch, types, and constants.
 */
import logger from '@/lib/logger';

export const IMPORT_USER_AGENT = 'mission-control-triage-importer/1.0';
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Fetch with automatic rate-limit retry. On 429, waits for Retry-After
 * header (or exponential backoff) and retries up to MAX_RATE_LIMIT_RETRIES times.
 */
export async function fetchWithRateLimit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetch(input, init);

    if (response.status !== 429) return response;

    lastResponse = response;
    if (attempt === MAX_RATE_LIMIT_RETRIES) break;

    // Parse retry delay from headers
    const retryAfter = response.headers.get('Retry-After')
      || response.headers.get('x-ratelimit-reset');
    let delayMs: number;

    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (Number.isFinite(parsed) && parsed < 300) {
        delayMs = parsed * 1000;
      } else {
        const resetTime = new Date(parsed * 1000).getTime();
        delayMs = Math.max(1000, resetTime - Date.now());
      }
    } else {
      delayMs = 2000 * Math.pow(2, attempt);
    }

    delayMs = Math.min(delayMs, 60_000);
    logger.warn({ retryDelaySeconds: Math.round(delayMs / 1000), attempt: attempt + 1, maxAttempts: MAX_RATE_LIMIT_RETRIES }, 'Triage importer rate limited, retrying');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastResponse!;
}

export interface TriageImportSummary {
  imported: number;
  skipped: number;
  errors: string[];
  nextCursor?: string | null;
}

export interface FullSyncResult {
  outcome: 'success' | 'partial' | 'failure' | 'stale';
  imported: number;
  skipped: number;
  errors: string[];
  pagesProcessed: number;
  durationMs: number;
  lastCursor: string | null;
}

export function createFullSyncResult(): FullSyncResult {
  return {
    outcome: 'success',
    imported: 0,
    skipped: 0,
    errors: [],
    pagesProcessed: 0,
    durationMs: 0,
    lastCursor: null,
  };
}

export function completeFullSyncResult(result: FullSyncResult, startedAt: number): FullSyncResult {
  result.durationMs = Date.now() - startedAt;
  if (result.outcome !== 'stale') {
    result.outcome = result.errors.length === 0
      ? 'success'
      : result.imported > 0 || result.skipped > 0 || result.pagesProcessed > 0
        ? 'partial'
        : 'failure';
  }
  return result;
}

export function safeRemoteError(label: string, error: unknown): string {
  if (error instanceof TriageImporterError) return error.message;
  return `${label} failed`;
}

export class TriageImporterError extends Error {
  constructor(message: string) {
    super(message.slice(0, 500));
    this.name = 'TriageImporterError';
  }
}

export function remoteResponseError(
  label: string,
  response: Response,
  qualifier?: string,
): TriageImporterError {
  const statusText = response.statusText.replace(/[^\w .()-]/g, '').slice(0, 100);
  return new TriageImporterError(
    `${label} failed${qualifier ? ` (${qualifier})` : ''}: ${response.status}${statusText ? ` ${statusText}` : ''}`,
  );
}

/** Safety limit to prevent runaway pagination */
export const MAX_PAGES = 50;
