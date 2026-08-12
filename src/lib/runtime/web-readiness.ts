const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_RETRY_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface WebReadinessOptions {
  url?: string;
  maxAttempts?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  fetchResponse?: (url: string, timeoutMs: number) => Promise<{ ok: boolean }>;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (details: {
    attempt: number;
    maxAttempts: number;
    error: unknown;
  }) => void;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function defaultFetchResponse(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean }> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export async function waitForWebReadiness(
  options: WebReadinessOptions = {},
): Promise<void> {
  const url = options.url ?? process.env.MC_WEB_READINESS_URL;
  if (!url) return;

  const maxAttempts = options.maxAttempts ?? positiveInteger(
    process.env.MC_WEB_READINESS_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
  );
  const retryIntervalMs = options.retryIntervalMs ?? positiveInteger(
    process.env.MC_WEB_READINESS_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
  const requestTimeoutMs = options.requestTimeoutMs ?? positiveInteger(
    process.env.MC_WEB_READINESS_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const fetchResponse = options.fetchResponse ?? defaultFetchResponse;
  const sleep = options.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchResponse(url, requestTimeoutMs);
      if (response.ok) return;
      lastError = new Error(`Web readiness returned a non-success status from ${url}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt === maxAttempts) break;
    options.onRetry?.({ attempt, maxAttempts, error: lastError });
    await sleep(retryIntervalMs);
  }

  throw new Error(
    `Web readiness did not succeed after ${maxAttempts} attempts`,
    { cause: lastError },
  );
}
