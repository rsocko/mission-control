import 'server-only';

import { z } from 'zod';
import type { ConnectorConfig } from '@/types';
import {
  getTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from './bridge-url';

const CONTRACT_VERSION = '1.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const BRIDGE_ERROR_CODES = [
  'bridge_auth_required',
  'bridge_unavailable',
  'browser_request_rejected',
  'connector_auth_invalid',
  'connector_auth_not_configured',
  'connector_auth_required',
  'connector_gateway_misconfigured',
  'connector_route_not_available',
  'internal_error',
  'invalid_amount_range',
  'invalid_bridge_response',
  'invalid_cursor',
  'invalid_date_range',
  'invalid_query',
  'invalid_request',
  'method_not_allowed',
  'not_authenticated',
  'not_found',
  'payload_too_large',
  'request_failed',
  'session_expired',
  'session_in_use',
  'transaction_not_found',
  'transaction_query_too_broad',
  'unsupported_media_type',
  'upstream_error',
  'upstream_rate_limited',
  'upstream_timeout',
  'upstream_unavailable',
] as const;
export const MONARCH_DATASET_LIMITS = {
  accounts: 1_000,
  'category-groups': 250,
  categories: 2_000,
  tags: 1_000,
  recurring: 5_000,
  budgets: 5_000,
} as const;

const provenanceSchema = z.object({
  provider: z.enum(['demo', 'live']),
  fetchedAt: z.string().datetime({ offset: true }),
}).strict();

const transactionSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite(),
  merchant: z.object({
    name: z.string(),
    logoUrl: z.string().url().nullable(),
  }).strict(),
  category: z.object({
    id: z.string().min(1),
    name: z.string(),
  }).strict().nullable(),
  account: z.object({
    id: z.string().min(1),
    displayName: z.string(),
    mask: z.string().nullable(),
  }).strict(),
  isPending: z.boolean(),
  isRecurring: z.boolean(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  tagReferences: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
  }).strict()),
}).strict();

const transactionsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  transactions: z.array(transactionSchema),
  total: z.number().int().nonnegative(),
  page: z.object({
    limit: z.number().int().positive(),
    nextCursor: z.string().min(1).nullable(),
  }).strict(),
}).strict();

const healthResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  status: z.enum(['ok', 'degraded']),
  mode: z.enum(['demo', 'live']),
  reachable: z.boolean(),
  authenticated: z.boolean(),
  authState: z.enum(['unauthenticated', 'connected', 'expired', 'degraded']),
}).strict();

const activeReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  isActive: z.boolean(),
}).strict();

const accountSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  type: z.string(),
  mask: z.string().nullable(),
  institution: z.string().nullable(),
  currentBalance: z.number().finite(),
  isActive: z.boolean(),
}).strict();

const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  groupId: z.string().min(1).nullable(),
  group: z.string().nullable(),
  icon: z.string().nullable(),
  isActive: z.boolean(),
}).strict();

const recurringSchema = z.object({
  id: z.string().min(1),
  merchant: z.string(),
  amount: z.number().finite(),
  frequency: z.string(),
  nextExpectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  account: transactionSchema.shape.account.nullable(),
  category: transactionSchema.shape.category,
}).strict();

const budgetSchema = z.object({
  category: z.object({
    id: z.string().min(1),
    name: z.string(),
  }).strict(),
  budgeted: z.number().finite(),
  spent: z.number().finite(),
  remaining: z.number().finite(),
  percentUsed: z.number().finite().nullable(),
}).strict();

const accountsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  accounts: z.array(accountSchema).max(MONARCH_DATASET_LIMITS.accounts),
}).strict();
const categoryGroupsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  categoryGroups: z.array(activeReferenceSchema).max(MONARCH_DATASET_LIMITS['category-groups']),
}).strict();
const categoriesResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  categories: z.array(categorySchema).max(MONARCH_DATASET_LIMITS.categories),
}).strict();
const tagsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  tags: z.array(activeReferenceSchema).max(MONARCH_DATASET_LIMITS.tags),
}).strict();
const recurringResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  recurring: z.array(recurringSchema).max(MONARCH_DATASET_LIMITS.recurring),
}).strict();
const budgetsResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  provenance: provenanceSchema,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  budgets: z.array(budgetSchema).max(MONARCH_DATASET_LIMITS.budgets),
}).strict();

const categoryUpdateResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  status: z.literal('updated'),
  transactionId: z.string(),
  categoryId: z.string(),
}).strict();

const errorResponseSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION).optional(),
  error: z.object({
    code: z.enum(BRIDGE_ERROR_CODES),
    message: z.string(),
  }).strict(),
}).strict();

export type MonarchTransaction = z.infer<typeof transactionSchema>;
export type MonarchTransactionsPage = z.infer<typeof transactionsResponseSchema>;
export type MonarchBridgeHealth = z.infer<typeof healthResponseSchema>;
export type MonarchAccount = z.infer<typeof accountSchema>;
export type MonarchCategoryGroup = z.infer<typeof activeReferenceSchema>;
export type MonarchCategory = z.infer<typeof categorySchema>;
export type MonarchTag = z.infer<typeof activeReferenceSchema>;
export type MonarchRecurringObligation = z.infer<typeof recurringSchema>;
export type MonarchBudget = z.infer<typeof budgetSchema>;
export type MonarchDatasetResponse<T extends string, Item> = {
  contractVersion: typeof CONTRACT_VERSION;
  provenance: z.infer<typeof provenanceSchema>;
} & Record<T, Item[]>;
export type MonarchBudgetsResponse = z.infer<typeof budgetsResponseSchema>;

export class MonarchBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MonarchBridgeError';
  }
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function nonnegativeInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(1000 * (2 ** attempt), MAX_RETRY_DELAY_MS);
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled'));
      return;
    }

    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled'));
    }, { once: true });
  });
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new MonarchBridgeError(
      'bridge_unavailable',
      'Monarch Bridge is unavailable',
      true,
      response.status,
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MonarchBridgeError(
          'bridge_unavailable',
          'Monarch Bridge is unavailable',
          true,
          response.status,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function isJsonResponse(response: Response): boolean {
  const mediaType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

function bridgeUnavailable(status?: number): MonarchBridgeError {
  return new MonarchBridgeError(
    'bridge_unavailable',
    'Monarch Bridge is unavailable',
    true,
    status,
  );
}

function bridgeTimeout(status?: number): MonarchBridgeError {
  return new MonarchBridgeError(
    'upstream_timeout',
    'Monarch Bridge request timed out',
    true,
    status,
  );
}

type MonarchBridgeConfig = Pick<ConnectorConfig, 'settings' | 'credentials'>;

export function getPersistedFinanceManagerServiceToken(
  config: Pick<ConnectorConfig, 'credentials'>,
): string {
  const credentials = (config.credentials ?? {}) as Record<string, unknown>;
  for (const alias of ['serviceToken', 'bridgeToken', 'apiToken']) {
    const value = credentials[alias];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseSettings(config: MonarchBridgeConfig): {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  maxRetries: number;
} {
  const settings = (config.settings ?? {}) as Record<string, unknown>;
  let baseUrl: string;
  try {
    baseUrl = getTyrionBridgeUrl(settings);
  } catch (error) {
    if (!(error instanceof TyrionBridgeUrlValidationError)) throw error;
    throw new MonarchBridgeError(error.code, error.message, false, 400);
  }
  const persistedToken = getPersistedFinanceManagerServiceToken(config);
  const serviceToken = persistedToken || process.env.FINANCE_MANAGER_API_TOKEN?.trim();
  if (!serviceToken) {
    throw new MonarchBridgeError(
      'missing_server_credential',
      'Tyrion service token is not configured',
      false,
      503,
    );
  }
  return {
    baseUrl,
    serviceToken,
    timeoutMs: positiveInteger(settings.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000),
    maxRetries: nonnegativeInteger(settings.maxRetries, DEFAULT_MAX_RETRIES, 5),
  };
}

export class MonarchBridgeClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: MonarchBridgeConfig) {
    const settings = parseSettings(config);
    this.baseUrl = settings.baseUrl;
    this.serviceToken = settings.serviceToken;
    this.timeoutMs = settings.timeoutMs;
    this.maxRetries = settings.maxRetries;
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const requestUrl = new URL(`${this.baseUrl}${path}`);
    if (requestUrl.origin !== new URL(this.baseUrl).origin) {
      throw bridgeUnavailable();
    }
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        const suppliedHeaders = Object.fromEntries(
          [...new Headers(init.headers)].filter(([name]) => (
            name !== 'authorization'
            && name !== 'accept'
            && name !== 'content-type'
          )),
        );
        response = await fetch(requestUrl.toString(), {
          ...init,
          cache: 'no-store',
          redirect: 'error',
          headers: {
            ...suppliedHeaders,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${this.serviceToken}`,
          },
          signal: requestSignal,
        });
      } catch {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
        const isTimeout = timeoutSignal.aborted;
        if (attempt < this.maxRetries) {
          await wait(Math.min(1000 * (2 ** attempt), MAX_RETRY_DELAY_MS), signal);
          continue;
        }
        throw new MonarchBridgeError(
          isTimeout ? 'upstream_timeout' : 'bridge_unavailable',
          isTimeout ? 'Monarch Bridge request timed out' : 'Monarch Bridge is unavailable',
          true,
        );
      }

      let body: unknown;
      try {
        if (
          response.redirected
          || (response.url && new URL(response.url).origin !== requestUrl.origin)
          || !isJsonResponse(response)
        ) {
          await response.body?.cancel();
          throw bridgeUnavailable(response.status);
        }
        body = JSON.parse(await readBoundedResponse(response));
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
        }
        const unavailable = error instanceof MonarchBridgeError
          ? error
          : timeoutSignal.aborted
            ? bridgeTimeout(response.status)
            : bridgeUnavailable(response.status);
        if (attempt < this.maxRetries) {
          await wait(retryDelay(response, attempt), signal);
          continue;
        }
        throw unavailable;
      }

      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(body);
        const code = parsed.success ? parsed.data.error.code : 'upstream_error';
        const retryable = response.status === 408
          || response.status === 429
          || response.status >= 500
          || code === 'session_in_use'
          || code === 'upstream_timeout'
          || code === 'upstream_rate_limited'
          || code === 'bridge_unavailable';
        if (retryable && attempt < this.maxRetries) {
          await wait(retryDelay(response, attempt), signal);
          continue;
        }
        throw new MonarchBridgeError(
          code,
          `Monarch Bridge request failed (${code})`,
          retryable,
          response.status,
        );
      }

      const headerVersion = response.headers.get('x-monarch-contract-version');
      if (headerVersion !== CONTRACT_VERSION) {
        throw new MonarchBridgeError('unsupported_contract', 'Unsupported Monarch Bridge contract version', false, response.status);
      }
      if (
        typeof body !== 'object'
        || body === null
        || (body as { contractVersion?: unknown }).contractVersion !== CONTRACT_VERSION
      ) {
        throw new MonarchBridgeError('invalid_contract', 'Invalid Monarch Bridge response contract', false, response.status);
      }
      return body;
    }
    throw new MonarchBridgeError('bridge_unavailable', 'Monarch Bridge is unavailable', true);
  }

  async getHealth(signal?: AbortSignal): Promise<MonarchBridgeHealth> {
    const body = await this.request('/health', {}, signal);
    const parsed = healthResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MonarchBridgeError('invalid_contract', 'Invalid Monarch Bridge health contract', false);
    }
    return parsed.data;
  }

  async getTransactionsPage(
    input: { startDate: string; endDate: string; limit: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<MonarchTransactionsPage> {
    const query = new URLSearchParams({
      start_date: input.startDate,
      end_date: input.endDate,
      limit: String(Math.min(Math.max(input.limit, 1), 500)),
    });
    if (input.cursor) query.set('cursor', input.cursor);
    const body = await this.request(`/transactions?${query}`, {}, signal);
    const parsed = transactionsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MonarchBridgeError('invalid_contract', 'Invalid Monarch Bridge transaction contract', false);
    }
    return parsed.data;
  }

  private async getDataset<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const parsed = schema.safeParse(await this.request(path, {}, signal));
    if (!parsed.success) {
      throw new MonarchBridgeError(
        'invalid_contract',
        'Monarch Bridge returned an invalid or oversized dataset',
        false,
        502,
      );
    }
    return parsed.data;
  }

  getAccounts(signal?: AbortSignal) {
    return this.getDataset('/accounts', accountsResponseSchema, signal);
  }

  getCategoryGroups(signal?: AbortSignal) {
    return this.getDataset('/category-groups', categoryGroupsResponseSchema, signal);
  }

  getCategories(signal?: AbortSignal) {
    return this.getDataset('/categories', categoriesResponseSchema, signal);
  }

  getTags(signal?: AbortSignal) {
    return this.getDataset('/tags', tagsResponseSchema, signal);
  }

  getRecurring(signal?: AbortSignal) {
    return this.getDataset('/recurring', recurringResponseSchema, signal);
  }

  getBudgets(signal?: AbortSignal) {
    return this.getDataset('/budgets', budgetsResponseSchema, signal);
  }

  async updateCategory(
    transactionId: string,
    categoryId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.request(
      `/transactions/${encodeURIComponent(transactionId)}/category`,
      { method: 'PATCH', body: JSON.stringify({ categoryId }) },
      signal,
    );
    const parsed = categoryUpdateResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.transactionId !== transactionId || parsed.data.categoryId !== categoryId) {
      throw new MonarchBridgeError('invalid_contract', 'Invalid Monarch Bridge category update contract', false);
    }
  }
}
