import 'server-only';

import { openai } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { createConfiguredAIProvider } from '@/lib/ai/provider-client';
import { loadAIProviderConfiguration } from '@/lib/ai/provider-configuration-service';
import { createConfiguredAIRequestContext } from '@/lib/ai/provider-routing-core';
import {
  FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
  financeVendorResearchResponseSchema,
  type FinanceVendorResearchResponse,
  type TyrionQuickReviewResearchResponse,
} from '@/lib/finance/quick-review-contract';

const SOURCE_LIMIT = 20;
const STATEMENT_LIMIT = 12;
const PROHIBITED_FRAUD_ASSERTION = /\b(frauds?|fraudulent|scams?|theft|stolen|unauthori[sz]ed|compromis(?:e|ed)|criminal)\b/i;

const httpsUrlSchema = z.url().refine((value) => value.startsWith('https://'));
const providerStatementSchema = z.object({
  statement: z.string().trim().min(1).max(400),
  confidence: z.number().min(0).max(1),
  sourceUrls: z.array(httpsUrlSchema).max(10),
}).strict();
const providerOutputSchema = z.object({
  facts: z.array(providerStatementSchema.extend({
    sourceUrls: z.array(httpsUrlSchema).min(1).max(10),
  })).max(STATEMENT_LIMIT),
  inferences: z.array(providerStatementSchema).max(STATEMENT_LIMIT),
  suggestions: z.object({
    businessIdentity: z.string().trim().min(1).max(120).nullable(),
    location: z.string().trim().min(1).max(160).nullable(),
    businessType: z.string().trim().min(1).max(120).nullable(),
    plausiblePurchase: z.string().trim().min(1).max(240).nullable(),
    category: z.string().trim().min(1).max(120).nullable(),
    kidsClues: z.array(z.string().trim().min(1).max(180)).max(8),
  }).strict(),
  riskIndicators: z.array(z.object({
    detail: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
  }).strict()).max(8),
}).strict();

type ProviderOutput = z.infer<typeof providerOutputSchema>;

export interface VendorResearchSource {
  url: string;
  title: string;
}

export interface VendorResearchProviderResult {
  output: ProviderOutput;
  sources: VendorResearchSource[];
}

export interface VendorResearchProvider {
  research(
    prepared: TyrionQuickReviewResearchResponse,
    signal?: AbortSignal,
  ): Promise<VendorResearchProviderResult>;
}

export class VendorResearchError extends Error {
  constructor(
    readonly code:
      | 'vendor_research_provider_unavailable'
      | 'vendor_research_operation_failed'
      | 'vendor_research_policy_violation',
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VendorResearchError';
  }
}

function sourceId(index: number): string {
  return `source-${index + 1}`;
}

function containsFraudAssertion(output: ProviderOutput): boolean {
  const values = [
    ...output.facts.map((item) => item.statement),
    ...output.inferences.map((item) => item.statement),
    ...output.riskIndicators.map((item) => item.detail),
    ...output.suggestions.kidsClues,
    output.suggestions.businessIdentity,
    output.suggestions.location,
    output.suggestions.businessType,
    output.suggestions.plausiblePurchase,
    output.suggestions.category,
  ];
  return values.some((value) => value !== null && PROHIBITED_FRAUD_ASSERTION.test(value));
}

export function enforceVendorResearchPolicy(input: {
  reviewRef: string;
  researchedAt: string;
  prepared: TyrionQuickReviewResearchResponse;
  providerResult: VendorResearchProviderResult;
}): FinanceVendorResearchResponse {
  if (
    !input.prepared.outputPolicy.factsRequireSources
    || !input.prepared.outputPolicy.inferencesMustBeLabeled
    || input.prepared.outputPolicy.fraudAssertionAllowed
  ) {
    throw new VendorResearchError(
      'vendor_research_policy_violation',
      'Tyrion returned an unsupported vendor research output policy',
      502,
      false,
    );
  }
  const parsedOutput = providerOutputSchema.safeParse(input.providerResult.output);
  if (!parsedOutput.success) {
    throw new VendorResearchError(
      'vendor_research_policy_violation',
      'Vendor research returned an invalid structured result',
      502,
      false,
    );
  }
  const output = parsedOutput.data;
  if (containsFraudAssertion(output)) {
    throw new VendorResearchError(
      'vendor_research_policy_violation',
      'Vendor research violated the no-fraud-assertion policy',
      502,
      false,
    );
  }
  const uniqueSources = new Map<string, VendorResearchSource>();
  for (const source of input.providerResult.sources) {
    const url = httpsUrlSchema.safeParse(source.url);
    if (url.success && !uniqueSources.has(url.data) && uniqueSources.size < SOURCE_LIMIT) {
      uniqueSources.set(url.data, { url: url.data, title: source.title.trim() || url.data });
    }
  }
  const sources = [...uniqueSources.values()].map((source, index) => ({
    id: sourceId(index),
    title: source.title.slice(0, 200),
    url: source.url,
    publisher: new URL(source.url).hostname.replace(/^www\./, '').slice(0, 120),
  }));
  const idByUrl = new Map(sources.map((source) => [source.url, source.id]));
  const mapStatement = (statement: ProviderOutput['facts'][number]) => {
    const sourceIds = [...new Set(statement.sourceUrls.map((url) => idByUrl.get(url)))];
    if (sourceIds.some((id) => id === undefined)) {
      throw new VendorResearchError(
        'vendor_research_policy_violation',
        'Vendor research cited a source that was not returned by the provider',
        502,
        false,
      );
    }
    return {
      statement: statement.statement,
      confidence: statement.confidence,
      sourceIds: sourceIds as string[],
    };
  };
  const facts = output.facts.map(mapStatement);
  if (facts.some((fact) => fact.sourceIds.length === 0)) {
    throw new VendorResearchError(
      'vendor_research_policy_violation',
      'Vendor research facts require sources',
      502,
      false,
    );
  }
  const response = {
    contractVersion: FINANCE_QUICK_REVIEW_CONTRACT_VERSION,
    reviewRef: input.reviewRef,
    researchedAt: input.researchedAt,
    facts,
    inferences: output.inferences.map(mapStatement),
    suggestions: output.suggestions,
    riskIndicators: output.riskIndicators.map((indicator) => ({
      label: 'Needs investigation' as const,
      detail: indicator.detail,
      confidence: indicator.confidence,
    })),
    sources,
  };
  const parsed = financeVendorResearchResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new VendorResearchError(
      'vendor_research_policy_violation',
      'Vendor research returned an invalid bounded response',
      502,
      false,
    );
  }
  return parsed.data;
}

export class OpenAIWebSearchVendorResearchProvider implements VendorResearchProvider {
  async research(
    prepared: TyrionQuickReviewResearchResponse,
    signal?: AbortSignal,
  ): Promise<VendorResearchProviderResult> {
    const configuration = await loadAIProviderConfiguration();
    const { resolved, routingPolicy } = configuration;
    if (!resolved.configured || resolved.provider !== 'openai') {
      throw new VendorResearchError(
        'vendor_research_provider_unavailable',
        'Vendor research requires the configured OpenAI provider with Responses web search support',
        503,
        false,
      );
    }
    const context = createConfiguredAIRequestContext(
      routingPolicy,
      'finance-vendor-research',
      { sensitivityOverride: 'standard' },
    );
    const provider = createConfiguredAIProvider(resolved, context);
    const location = prepared.query.coarseLocation;
    try {
      const result = await generateText({
        model: provider.responses(resolved.model),
        output: Output.object({ schema: providerOutputSchema }),
        tools: {
          web_search: openai.tools.webSearch({
            externalWebAccess: true,
            searchContextSize: 'medium',
            ...(location ? {
              userLocation: {
                type: 'approximate',
                ...(location.countryCode ? { country: location.countryCode } : {}),
                ...(location.locality ? { city: location.locality } : {}),
                ...(location.region ? { region: location.region } : {}),
              },
            } : {}),
          }),
        },
        toolChoice: 'required',
        system: `Research a vendor using public web sources.
Return sourced facts separately from clearly labeled inferences.
Every fact must cite at least one exact HTTPS source URL returned by web search.
Never assert fraud, scams, theft, or unauthorized activity. Use only neutral Needs investigation details.
Do not infer or mention account, card, household, child, transaction ID, or transaction history data.
Return only the requested structured output.`,
        prompt: JSON.stringify(prepared.query),
        maxOutputTokens: 2_500,
        maxRetries: 1,
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
          : AbortSignal.timeout(45_000),
      });
      return {
        output: result.output,
        sources: result.sources
          .filter((source) => source.sourceType === 'url')
          .map((source) => ({ url: source.url, title: source.title ?? source.url })),
      };
    } catch (error) {
      if (error instanceof VendorResearchError) throw error;
      throw new VendorResearchError(
        'vendor_research_operation_failed',
        'Configured vendor research provider failed',
        502,
        true,
      );
    }
  }
}

export async function researchVendor(input: {
  reviewRef: string;
  prepared: TyrionQuickReviewResearchResponse;
  signal?: AbortSignal;
  provider?: VendorResearchProvider;
  clock?: () => Date;
}): Promise<FinanceVendorResearchResponse> {
  const provider = input.provider ?? new OpenAIWebSearchVendorResearchProvider();
  const providerResult = await provider.research(input.prepared, input.signal);
  return enforceVendorResearchPolicy({
    reviewRef: input.reviewRef,
    researchedAt: (input.clock ?? (() => new Date()))().toISOString(),
    prepared: input.prepared,
    providerResult,
  });
}
