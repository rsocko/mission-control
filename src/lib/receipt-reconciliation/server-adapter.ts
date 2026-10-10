import 'server-only';

import { z } from 'zod';
import {
  paymentReviewActionRequestSchema,
  paymentReviewActionResultSchema,
  paymentReviewItemSchema,
  paymentReviewPageSchema,
  RECEIPT_RECONCILIATION_CONTRACT_VERSION,
  RECEIPT_RECONCILIATION_PAGE_LIMIT,
  type PaymentReviewActionRequest,
  type PaymentReviewActionResult,
  type PaymentReviewItem,
  type PaymentReviewPage,
} from './contract';

const MAX_RESPONSE_BYTES = 128 * 1024;
const TIMEOUT_MS = 10_000;
const LIST_PATH = '/api/mc/v1/payment-reconciliation-reviews';

const wireSourceAction = z.strictObject({
  id: z.string(),
  method: z.literal('POST'),
  url: z.string(),
  expected_revision: z.number(),
});
const wireEvidence = z.strictObject({
  id: z.string(),
  kind: z.string(),
  payee_hint: z.string().nullable(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  evidence_date: z.string().nullable(),
  source_system: z.string(),
  source_state: z.string(),
  match_state: z.string(),
  payment_status: z.string(),
  confidence: z.string().nullable(),
  reason_codes: z.array(z.string()),
  source_as_of: z.string(),
  edge_state: z.string().nullable(),
});
const wireItem = z.strictObject({
  contract_version: z.literal('1.0'),
  id: z.string(),
  revision: z.number(),
  case_kind: z.string(),
  state: z.string(),
  active: z.boolean(),
  attention_state: z.string(),
  source_as_of: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()),
  obligation: z.strictObject({
    id: z.string(),
    status: z.string(),
    revision: z.number(),
    expected_amount_minor: z.number().nullable(),
    currency: z.string().nullable(),
    completion_suggested: z.boolean(),
  }),
  evidence: wireEvidence.nullable(),
  owl_deep_link: z.string(),
  source_actions: z.array(wireSourceAction),
  history: z.array(z.unknown()).nullable().optional(),
});
const wireActionResult = z.strictObject({
  contract_version: z.literal('1.0'),
  action: z.string(),
  case: wireItem,
  source_acknowledgement: z.string(),
  authoritative_read_back: z.boolean(),
  idempotent: z.boolean(),
});

export class ReceiptReconciliationAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly current: PaymentReviewItem | null = null,
  ) {
    super(message);
  }
}

interface AdapterConfig {
  origin: URL;
  token: string;
}

function configuration(): AdapterConfig | null {
  const rawUrl = process.env.OWL_MISSION_CONTROL_URL?.trim();
  const token = process.env.OWL_MISSION_CONTROL_API_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  const origin = new URL(rawUrl);
  const localHttp = origin.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(origin.hostname.toLowerCase());
  if ((!localHttp && origin.protocol !== 'https:') || origin.username || origin.password || origin.hash) {
    throw new Error('OWL_MISSION_CONTROL_URL is not approved');
  }
  origin.pathname = origin.pathname.replace(/\/+$/, '') + '/';
  origin.search = '';
  return { origin, token };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ReceiptReconciliationAdapterError('owl_response_too_large', 'OWL response exceeded the safety limit.', 502, false);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new ReceiptReconciliationAdapterError('owl_response_too_large', 'OWL response exceeded the safety limit.', 502, false);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new ReceiptReconciliationAdapterError('invalid_owl_contract', 'OWL returned invalid JSON.', 502, false);
  }
}

function safeOwlUrl(config: AdapterConfig, deepLink: string): string {
  if (!deepLink.startsWith('#/')) {
    throw new ReceiptReconciliationAdapterError('invalid_owl_contract', 'OWL returned an unsafe owner link.', 502, false);
  }
  const url = new URL(config.origin);
  url.hash = deepLink.slice(1);
  return url.toString();
}

function normalizeSummary(value: Record<string, unknown>) {
  return {
    ...(Array.isArray(value.reason_codes) ? { reasonCodes: value.reason_codes } : {}),
    ...(typeof value.source_generation === 'string' ? { sourceGeneration: value.source_generation } : {}),
    ...(typeof value.expected_amount_minor === 'number' ? { expectedAmountMinor: value.expected_amount_minor } : {}),
    ...(typeof value.allocated_amount_minor === 'number' ? { allocatedAmountMinor: value.allocated_amount_minor } : {}),
    ...(typeof value.currency === 'string' ? { currency: value.currency } : {}),
  };
}

function normalizeItem(config: AdapterConfig, input: unknown): PaymentReviewItem {
  const item = wireItem.parse(input);
  return paymentReviewItemSchema.parse({
    contractVersion: item.contract_version,
    id: item.id,
    revision: item.revision,
    caseKind: item.case_kind,
    state: item.state,
    active: item.active,
    attentionState: item.attention_state,
    sourceAsOf: item.source_as_of,
    summary: normalizeSummary(item.summary),
    obligation: {
      id: item.obligation.id,
      status: item.obligation.status,
      revision: item.obligation.revision,
      expectedAmountMinor: item.obligation.expected_amount_minor,
      currency: item.obligation.currency,
      completionSuggested: item.obligation.completion_suggested,
    },
    evidence: item.evidence && {
      id: item.evidence.id,
      kind: item.evidence.kind,
      payeeHint: item.evidence.payee_hint,
      amountMinor: item.evidence.amount_minor,
      currency: item.evidence.currency,
      evidenceDate: item.evidence.evidence_date,
      sourceSystem: item.evidence.source_system,
      sourceState: item.evidence.source_state,
      matchState: item.evidence.match_state,
      paymentStatus: item.evidence.payment_status,
      confidence: item.evidence.confidence,
      reasonCodes: item.evidence.reason_codes,
      sourceAsOf: item.evidence.source_as_of,
      edgeState: item.evidence.edge_state,
    },
    owlUrl: safeOwlUrl(config, item.owl_deep_link),
    sourceActions: item.source_actions.map((action) => ({
      id: action.id,
      method: action.method,
      url: action.url,
      expectedRevision: action.expected_revision,
    })),
  });
}

async function request(
  config: AdapterConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path.replace(/^\//, ''), config.origin), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + config.token,
        ...init.headers,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: timeout,
    });
  } catch {
    throw new ReceiptReconciliationAdapterError(
      timeout.aborted ? 'owl_timeout' : 'owl_unavailable',
      timeout.aborted ? 'OWL receipt reconciliation timed out.' : 'OWL receipt reconciliation is unavailable.',
      timeout.aborted ? 504 : 503,
      true,
    );
  }
  const body = await boundedJson(response);
  return { response, body };
}

function upstreamCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { detail?: unknown; error?: unknown };
  const error = record.detail && typeof record.detail === 'object'
    ? (record.detail as { code?: unknown })
    : record.error && typeof record.error === 'object'
      ? (record.error as { code?: unknown })
      : null;
  return typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : null;
}

export class OwlReceiptReconciliationAdapter {
  constructor(private readonly config = configuration()) {}

  async list(offset = 0): Promise<PaymentReviewPage> {
    return this.listPage(offset, true);
  }

  async listForAttention(offset = 0): Promise<PaymentReviewPage> {
    return this.listPage(offset, false);
  }

  private async listPage(offset: number, activeOnly: boolean): Promise<PaymentReviewPage> {
    if (!this.config) {
      return paymentReviewPageSchema.parse({
        contractVersion: RECEIPT_RECONCILIATION_CONTRACT_VERSION,
        state: 'unavailable',
        items: [],
        offset,
        nextOffset: null,
        unavailableReason: 'OWL receipt reconciliation is not configured.',
      });
    }
    const url = new URL(LIST_PATH, this.config.origin);
    url.searchParams.set('active_only', String(activeOnly));
    url.searchParams.set('limit', String(RECEIPT_RECONCILIATION_PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));
    const { response, body } = await request(this.config, url.pathname + url.search);
    if (!response.ok) {
      throw new ReceiptReconciliationAdapterError(
        upstreamCode(body) ?? 'owl_receipt_list_failed',
        'OWL receipt reconciliation could not be loaded.',
        response.status === 401 || response.status === 403 ? 503 : 502,
        response.status >= 500,
      );
    }
    const wireItems = z.array(wireItem).max(RECEIPT_RECONCILIATION_PAGE_LIMIT).parse(body);
    const items = wireItems.map((item) => normalizeItem(this.config!, item));
    return paymentReviewPageSchema.parse({
      contractVersion: RECEIPT_RECONCILIATION_CONTRACT_VERSION,
      state: items.length ? 'ready' : 'empty',
      items,
      offset,
      nextOffset: items.length === RECEIPT_RECONCILIATION_PAGE_LIMIT
        ? offset + RECEIPT_RECONCILIATION_PAGE_LIMIT
        : null,
      unavailableReason: null,
    });
  }

  async get(reviewId: string): Promise<PaymentReviewItem> {
    if (!this.config) throw new ReceiptReconciliationAdapterError('owl_not_configured', 'OWL receipt reconciliation is not configured.', 503, false);
    const { response, body } = await request(
      this.config,
      `${LIST_PATH}/${encodeURIComponent(reviewId)}`,
    );
    if (!response.ok) {
      throw new ReceiptReconciliationAdapterError(
        upstreamCode(body) ?? 'owl_receipt_read_failed',
        'OWL receipt reconciliation item could not be loaded.',
        response.status === 404 ? 404 : 502,
        response.status >= 500,
      );
    }
    return normalizeItem(this.config, body);
  }

  async act(
    reviewId: string,
    input: PaymentReviewActionRequest,
    idempotencyKey: string,
  ): Promise<PaymentReviewActionResult> {
    if (!this.config) throw new ReceiptReconciliationAdapterError('owl_not_configured', 'OWL receipt reconciliation is not configured.', 503, false);
    const action = paymentReviewActionRequestSchema.parse(input);
    const owlBody = {
      contract_version: RECEIPT_RECONCILIATION_CONTRACT_VERSION,
      action: action.action,
      expected_revision: action.expectedRevision,
      idempotency_key: idempotencyKey,
      ...(action.evidenceId ? { evidence_id: action.evidenceId } : {}),
      ...(action.replacementEvidenceId ? { replacement_evidence_id: action.replacementEvidenceId } : {}),
      ...(action.allocatedAmountMinor !== undefined ? { allocated_amount_minor: action.allocatedAmountMinor } : {}),
      ...(action.deferUntil ? { defer_until: action.deferUntil } : {}),
      ...(action.note ? { note: action.note } : {}),
    };
    const { response, body } = await request(
      this.config,
      `${LIST_PATH}/${encodeURIComponent(reviewId)}/actions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(owlBody),
      },
    );
    if (!response.ok) {
      const code = upstreamCode(body) ?? 'owl_receipt_action_failed';
      const current = response.status === 409
        ? await this.get(reviewId).catch(() => null)
        : null;
      throw new ReceiptReconciliationAdapterError(
        code,
        response.status === 409
          ? 'This receipt review changed in OWL. The current state has been loaded.'
          : 'OWL could not apply the receipt review action.',
        response.status === 409 ? 409 : response.status >= 500 ? 502 : response.status,
        response.status >= 500,
        current,
      );
    }
    const result = wireActionResult.parse(body);
    if (!result.authoritative_read_back || result.case.id !== reviewId || result.action !== action.action) {
      throw new ReceiptReconciliationAdapterError('invalid_owl_correlation', 'OWL returned an invalid action acknowledgement.', 502, false);
    }
    const acknowledged = normalizeItem(this.config, result.case);
    const readBack = await this.get(reviewId);
    if (readBack.revision !== acknowledged.revision || readBack.state !== acknowledged.state) {
      throw new ReceiptReconciliationAdapterError(
        'authoritative_readback_failed',
        'OWL acknowledged the action, but its authoritative state could not be verified.',
        502,
        true,
        readBack,
      );
    }
    return paymentReviewActionResultSchema.parse({
      contractVersion: result.contract_version,
      action: result.action,
      item: readBack,
      sourceAcknowledgement: result.source_acknowledgement,
      authoritativeReadBack: true,
      idempotent: result.idempotent,
    });
  }

  async deliverAttention(
    reviewId: string,
    expectedRevision: number,
    attentionDeliveryRef: string,
  ): Promise<PaymentReviewActionResult> {
    if (!this.config) {
      throw new ReceiptReconciliationAdapterError(
        'owl_not_configured',
        'OWL receipt reconciliation is not configured.',
        503,
        false,
      );
    }
    const idempotencyKey = `mc:attention:${reviewId}:${expectedRevision}`;
    const { response, body } = await request(
      this.config,
      `${LIST_PATH}/${encodeURIComponent(reviewId)}/actions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_version: RECEIPT_RECONCILIATION_CONTRACT_VERSION,
          action: 'deliver_attention',
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
          attention_delivery_ref: attentionDeliveryRef,
        }),
      },
    );
    if (!response.ok) {
      throw new ReceiptReconciliationAdapterError(
        upstreamCode(body) ?? 'owl_attention_delivery_failed',
        'OWL could not record Mission Control attention delivery.',
        response.status === 409 ? 409 : response.status >= 500 ? 502 : response.status,
        response.status >= 500 || response.status === 409,
      );
    }
    const result = wireActionResult.parse(body);
    if (
      !result.authoritative_read_back
      || result.case.id !== reviewId
      || result.action !== 'deliver_attention'
    ) {
      throw new ReceiptReconciliationAdapterError(
        'invalid_owl_correlation',
        'OWL returned an invalid attention delivery acknowledgement.',
        502,
        false,
      );
    }
    const acknowledged = normalizeItem(this.config, result.case);
    const readBack = await this.get(reviewId);
    if (
      readBack.revision !== acknowledged.revision
      || readBack.attentionState !== acknowledged.attentionState
    ) {
      throw new ReceiptReconciliationAdapterError(
        'authoritative_readback_failed',
        'OWL acknowledged attention delivery, but its authoritative state could not be verified.',
        502,
        true,
        readBack,
      );
    }
    return paymentReviewActionResultSchema.parse({
      contractVersion: result.contract_version,
      action: result.action,
      item: readBack,
      sourceAcknowledgement: result.source_acknowledgement,
      authoritativeReadBack: true,
      idempotent: result.idempotent,
    });
  }
}
