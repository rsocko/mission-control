import type { HoustonConversationMemory, HoustonMemoryEntityLink } from './contracts';
import { HOUSTON_MEMORY_SCOPE } from './contracts';
import { listHoustonMemories } from './service';
import { getHoustonMemorySettings } from './settings';
import { getSemanticIndexRuntime } from '@/lib/semantic-index/runtime';

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

function tokenize(value: string): string[] {
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

export async function retrieveHoustonMemories(input: {
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
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const queryTokens = tokenize(query);
  const keywordMatches: Array<{ id: string; score: number; updatedAt: string }> = [];
  for (const memory of memories) {
    const text = memoryText(memory);
    const matches = queryTokens.filter((token) => text.includes(token)).length;
    if (matches > 0) {
      keywordMatches.push({
        id: memory.id,
        score: matches / Math.max(queryTokens.length, 1),
        updatedAt: memory.updatedAt,
      });
    }
  }
  keywordMatches.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  const keywordRanks = new Map(keywordMatches.map((match, index) => [match.id, index + 1]));

  let semanticRanks = new Map<string, number>();
  let semanticState: HoustonMemoryRetrievalState = 'keyword-only';
  let vectorTruncated = false;
  try {
    const runtime = await getSemanticIndexRuntime();
    const identity = await runtime.repository.getActiveIdentity();
    if (identity) {
      const embedded = await runtime.embeddings.embed({
        text: query,
        sensitivity: 'restricted',
        expect: {
          provider: identity.provider,
          model: identity.model,
          dimensions: identity.dimensions,
        },
        timeoutMs: runtime.config.embeddingTimeoutMs,
      });
      if (embedded.status === 'ok') {
        const response = await runtime.repository.queryVectors({
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

  const ids = new Set([...keywordRanks.keys(), ...semanticRanks.keys()]);
  const ranked = [...ids]
    .map((id) => {
      const memory = byId.get(id);
      if (!memory) return null;
      const keywordRank = keywordRanks.get(id);
      const semanticRank = semanticRanks.get(id);
      const relevance = (keywordRank ? 1 / (60 + keywordRank) : 0)
        + (semanticRank ? 1 / (60 + semanticRank) : 0);
      return toResult(memory, relevance);
    })
    .filter((result): result is HoustonMemoryRetrievalResult => result !== null)
    .sort((a, b) => b.relevance - a.relevance || b.updatedAt.localeCompare(a.updatedAt));

  return {
    state: semanticState,
    results: ranked.slice(0, limit),
    truncated: ranked.length > limit || memories.length === MAX_KEYWORD_CANDIDATES || vectorTruncated,
  };
}
