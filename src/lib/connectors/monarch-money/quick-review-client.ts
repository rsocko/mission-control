import 'server-only';

import {
  tyrionQuickReviewRankRequestSchema,
  tyrionQuickReviewRankResponseSchema,
  tyrionQuickReviewResearchRequestSchema,
  tyrionQuickReviewResearchResponseSchema,
  tyrionQuickReviewRuleRequestSchema,
  tyrionQuickReviewRuleResponseSchema,
  type TyrionQuickReviewRankRequest,
  type TyrionQuickReviewRankResponse,
  type TyrionQuickReviewResearchRequest,
  type TyrionQuickReviewResearchResponse,
  type TyrionQuickReviewRuleRequest,
  type TyrionQuickReviewRuleResponse,
} from '@/lib/finance/quick-review-contract';

const TYRION_INTERNAL_ORIGIN = 'http://tyrion-operations-ui:3000';
const TYRION_INTERNAL_AUTHORITY = 'tyrion-operations-ui:3000';
const QUICK_REVIEW_PATH = '/api/internal/v1/finance/quick-review';
const MAX_BODY_BYTES = 65_536;
const TIMEOUT_MS = 15_000;

export class TyrionFinanceReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TyrionFinanceReviewError';
  }
}

function configuredToken(environment: Readonly<Record<string, string | undefined>>): string {
  const token = environment.BRIDGE_API_TOKEN?.trim() ?? '';
  if (token.length < 32) {
    throw new TyrionFinanceReviewError(
      'attribution_auth_not_configured',
      'Tyrion private quick review authentication is not configured',
      503,
      false,
    );
  }
  return token;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new TyrionFinanceReviewError('invalid_contract', 'Tyrion response is too large', 502, false);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new TyrionFinanceReviewError('invalid_contract', 'Tyrion response is too large', 502, false);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new TyrionFinanceReviewError('invalid_contract', 'Tyrion returned invalid JSON', 502, false);
  }
}

export class TyrionFinanceReviewClient {
  constructor(
    private readonly token = configuredToken(process.env),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async rank(request: TyrionQuickReviewRankRequest, signal?: AbortSignal) {
    const response = await this.post(
      'rank',
      request,
      tyrionQuickReviewRankRequestSchema,
      tyrionQuickReviewRankResponseSchema,
      signal,
    );
    const inputByRef = new Map(request.items.map((item) => [item.sourceRef, item]));
    const outputRefs = new Set(response.rankedItems.map((item) => item.sourceRef));
    const hasExactRefs = outputRefs.size === request.items.length
      && request.items.every((item) => outputRefs.has(item.sourceRef));
    const isOrdered = response.rankedItems.every((item, index, items) => {
      if (item.rank !== index + 1) return false;
      if (item.reasons.some((reason, reasonIndex) => (
        reasonIndex > 0 && items[index].reasons[reasonIndex - 1].localeCompare(reason) > 0
      ))) return false;
      if (index === 0) return true;
      const previous = items[index - 1];
      const currentInput = inputByRef.get(item.sourceRef);
      const previousInput = inputByRef.get(previous.sourceRef);
      if (!currentInput || !previousInput) return false;
      return previous.score > item.score
        || (
          previous.score === item.score
          && (
            previousInput.occurredOn > currentInput.occurredOn
            || (
              previousInput.occurredOn === currentInput.occurredOn
              && previous.sourceRef.localeCompare(item.sourceRef) < 0
            )
          )
        );
    });
    if (!hasExactRefs || !isOrdered) {
      throw new TyrionFinanceReviewError(
        'invalid_contract',
        'Invalid Tyrion rank response correlation',
        502,
        false,
      );
    }
    return response;
  }

  prepareResearch(request: TyrionQuickReviewResearchRequest, signal?: AbortSignal) {
    return this.post(
      'research',
      request,
      tyrionQuickReviewResearchRequestSchema,
      tyrionQuickReviewResearchResponseSchema,
      signal,
    );
  }

  suggestRule(request: TyrionQuickReviewRuleRequest, signal?: AbortSignal) {
    return this.post(
      'rule-suggestion',
      request,
      tyrionQuickReviewRuleRequestSchema,
      tyrionQuickReviewRuleResponseSchema,
      signal,
    );
  }

  private async post<TRequest, TResponse>(
    operation: 'rank' | 'research' | 'rule-suggestion',
    request: TRequest,
    requestSchema: { safeParse(value: unknown): { success: true; data: TRequest } | { success: false } },
    responseSchema: { safeParse(value: unknown): { success: true; data: TResponse } | { success: false } },
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const parsedRequest = requestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new TyrionFinanceReviewError('invalid_request', 'Invalid Tyrion quick review request', 400, false);
    }
    const body = JSON.stringify(parsedRequest.data);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new TyrionFinanceReviewError('payload_too_large', 'Tyrion request is too large', 413, false);
    }
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${TYRION_INTERNAL_ORIGIN}${QUICK_REVIEW_PATH}/${operation}`,
        {
          method: 'POST',
          headers: {
            Host: TYRION_INTERNAL_AUTHORITY,
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body,
          cache: 'no-store',
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        },
      );
    } catch {
      throw new TyrionFinanceReviewError(
        timeoutSignal.aborted ? 'quick_review_timeout' : 'quick_review_operation_failed',
        timeoutSignal.aborted ? 'Tyrion quick review timed out' : 'Tyrion quick review is unavailable',
        503,
        true,
      );
    }
    const parsedBody = await boundedJson(response);
    if (!response.ok) {
      const error = parsedBody && typeof parsedBody === 'object' && 'error' in parsedBody
        ? (parsedBody as { error?: { code?: unknown } }).error
        : null;
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : 'quick_review_operation_failed';
      throw new TyrionFinanceReviewError(
        code,
        `Tyrion quick review request failed (${code})`,
        response.status,
        response.status >= 500,
      );
    }
    const parsedResponse = responseSchema.safeParse(parsedBody);
    if (!parsedResponse.success) {
      throw new TyrionFinanceReviewError('invalid_contract', 'Invalid Tyrion quick review response', 502, false);
    }
    return parsedResponse.data;
  }
}

export type {
  TyrionQuickReviewRankRequest,
  TyrionQuickReviewRankResponse,
  TyrionQuickReviewResearchRequest,
  TyrionQuickReviewResearchResponse,
  TyrionQuickReviewRuleRequest,
  TyrionQuickReviewRuleResponse,
};
