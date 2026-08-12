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
  imported: number;
  skipped: number;
  errors: string[];
  pagesProcessed: number;
  durationMs: number;
  lastCursor: string | null;
}

/** Safety limit to prevent runaway pagination */
export const MAX_PAGES = 50;
