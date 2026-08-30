import { beforeEach, describe, expect, it, vi } from 'vitest';

const getHoustonMemorySettings = vi.fn();
const listHoustonMemories = vi.fn();
const queryVectors = vi.fn();
const embed = vi.fn();

vi.mock('@/lib/houston-memory/settings', () => ({ getHoustonMemorySettings }));
vi.mock('@/lib/houston-memory/service', () => ({ listHoustonMemories }));
vi.mock('@/lib/semantic-index/runtime', () => ({
  getSemanticIndexRuntime: async () => ({
    repository: {
      getActiveIdentity: async () => ({
        id: 'index-1',
        provider: 'test',
        model: 'test',
        dimensions: 2,
      }),
      queryVectors,
    },
    embeddings: { embed },
    config: { embeddingTimeoutMs: 100 },
  }),
}));

const memory = {
  id: '11111111-1111-4111-8111-111111111111',
  authorizationScope: 'installation',
  title: 'Release planning',
  summary: 'Use a staged rollout.',
  decisions: ['Ship Friday'],
  commitments: [],
  topics: ['release'],
  linkedEntities: [],
  sensitivity: 'restricted',
  retainUntil: '2026-06-01T00:00:00.000Z',
  excludedAt: null,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

describe('Houston memory retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHoustonMemorySettings.mockResolvedValue({ enabled: true, retentionDays: 90 });
    listHoustonMemories.mockResolvedValue([memory]);
  });

  it('applies authorization metadata before vector scoring', async () => {
    embed.mockResolvedValue({ status: 'ok', embedding: new Float32Array([1, 0]) });
    queryVectors.mockResolvedValue({
      results: [{ entityId: memory.id, score: 0.8 }],
      scan: { truncated: false },
    });
    const { retrieveHoustonMemories } = await import('@/lib/houston-memory/retrieval');
    const result = await retrieveHoustonMemories({ query: 'release' });

    expect(queryVectors).toHaveBeenCalledWith(expect.objectContaining({
      entityTypes: ['houston-summary'],
      metadataFilters: [{
        keys: ['authorizationScope'],
        match: 'any',
        values: ['installation'],
      }],
    }));
    expect(result.state).toBe('ready');
    expect(result.results).toHaveLength(1);
  });

  it('degrades to bounded keyword retrieval on provider failure', async () => {
    embed.mockResolvedValue({ status: 'retryable', reason: 'offline' });
    const { retrieveHoustonMemories } = await import('@/lib/houston-memory/retrieval');
    const result = await retrieveHoustonMemories({ query: 'staged rollout' });

    expect(result.state).toBe('keyword-only');
    expect(result.results[0]?.id).toBe(memory.id);
    expect(queryVectors).not.toHaveBeenCalled();
  });

  it('does not inspect retained data while the independent gate is off', async () => {
    getHoustonMemorySettings.mockResolvedValue({ enabled: false, retentionDays: 90 });
    const { retrieveHoustonMemories } = await import('@/lib/houston-memory/retrieval');
    const result = await retrieveHoustonMemories({ query: 'release' });

    expect(result).toEqual({ state: 'disabled', results: [], truncated: false });
    expect(listHoustonMemories).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });
});
