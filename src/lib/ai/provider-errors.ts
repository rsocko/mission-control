const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 30;
const DEFAULT_QUOTA_RETRY_AFTER_SECONDS = 60;
const DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS = 15;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

type ProviderErrorCategory = 'quota' | 'rate_limit' | 'provider_unavailable';

export interface AIProviderErrorDetails {
  category: ProviderErrorCategory;
  code: 'AI_QUOTA_EXHAUSTED' | 'AI_RATE_LIMITED' | 'AI_PROVIDER_UNAVAILABLE';
  message: string;
  status: 429 | 503;
  retryAfter: number;
  upstreamStatus?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function readStatus(error: unknown, depth = 0): number | undefined {
  if (depth > 2) return undefined;
  const record = asRecord(error);
  if (!record) return undefined;

  for (const candidate of [record.statusCode, record.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }

  return readStatus(record.response, depth + 1) ?? readStatus(record.cause, depth + 1);
}

function readHeaders(error: unknown, depth = 0): Headers | null {
  if (depth > 2) return null;
  const record = asRecord(error);
  if (!record) return null;

  for (const candidate of [record.responseHeaders, record.headers]) {
    if (candidate instanceof Headers) return candidate;
    const headerRecord = asRecord(candidate);
    if (headerRecord) {
      const entries = Object.entries(headerRecord)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
      if (entries.length > 0) return new Headers(entries);
    }
  }

  return readHeaders(record.response, depth + 1) ?? readHeaders(record.cause, depth + 1);
}

function readRetryAfterSeconds(error: unknown): number | undefined {
  const value = readHeaders(error)?.get('retry-after')?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) {
    return Math.min(Math.max(Number(value), 1), MAX_RETRY_AFTER_SECONDS);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  const seconds = Math.ceil((retryAt - Date.now()) / 1_000);
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS);
}

function classificationText(error: unknown, depth = 0): string {
  if (depth > 2) return '';
  const record = asRecord(error);
  if (!record) return '';

  const values = [
    record.name,
    record.message,
    record.code,
    record.type,
  ].filter((value): value is string => typeof value === 'string');

  const data = asRecord(record.data);
  const structuredError = asRecord(data?.error);
  values.push(...[
    data?.code,
    data?.type,
    structuredError?.code,
    structuredError?.type,
    structuredError?.message,
  ].filter((value): value is string => typeof value === 'string'));

  return `${values.join(' ')} ${classificationText(record.cause, depth + 1)}`.toLowerCase();
}

function isMarkedRetryable(error: unknown): boolean {
  const record = asRecord(error);
  return record?.isRetryable === true || asRecord(record?.cause)?.isRetryable === true;
}

export function getAIProviderErrorDetails(error: unknown): AIProviderErrorDetails | null {
  const upstreamStatus = readStatus(error);
  const text = classificationText(error);
  const retryAfter = readRetryAfterSeconds(error);
  const isQuota = /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|billing hard limit|resource[_ -]?exhausted/.test(text);
  const isRateLimit = /rate[_ -]?limit|too many requests|throttl/.test(text);

  if (isQuota) {
    return {
      category: 'quota',
      code: 'AI_QUOTA_EXHAUSTED',
      message: 'The AI provider quota is currently exhausted. Try again later or check the provider quota.',
      status: 429,
      retryAfter: retryAfter ?? DEFAULT_QUOTA_RETRY_AFTER_SECONDS,
      upstreamStatus,
    };
  }

  if (upstreamStatus === 429 || isRateLimit) {
    return {
      category: 'rate_limit',
      code: 'AI_RATE_LIMITED',
      message: 'The AI provider is temporarily rate limited. Try again shortly.',
      status: 429,
      retryAfter: retryAfter ?? DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS,
      upstreamStatus,
    };
  }

  if (
    upstreamStatus === 502
    || upstreamStatus === 503
    || upstreamStatus === 504
    || upstreamStatus === 529
    || (isMarkedRetryable(error) && upstreamStatus !== undefined && upstreamStatus >= 500)
  ) {
    return {
      category: 'provider_unavailable',
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: 'The AI provider is temporarily unavailable. Try again shortly.',
      status: 503,
      retryAfter: retryAfter ?? DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS,
      upstreamStatus,
    };
  }

  return null;
}

export function sanitizeAITelemetryLabel(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .trim()
    .slice(0, maxLength)
    .replace(/[^a-zA-Z0-9._:/-]/g, '_');
  return normalized || undefined;
}
