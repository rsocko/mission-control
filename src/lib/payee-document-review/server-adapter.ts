import 'server-only';

import { z } from 'zod';
import type {
  PayeeDocumentReviewDecision,
  PayeeDocumentReviewDecisionResult,
  PayeeDocumentReviewItem,
  PayeeDocumentReviewSnapshot,
} from './contract';

export interface PayeeDocumentReviewAdapter {
  load(): Promise<PayeeDocumentReviewSnapshot>;
  decide(decision: PayeeDocumentReviewDecision): Promise<PayeeDocumentReviewDecisionResult>;
}

export class PayeeDocumentReviewAdapterUnavailableError extends Error {
  readonly code = 'payee_document_review_adapter_unavailable';
}

export class PayeeDocumentReviewUpstreamError extends Error {
  readonly source = 'owl';

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const classificationSchema = z.enum([
  'recurring-fixed',
  'recurring-variable',
  'regular',
  'infrequent',
  'single-observation',
  'unknown',
]);

const observationWindowSchema = z.union([
  z.object({
    first_observed_on: z.string().min(1),
    last_observed_on: z.string().min(1),
  }).transform((value) => ({
    firstObservedOn: value.first_observed_on,
    lastObservedOn: value.last_observed_on,
  })),
  z.object({
    firstObservedOn: z.string().min(1),
    lastObservedOn: z.string().min(1),
  }),
]);

const intervalEvidenceSchema = z.union([
  z.object({
    sample_count: z.number().int().nonnegative(),
    median_days: z.number().nonnegative(),
    minimum_days: z.number().nonnegative(),
    maximum_days: z.number().nonnegative(),
  }).transform((value) => ({
    sampleCount: value.sample_count,
    medianDays: value.median_days,
    minimumDays: value.minimum_days,
    maximumDays: value.maximum_days,
  })),
  z.object({
    sampleCount: z.number().int().nonnegative(),
    medianDays: z.number().nonnegative(),
    minimumDays: z.number().nonnegative(),
    maximumDays: z.number().nonnegative(),
  }),
]).nullable();

const provenanceSchema = z.union([
  z.object({
    transaction_history: z.literal(true),
    monarch_recurring: z.boolean(),
  }).transform((value) => ({
    transactionHistory: value.transaction_history,
    monarchRecurring: value.monarch_recurring,
  })),
  z.object({
    transactionHistory: z.literal(true),
    monarchRecurring: z.boolean(),
  }),
]);

const owlMappingSchema = z.object({
  account_candidate_id: z.string().nullable(),
  correspondent_id: z.number().int().positive(),
});

const owlReviewSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
  display_hint: z.string().min(1),
  classification: classificationSchema,
  observation_count: z.number().int().nonnegative(),
  observation_window: observationWindowSchema,
  interval_evidence: intervalEvidenceSchema,
  confidence: z.number().min(0).max(1).nullable(),
  basis: z.array(z.string()),
  provenance: provenanceSchema,
  monarch_confirmed_recurring: z.object({
    active: z.boolean(),
    cadence: z.string().nullable(),
  }).nullable(),
  source_as_of: z.string().min(1),
  review_status: z.string(),
  document_decision: z.enum([
    'unknown',
    'documents_expected',
    'no_documents_expected',
  ]),
  mappings: z.array(owlMappingSchema),
  expectation_ids: z.array(z.string()),
  notes: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  owl_deep_link: z.string().url().nullable(),
}).passthrough();

const owlReviewsSchema = z.array(owlReviewSchema);

const owlCorrespondentsSchema = z.array(z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  lifecycle_status: z.string(),
  owl_deep_link: z.string().url().nullable(),
}));

type OwlReview = z.infer<typeof owlReviewSchema>;
type OwlCorrespondent = z.infer<typeof owlCorrespondentsSchema>[number];

const OWL_PAGE_LIMIT = 100;
const MAX_OWL_RESULTS = 5_000;

interface AdapterConfiguration {
  owlBaseUrl: URL;
  owlToken: string;
}

function approvedUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const localHttp = url.protocol === 'http:'
    && (hostname === 'localhost' || hostname === '127.0.0.1');
  if (
    (!localHttp && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error('OWL_MISSION_CONTROL_URL must be an approved HTTPS or local HTTP URL');
  }
  return url;
}

function configuration(): AdapterConfiguration | null {
  const owlBaseUrl = process.env.OWL_MISSION_CONTROL_URL?.trim();
  const owlToken = process.env.OWL_MISSION_CONTROL_API_TOKEN?.trim();
  if (!owlBaseUrl || !owlToken) return null;

  const normalizedOwlBaseUrl = approvedUrl(owlBaseUrl);
  normalizedOwlBaseUrl.pathname = normalizedOwlBaseUrl.pathname.replace(/\/+$/, '') + '/';
  normalizedOwlBaseUrl.search = '';

  return {
    owlBaseUrl: normalizedOwlBaseUrl,
    owlToken,
  };
}

async function fetchJson(
  url: URL,
  token: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (error) {
    if (
      error instanceof TypeError
      || (error instanceof DOMException && error.name === 'TimeoutError')
    ) {
      throw new PayeeDocumentReviewUpstreamError('OWL could not be reached.');
    }
    throw error;
  }
  if (!response.ok) {
    throw new PayeeDocumentReviewUpstreamError(
      `OWL returned ${response.status}.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error('OWL returned invalid JSON', { cause: error });
  }
}

function owlUrl(config: AdapterConfiguration, pathname: string): URL {
  return new URL(pathname.replace(/^\//, ''), config.owlBaseUrl);
}

async function fetchOwlPages<T>(
  config: AdapterConfiguration,
  pathname: string,
  schema: z.ZodType<T[]>,
): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; offset < MAX_OWL_RESULTS; offset += OWL_PAGE_LIMIT) {
    const url = owlUrl(config, pathname);
    url.searchParams.set('limit', String(OWL_PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));
    const page = schema.parse(await fetchJson(url, config.owlToken));
    items.push(...page);
    if (page.length < OWL_PAGE_LIMIT) return items;
  }
  throw new Error(`OWL ${pathname} exceeded the ${MAX_OWL_RESULTS} item safety limit`);
}

function fetchOwlReviews(config: AdapterConfiguration): Promise<OwlReview[]> {
  return fetchOwlPages(
    config,
    '/api/mc/v1/payee-document-reviews?status=all',
    owlReviewsSchema,
  );
}

function fetchOwlCorrespondents(
  config: AdapterConfiguration,
): Promise<OwlCorrespondent[]> {
  return fetchOwlPages(
    config,
    '/api/mc/v1/correspondents',
    owlCorrespondentsSchema,
  );
}

function normalizeItem(
  review: OwlReview,
  correspondentNames: ReadonlyMap<number, string>,
): PayeeDocumentReviewItem {
  const firstMapping = review.mappings[0];
  const status = review.document_decision === 'no_documents_expected'
    ? 'not-expected'
    : firstMapping
      ? 'mapped'
      : 'unreviewed';

  return {
    candidateId: review.id,
    pattern: {
      displayName: review.display_hint,
      activity: review.active ? 'active' : 'inactive',
      classification: review.classification,
      observationCount: review.observation_count,
      observationWindow: review.observation_window,
      intervalEvidence: review.interval_evidence,
      confidence: review.confidence,
      basis: review.basis,
      provenance: review.provenance,
      monarchConfirmedRecurring: review.monarch_confirmed_recurring,
    },
    documentPolicy: {
      status,
      correspondentRef: firstMapping ? String(firstMapping.correspondent_id) : null,
      correspondentName: firstMapping
        ? correspondentNames.get(firstMapping.correspondent_id) ?? null
        : null,
      expectationSummary: review.notes,
      owlPolicyUrl: review.owl_deep_link,
    },
  };
}

async function loadSnapshot(
  config: AdapterConfiguration,
): Promise<PayeeDocumentReviewSnapshot> {
  const [reviews, correspondents] = await Promise.all([
    fetchOwlReviews(config),
    fetchOwlCorrespondents(config),
  ]);
  const correspondentNames = new Map(
    correspondents.map((correspondent) => [correspondent.id, correspondent.name]),
  );
  const activeReviews = reviews.filter((review) => review.active);
  const sourceAsOf = activeReviews.reduce<string | null>(
    (latest, review) => !latest || review.source_as_of > latest
      ? review.source_as_of
      : latest,
    null,
  );

  return {
    contractVersion: '1',
    state: activeReviews.length > 0 ? 'ready' : 'empty',
    sourceAsOf,
    items: activeReviews.map((review) => normalizeItem(review, correspondentNames)),
    correspondents: correspondents
      .filter((correspondent) => correspondent.lifecycle_status !== 'inactive')
      .map((correspondent) => ({
        correspondentRef: String(correspondent.id),
        name: correspondent.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    unavailableReason: null,
  };
}

async function currentOwlReview(
  config: AdapterConfiguration,
  candidateId: string,
): Promise<OwlReview> {
  const review = (await fetchOwlReviews(config)).find((item) => item.id === candidateId);
  if (!review) {
    throw new PayeeDocumentReviewUpstreamError(
      'OWL does not have a matching payee review candidate.',
      404,
    );
  }
  return review;
}

function jsonRequest(method: 'PUT' | 'POST', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function createHttpAdapter(config: AdapterConfiguration): PayeeDocumentReviewAdapter {
  return {
    async load() {
      try {
        return await loadSnapshot(config);
      } catch (error) {
        if (error instanceof PayeeDocumentReviewUpstreamError) {
          return {
            contractVersion: '1',
            state: 'unavailable',
            sourceAsOf: null,
            items: [],
            correspondents: [],
            unavailableReason: error.message,
          };
        }
        throw error;
      }
    },

    async decide(decision) {
      const currentReview = await currentOwlReview(config, decision.candidateId);
      const candidatePath = encodeURIComponent(decision.candidateId);
      let updatedReviewPayload: unknown;
      if (decision.decision === 'map-correspondent') {
        const correspondentId = Number(decision.correspondentRef);
        if (!Number.isSafeInteger(correspondentId) || correspondentId <= 0) {
          throw new Error('OWL correspondent identity must be a positive integer');
        }
        updatedReviewPayload = await fetchJson(
          owlUrl(config, `/api/mc/v1/payee-document-reviews/${candidatePath}/mapping`),
          config.owlToken,
          jsonRequest('PUT', {
            mappings: [{
              account_candidate_id: null,
              correspondent_id: correspondentId,
            }],
            expectation_ids: currentReview.expectation_ids,
            notes: currentReview.notes,
          }),
        );
      } else {
        updatedReviewPayload = await fetchJson(
          owlUrl(
            config,
            `/api/mc/v1/payee-document-reviews/${candidatePath}/no-documents-expected`,
          ),
          config.owlToken,
          jsonRequest('POST', {
            mappings: currentReview.mappings,
            notes: currentReview.notes,
          }),
        );
      }

      const updatedReview = owlReviewSchema.parse(updatedReviewPayload);
      if (updatedReview.id !== decision.candidateId) {
        throw new Error('OWL acknowledged a different payee review candidate');
      }
      const firstMapping = updatedReview.mappings[0];
      return {
        candidateId: updatedReview.id,
        acknowledged: true,
        documentPolicy: {
          status: updatedReview.document_decision === 'no_documents_expected'
            ? 'not-expected'
            : firstMapping
              ? 'mapped'
              : 'unreviewed',
          correspondentRef: firstMapping ? String(firstMapping.correspondent_id) : null,
          correspondentName: null,
          expectationSummary: updatedReview.notes,
          owlPolicyUrl: updatedReview.owl_deep_link,
        },
      };
    },
  };
}

const unavailableAdapter: PayeeDocumentReviewAdapter = {
  async load() {
    return {
      contractVersion: '1',
      state: 'unavailable',
      sourceAsOf: null,
      items: [],
      correspondents: [],
      unavailableReason:
        'OWL payee document review is not connected to this Mission Control deployment yet.',
    };
  },

  async decide() {
    throw new PayeeDocumentReviewAdapterUnavailableError(
      'Payee document review decisions are unavailable until OWL is connected.',
    );
  },
};

export function getPayeeDocumentReviewAdapter(): PayeeDocumentReviewAdapter {
  const config = configuration();
  return config ? createHttpAdapter(config) : unavailableAdapter;
}
