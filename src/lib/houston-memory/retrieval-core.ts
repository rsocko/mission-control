/**
 * Pure ranking/tokenization algorithm for Houston memory retrieval, plus a
 * clean orchestration entry point that fetches candidates and semantic ranks
 * through backend-neutral seams only.
 *
 * `src/lib/houston-memory/retrieval.ts` implements the same fusion algorithm
 * but is out of scope for this change (it is not in the approved edit cap)
 * and does not export its scoring primitives, so they cannot be imported here
 * without editing it. This module intentionally mirrors that algorithm
 * (identical tokenizer, identical rank-fusion formula) so both call sites
 * behave identically, while staying reachable without ever importing the
 * tainted `@/lib/semantic-index/runtime` module: semantic ranking here goes
 * through the clean, runtime-registered `@/lib/search/semantic` seam instead
 * (the same underlying repository/embeddings, wired at runtime rather than
 * imported at module-eval time).
 */

import type { HoustonConversationMemory, HoustonMemoryEntityLink } from './contracts';
import { HOUSTON_MEMORY_SCOPE } from './contracts';
import { listHoustonMemories } from './service';
import { getHoustonMemorySettings } from './settings';
import { getSemanticSearchRuntime } from '@/lib/search/semantic';
import { resolveSemanticWorkerConfig } from '@/lib/semantic-index/worker-config';

const MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 500;
const MAX_KEYWORD_CANDIDATES = 100;

export type HoustonMemoryRetrievalState = 'disabled' | 'keyword-only' | 'unavailable' | 'ready';

export interface HoustonMemoryRetrievalResult {
  id: string;
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  updatedAt: string;
  retainUntil: string;
  sourceUrl: string;
  linkedEntities: Array<HoustonMemoryEntityLink & { url: string }>;
  relevance: number;
}

export interface HoustonMemoryRetrievalResponse {
  state: HoustonMemoryRetrievalState;
  results: HoustonMemoryRetrievalResult[];
  truncated: boolean;
  reason?: string;
}

export function tokenizeHoustonMemoryQuery(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 32);
}

function memoryText(memory: HoustonConversationMemory): string {
  return [
    memory.title,
    memory.summary,
    ...memory.decisions,
    ...memory.commitments,
    ...memory.topics,
  ].join(' ').toLocaleLowerCase();
}

function linkUrl(link: HoustonMemoryEntityLink): string {
  const id = encodeURIComponent(link.id);
  if (link.type === 'task') return `/tasks/${id}`;
  if (link.type === 'project') return `/projects/${id}`;
  return `/tags/${id}`;
}

function toResult(memory: HoustonConversationMemory, relevance: number): HoustonMemoryRetrievalResult {
  return {
    id: memory.id,
    title: memory.title,
    summary: memory.summary,
    decisions: memory.decisions,
    commitments: memory.commitments,
    topics: memory.topics,
    updatedAt: memory.updatedAt,
    retainUntil: memory.retainUntil,
    sourceUrl: `/ai?memory=${encodeURIComponent(memory.id)}`,
    linkedEntities: memory.linkedEntities.map((link) => ({ ...link, url: linkUrl(link) })),
    relevance,
  };
}

/**
 * Pure keyword+semantic rank fusion: identical formula to
 * `src/lib/houston-memory/retrieval.ts` (reciprocal-rank fusion at k=60).
 */
export function fuseHoustonMemoryRanks(input: {
  memories: HoustonConversationMemory[];
  keywordRanks: Map<string, number>;
  semanticRanks: Map<string, number>;
}): HoustonMemoryRetrievalResult[] {
  const byId = new Map(input.memories.map((memory) => [memory.id, memory]));
  const ids = new Set([...input.keywordRanks.keys(), ...input.semanticRanks.keys()]);
  return [...ids]
    .map((id) => {
      const memory = byId.get(id);
      if (!memory) return null;
      const keywordRank = input.keywordRanks.get(id);
      const semanticRank = input.semanticRanks.get(id);
      const relevance = (keywordRank ? 1 / (60 + keywordRank) : 0)
        + (semanticRank ? 1 / (60 + semanticRank) : 0);
      return toResult(memory, relevance);
    })
    .filter((result): result is HoustonMemoryRetrievalResult => result !== null)
    .sort((a, b) => b.relevance - a.relevance || b.updatedAt.localeCompare(a.updatedAt));
}

function keywordRanksFor(
  memories: HoustonConversationMemory[],
  queryTokens: string[],
): Map<string, number> {
  const matches: Array<{ id: string; score: number; updatedAt: string }> = [];
  for (const memory of memories) {
    const text = memoryText(memory);
    const hits = queryTokens.filter((token) => text.includes(token)).length;
    if (hits > 0) {
      matches.push({ id: memory.id, score: hits / Math.max(queryTokens.length, 1), updatedAt: memory.updatedAt });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return new Map(matches.map((match, index) => [match.id, index + 1]));
}

/**
 * Clean orchestration entry point for the `recall_houston_memory` tool.
 * Fetches candidate memories through the backend-neutral persistence-runtime
 * seam (`service.ts`) and, when available, folds in semantic ranks resolved
 * through the clean `@/lib/search/semantic` runtime slot — never the tainted
 * `@/lib/semantic-index/runtime` module.
 */
export async function retrieveHoustonMemoriesCore(input: {
  query: string;
  limit?: number;
  excludeConversationId?: string;
  now?: string;
}): Promise<HoustonMemoryRetrievalResponse> {
  const settings = await getHoustonMemorySettings();
  if (!settings.enabled) return { state: 'disabled', results: [], truncated: false };

  const query = input.query.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return { state: 'unavailable', results: [], truncated: false, reason: 'empty-query' };

  const now = input.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), MAX_RESULTS);
  let memories: HoustonConversationMemory[];
  try {
    memories = (await listHoustonMemories({
      limit: MAX_KEYWORD_CANDIDATES,
      now,
    })).filter((memory) => memory.id !== input.excludeConversationId);
  } catch {
    return { state: 'unavailable', results: [], truncated: false, reason: 'memory-store-unavailable' };
  }

  const queryTokens = tokenizeHoustonMemoryQuery(query);
  const keywordRanks = keywordRanksFor(memories, queryTokens);

  let semanticRanks = new Map<string, number>();
  let semanticState: HoustonMemoryRetrievalState = 'keyword-only';
  let vectorTruncated = false;
  try {
    const runtime = getSemanticSearchRuntime();
    const { repository, embeddings } = await runtime.resolve();
    const identity = await repository.getActiveIdentity();
    if (identity) {
      const embedded = await embeddings.embed({
        text: query,
        sensitivity: 'restricted',
        expect: {
          provider: identity.provider,
          model: identity.model,
          dimensions: identity.dimensions,
        },
        // Same bound the legacy retrieval path applies, resolved from the
        // pure, backend-neutral worker-config seam (no runtime import).
        timeoutMs: resolveSemanticWorkerConfig([]).embeddingTimeoutMs,
      });
      if (embedded.status === 'ok') {
        const response = await repository.queryVectors({
          queryEmbedding: embedded.embedding,
          limit: MAX_RESULTS * 3,
          entityTypes: ['houston-summary'],
          sensitivities: ['restricted', 'local-only'],
          excludeEntityIds: input.excludeConversationId ? [input.excludeConversationId] : undefined,
          metadataFilters: [{
            keys: ['authorizationScope'],
            match: 'any',
            values: [HOUSTON_MEMORY_SCOPE],
          }],
          now,
        });
        semanticRanks = new Map(response.results.map((result, index) => [result.entityId, index + 1]));
        vectorTruncated = response.scan.truncated;
        semanticState = 'ready';
      }
    }
  } catch {
    semanticState = 'keyword-only';
  }

  const ranked = fuseHoustonMemoryRanks({ memories, keywordRanks, semanticRanks });

  return {
    state: semanticState,
    results: ranked.slice(0, limit),
    truncated: ranked.length > limit || memories.length === MAX_KEYWORD_CANDIDATES || vectorTruncated,
  };
}
