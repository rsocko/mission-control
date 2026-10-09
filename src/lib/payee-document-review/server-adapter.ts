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
  constructor(
    readonly source: 'tyrion' | 'owl',
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const tyrionProjectionSchema = z.object({
  contractVersion: z.literal('1'),
  connectorRef: z.string().min(1),
  sourceGeneration: z.string().min(1),
  sourceAsOf: z.string().min(1),
  completeness: z.string(),
  payees: z.array(z.object({
    payeeRef: z.string().min(1),
    displayName: z.string().min(1),
    activity: z.enum(['active', 'inactive', 'unknown']),
    classification: z.enum([
      'recurring-fixed',
      'recurring-variable',
      'regular',
      'infrequent',
      'single-observation',
      'unknown',
    ]),
    observationCount: z.number().int().nonnegative(),
    observationWindow: z.object({
      firstObservedOn: z.string().min(1),
      lastObservedOn: z.string().min(1),
    }),
    intervalEvidence: z.object({
      sampleCount: z.number().int().nonnegative(),
      medianDays: z.number().nonnegative(),
      minimumDays: z.number().nonnegative(),
      maximumDays: z.number().nonnegative(),
    }).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    basis: z.array(z.string()),
    provenance: z.object({
      transactionHistory: z.literal(true),
      monarchRecurring: z.boolean(),
    }),
    monarchConfirmedRecurring: z.object({
      active: z.boolean(),
      cadence: z.string().nullable(),
    }).nullable(),
  })),
});

const owlMappingSchema = z.object({
  account_candidate_id: z.string().nullable(),
  correspondent_id: z.number().int().positive(),
});

const owlReviewSchema = z.object({
  id: z.string().min(1),
  active: z.boolean(),
  display_hint: z.string(),
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

type TyrionProjection = z.infer<typeof tyrionProjectionSchema>;
type OwlReview = z.infer<typeof owlReviewSchema>;
type OwlCorrespondent = z.infer<typeof owlCorrespondentsSchema>[number];

const OWL_PAGE_LIMIT = 100;
const MAX_OWL_RESULTS = 5_000;

interface AdapterConfiguration {
  tyrionProjectionUrl: URL;
  tyrionToken: string;
  owlBaseUrl: URL;
  owlToken: string;
}

function approvedUrl(value: string, name: string): URL {
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
    throw new Error(`${name} must be an approved HTTPS or local HTTP URL`);
  }
  return url;
}

function configuration(): AdapterConfiguration | null {
  const tyrionProjectionUrl = process.env.TYRION_PAYEE_PATTERN_API_URL?.trim();
  const tyrionToken = process.env.TYRION_PAYEE_PATTERN_API_TOKEN?.trim();
  const owlBaseUrl = process.env.OWL_MISSION_CONTROL_URL?.trim();
  const owlToken = process.env.OWL_MISSION_CONTROL_API_TOKEN?.trim();
  if (!tyrionProjectionUrl || !tyrionToken || !owlBaseUrl || !owlToken) return null;

  const normalizedOwlBaseUrl = approvedUrl(owlBaseUrl, 'OWL_MISSION_CONTROL_URL');
  normalizedOwlBaseUrl.pathname = normalizedOwlBaseUrl.pathname.replace(/\/+$/, '') + '/';
  normalizedOwlBaseUrl.search = '';

  return {
    tyrionProjectionUrl: approvedUrl(
      tyrionProjectionUrl,
      'TYRION_PAYEE_PATTERN_API_URL',
    ),
    tyrionToken,
    owlBaseUrl: normalizedOwlBaseUrl,
    owlToken,
  };
}

async function fetchJson(
  source: PayeeDocumentReviewUpstreamError['source'],
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
      throw new PayeeDocumentReviewUpstreamError(
        source,
        `${source === 'tyrion' ? 'Tyrion' : 'OWL'} could not be reached.`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw new PayeeDocumentReviewUpstreamError(
      source,
      `${source === 'tyrion' ? 'Tyrion' : 'OWL'} returned ${response.status}.`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `${source === 'tyrion' ? 'Tyrion' : 'OWL'} returned invalid JSON`,
      { cause: error },
    );
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
    const page = schema.parse(await fetchJson('owl', url, config.owlToken));
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

async function loadSources(config: AdapterConfiguration): Promise<{
  tyrion: TyrionProjection;
  owlReviews: OwlReview[];
  correspondents: OwlCorrespondent[];
}> {
  const [tyrionPayload, owlReviewsPayload, correspondentsPayload] = await Promise.all([
    fetchJson('tyrion', config.tyrionProjectionUrl, config.tyrionToken),
    fetchOwlReviews(config),
    fetchOwlCorrespondents(config),
  ]);

  return {
    tyrion: tyrionProjectionSchema.parse(tyrionPayload),
    owlReviews: owlReviewsPayload,
    correspondents: correspondentsPayload,
  };
}

function normalizeItem(
  payee: TyrionProjection['payees'][number],
  review: OwlReview | undefined,
  correspondentNames: ReadonlyMap<number, string>,
): PayeeDocumentReviewItem {
  const firstMapping = review?.mappings[0];
  const status = !review
    ? 'unreviewed'
    : review.document_decision === 'no_documents_expected'
      ? 'not-expected'
      : firstMapping
        ? 'mapped'
        : 'unreviewed';

  return {
    candidateId: payee.payeeRef,
    pattern: payee,
    documentPolicy: {
      status,
      correspondentRef: firstMapping ? String(firstMapping.correspondent_id) : null,
      correspondentName: firstMapping
        ? correspondentNames.get(firstMapping.correspondent_id) ?? null
        : null,
      expectationSummary: review?.notes ?? null,
      owlPolicyUrl: review?.owl_deep_link ?? null,
    },
  };
}

async function loadSnapshot(
  config: AdapterConfiguration,
): Promise<PayeeDocumentReviewSnapshot> {
  const { tyrion, owlReviews, correspondents } = await loadSources(config);
  const reviewsById = new Map(owlReviews.map((review) => [review.id, review]));
  const correspondentNames = new Map(
    correspondents.map((correspondent) => [correspondent.id, correspondent.name]),
  );
  const items = tyrion.payees
    .filter((payee) => payee.activity !== 'inactive')
    .map((payee) => normalizeItem(
      payee,
      reviewsById.get(payee.payeeRef),
      correspondentNames,
    ));

  return {
    contractVersion: '1',
    state: items.length > 0 ? 'ready' : 'empty',
    sourceAsOf: tyrion.sourceAsOf,
    items,
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
      'owl',
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
          'owl',
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
          'owl',
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
        'Tyrion payee patterns and OWL document policy are not connected to this Mission Control deployment yet.',
    };
  },

  async decide() {
    throw new PayeeDocumentReviewAdapterUnavailableError(
      'Payee document review decisions are unavailable until the OWL policy adapter is connected.',
    );
  },
};

export function getPayeeDocumentReviewAdapter(): PayeeDocumentReviewAdapter {
  const config = configuration();
  return config ? createHttpAdapter(config) : unavailableAdapter;
}
