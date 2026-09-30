import {
  COMPANION_ACTION_MAX_PAGE_ITEMS,
  COMPANION_ACTION_EFFECTIVE_PAGE_ITEMS,
  COMPANION_ACTION_MAX_WRITE_BYTES,
  isCompanionActionV1,
  isCompanionActionFeedPage,
  isCompanionActionMutationReceipt,
  type CompanionActionFeedPage,
  type CompanionActionMutationRequest,
  type CompanionActionMutationReceipt,
} from './action-contract';
import {
  COMPANION_ACTION_FEED_PATH_V2,
  COMPANION_ACTION_V2_MAX_WRITE_BYTES,
  isCompanionActionFeedPageV2,
  isCompanionActionMutationRequestV2,
  isCompanionActionMutationReceiptV2,
  type CompanionActionFeedPageV2,
  type CompanionActionMutationRequestV2,
  type CompanionActionMutationReceiptV2,
} from './action-contract-v2';

const MAX_ERROR_BYTES = 8 * 1024;

export class CompanionActionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Companion action request failed (${status} ${code})`);
    this.name = 'CompanionActionHttpError';
  }
}

export interface CompanionActionClient {
  fetchPage(cursor: string | null, signal?: AbortSignal): Promise<CompanionActionFeedPage>;
  fetchPageV2(cursor: string | null, signal?: AbortSignal): Promise<CompanionActionFeedPageV2>;
  submitMutationV2(
    request: CompanionActionMutationRequestV2,
    signal?: AbortSignal,
  ): Promise<CompanionActionMutationReceiptV2>;
  submitMutation(
    request: CompanionActionMutationRequest,
    signal?: AbortSignal,
  ): Promise<CompanionActionMutationReceipt>;
}

export interface CompanionActionClientOptions {
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Companion action request aborted'));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error('Companion action request aborted'));
    }, { once: true });
  });
}

async function readErrorCode(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, MAX_ERROR_BYTES);
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string'
      ? parsed.error.code.slice(0, 100)
      : 'http_error';
  } catch {
    return 'http_error';
  }
}

export function createCompanionActionClient(
  options: CompanionActionClientOptions,
): CompanionActionClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = Math.min(Math.max(options.maxRetries ?? 3, 0), 5);

  async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          signal,
          cache: 'no-store',
          headers: {
            authorization: `Bearer ${options.credential}`,
            accept: 'application/json',
            ...(init.body ? { 'content-type': 'application/json' } : {}),
          },
        });
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxRetries) return response;
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter * 1_000, 30_000)
          : Math.min(1_000 * (2 ** attempt), 10_000);
        await abortableDelay(delayMs, signal);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === maxRetries) throw error;
        await abortableDelay(Math.min(1_000 * (2 ** attempt), 10_000), signal);
      }
    }
    throw lastError ?? new Error('Companion action request failed');
  }

  return {
    async fetchPage(cursor, signal) {
      const query = new URLSearchParams({
        limit: String(Math.min(
          COMPANION_ACTION_MAX_PAGE_ITEMS,
          COMPANION_ACTION_EFFECTIVE_PAGE_ITEMS,
        )),
      });
      if (cursor) query.set('cursor', cursor);
      const response = await request(
        `/v1/integrations/action-feed?${query.toString()}`,
        { method: 'GET' },
        signal,
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        throw new CompanionActionHttpError(
          response.status,
          code,
          response.status === 429 || response.status >= 500,
        );
      }
      const page = await response.json() as unknown;
      if (!isCompanionActionFeedPage(page)) {
        throw new CompanionActionHttpError(502, 'contract_invalid', false);
      }
      return page;
    },

    async fetchPageV2(cursor, signal) {
      const query = new URLSearchParams({
        limit: String(COMPANION_ACTION_MAX_PAGE_ITEMS),
      });
      if (cursor) query.set('cursor', cursor);
      const response = await request(
        `${COMPANION_ACTION_FEED_PATH_V2}?${query.toString()}`,
        { method: 'GET' },
        signal,
      );
      if (!response.ok) {
        const code = await readErrorCode(response);
        throw new CompanionActionHttpError(
          response.status,
          code,
          response.status === 429 || response.status >= 500,
        );
      }
      const page = await response.json() as unknown;
      if (!isCompanionActionFeedPageV2(page, isCompanionActionV1)) {
        throw new CompanionActionHttpError(502, 'contract_invalid', false);
      }
      return page;
    },

    async submitMutationV2(mutation, signal) {
      if (!isCompanionActionMutationRequestV2(mutation)) {
        throw new CompanionActionHttpError(400, 'mutation_invalid', false);
      }
      const body = JSON.stringify(mutation);
      if (Buffer.byteLength(body, 'utf8') > COMPANION_ACTION_V2_MAX_WRITE_BYTES) {
        throw new CompanionActionHttpError(413, 'mutation_too_large', false);
      }
      const response = await request(
        `${COMPANION_ACTION_FEED_PATH_V2}/mutations`,
        { method: 'POST', body },
        signal,
      );
      const payload = await response.json().catch(() => null) as unknown;
      if (
        (response.ok || response.status === 409)
        && isCompanionActionMutationReceiptV2(payload)
        && payload.operationId === mutation.operationId
        && payload.actionId === mutation.actionId
      ) {
        return payload;
      }
      const code = isCompanionActionMutationReceiptV2(payload)
        ? 'receipt_identity_mismatch'
        : await readErrorCode(new Response(JSON.stringify(payload), {
            status: response.status,
          }));
      throw new CompanionActionHttpError(
        response.ok ? 502 : response.status,
        code,
        response.status === 429 || response.status >= 500,
      );
    },

    async submitMutation(mutation, signal) {
      const body = JSON.stringify(mutation);
      if (Buffer.byteLength(body, 'utf8') > COMPANION_ACTION_MAX_WRITE_BYTES) {
        throw new CompanionActionHttpError(413, 'mutation_too_large', false);
      }
      const response = await request(
        '/v1/integrations/action-feed/mutations',
        { method: 'POST', body },
        signal,
      );
      const payload = await response.json().catch(() => null) as unknown;
      if ((response.ok || response.status === 409) && isCompanionActionMutationReceipt(payload)) {
        if (
          payload.operationId !== mutation.operationId
          || payload.actionId !== mutation.actionId
        ) {
          throw new CompanionActionHttpError(502, 'receipt_identity_mismatch', false);
        }
        return payload;
      }
      const code = response.status === 409
        && typeof payload === 'object'
        && payload !== null
        && 'error' in payload
        && typeof payload.error === 'object'
        && payload.error !== null
        && 'code' in payload.error
        && typeof payload.error.code === 'string'
        ? payload.error.code.slice(0, 100)
        : 'http_error';
      throw new CompanionActionHttpError(
        response.status,
        code,
        response.status === 429 || response.status >= 500,
      );
    },
  };
}
