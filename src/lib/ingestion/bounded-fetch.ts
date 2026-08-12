import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  IngestionLimitError,
  INGESTION_LIMITS,
  IngestionValidationError,
  readLimitedResponse,
  timeoutSignal,
} from './bounded-reader';
import {
  ingestionRejectionReason,
  recordIngestionOutcome,
  type IngestionSource,
} from './telemetry';

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function isPrivateUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
    if (hostname === 'localhost') return true;
    if (isIP(hostname)) return isPrivateIp(hostname);
    const addresses = await withAbortSignal(
      lookup(hostname, { all: true, verbatim: true }),
      signal,
    );
    return addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address));
  } catch {
    signal?.throwIfAborted();
    return true;
  }
}

function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolveOperation, rejectOperation) => {
    const abort = () => rejectOperation(
      signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
    );
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      result => {
        signal.removeEventListener('abort', abort);
        resolveOperation(result);
      },
      error => {
        signal.removeEventListener('abort', abort);
        rejectOperation(error);
      },
    );
  });
}

export async function fetchBounded(
  inputUrl: string,
  options: {
    limit: number;
    timeoutMs: number;
    maxRedirects?: number;
    signal?: AbortSignal;
    headers?: HeadersInit;
    acceptContentTypes?: RegExp;
    label?: string;
    source?: IngestionSource;
  },
): Promise<{ response: Response; bytes: Uint8Array; url: string }> {
  let url = inputUrl;
  let observedBytes = 0;
  const startedAt = performance.now();
  const source = options.source ?? 'unknown';
  const maxRedirects = options.maxRedirects ?? INGESTION_LIMITS.maxRedirects;
  const combined = timeoutSignal(options.timeoutMs, options.signal);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      if (await isPrivateUrl(url, combined.signal)) {
        throw new IngestionValidationError('URL points to a private or internal network address');
      }
      const response = await fetch(url, {
        headers: options.headers,
        redirect: 'manual',
        signal: combined.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === maxRedirects) {
          throw new IngestionValidationError('Remote document exceeded the redirect limit');
        }
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new IngestionValidationError(`Remote document returned HTTP ${response.status}`);
      }
      if (options.acceptContentTypes) {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType || !options.acceptContentTypes.test(contentType)) {
          await response.body?.cancel().catch(() => undefined);
          throw new IngestionValidationError('Remote document has an unsupported content type');
        }
      }
      const bytes = await readLimitedResponse(response, options.limit, {
        signal: combined.signal,
        label: options.label,
        source: options.source,
        recordTelemetry: false,
      });
      observedBytes = bytes.byteLength;
      recordIngestionOutcome({
        source,
        outcome: 'accepted',
        bytes: observedBytes,
        durationMs: performance.now() - startedAt,
      });
      return { response, bytes, url };
    }
    throw new IngestionValidationError('Remote document exceeded the redirect limit');
  } catch (error) {
    recordIngestionOutcome({
      source,
      outcome: 'rejected',
      bytes: error instanceof IngestionLimitError ? error.actual ?? observedBytes : observedBytes,
      durationMs: performance.now() - startedAt,
      reason: ingestionRejectionReason(error),
    });
    throw error;
  } finally {
    combined.cleanup();
  }
}
