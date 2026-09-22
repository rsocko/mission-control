import { buildEventSignature, MissingEventSigningSecretError } from './signing';

/**
 * Only `http:`/`https:` targets are dispatched. The prior contract validated
 * that a webhook URL parses (`new URL`) but nothing prevented a stored
 * `file:`/`ftp:`/`gopher:` target from being handed to `fetch`. Rejecting
 * every other scheme here keeps SSRF surface to ordinary HTTP requests without
 * breaking the LAN/self-hosted receivers this app intentionally supports.
 */
export const ALLOWED_WEBHOOK_PROTOCOLS = new Set(['http:', 'https:']);

export const DEFAULT_EVENT_DELIVERY_TIMEOUT_MS = 10_000;

export type EventDeliveryOutcomeKind = 'delivered' | 'transient' | 'permanent';

/**
 * Stable, non-sensitive failure codes. Delivery errors are reduced to one of
 * these before they are persisted or logged, so a webhook URL, secret or event
 * payload can never leak into `last_error` or the log stream.
 */
export type EventDeliveryFailureCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'signing_secret_missing'
  | 'delivery_timeout'
  | 'network_error'
  | 'http_client_error'
  | 'http_server_error';

export interface EventDeliveryOutcome {
  kind: EventDeliveryOutcomeKind;
  status: number | null;
  code: EventDeliveryFailureCode | null;
}

export interface EventDeliveryTarget {
  url: string;
  secret: string | null;
}

export interface EventDeliveryRequest {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface EventDeliveryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function assertDeliverableWebhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EventDeliveryRejection('invalid_url');
  }
  if (!ALLOWED_WEBHOOK_PROTOCOLS.has(parsed.protocol)) {
    throw new EventDeliveryRejection('unsupported_scheme');
  }
  return parsed;
}

export class EventDeliveryRejection extends Error {
  constructor(readonly code: EventDeliveryFailureCode) {
    super(code);
    this.name = 'EventDeliveryRejection';
  }
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const supported = signals.filter(Boolean);
  const [first] = supported;
  if (supported.length === 1 && first) return first;
  const controller = new AbortController();
  for (const signal of supported) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Performs a single signed, bounded webhook POST and classifies the result.
 * Never throws for transport problems — the caller decides retry vs.
 * dead-letter from the returned `kind`.
 */
export async function deliverEvent(
  target: EventDeliveryTarget,
  request: EventDeliveryRequest,
  options: EventDeliveryOptions = {},
): Promise<EventDeliveryOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVENT_DELIVERY_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify(request.payload);

  let url: URL;
  let signature: string;
  try {
    url = assertDeliverableWebhookUrl(target.url);
    signature = buildEventSignature(body, target.secret);
  } catch (error) {
    if (error instanceof MissingEventSigningSecretError) {
      return { kind: 'transient', status: null, code: 'signing_secret_missing' };
    }
    if (error instanceof EventDeliveryRejection) {
      return { kind: 'permanent', status: null, code: error.code };
    }
    throw error;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? combineSignals([timeoutSignal, options.signal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-Event': request.eventType,
        'X-MC-Signature': signature,
      },
      body,
      signal,
    });
  } catch (error) {
    const timedOut = timeoutSignal.aborted
      || (error instanceof Error && error.name === 'TimeoutError');
    return {
      kind: 'transient',
      status: null,
      code: timedOut ? 'delivery_timeout' : 'network_error',
    };
  }

  if (response.ok) {
    return { kind: 'delivered', status: response.status, code: null };
  }
  // 408/429 are retryable client responses; every other 4xx is a receiver
  // contract problem that will not resolve by retrying.
  const retryableClientError = response.status === 408 || response.status === 429;
  if (response.status >= 500 || retryableClientError) {
    return {
      kind: 'transient',
      status: response.status,
      code: response.status >= 500 ? 'http_server_error' : 'http_client_error',
    };
  }
  return { kind: 'permanent', status: response.status, code: 'http_client_error' };
}
