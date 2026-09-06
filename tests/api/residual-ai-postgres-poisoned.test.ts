import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorePersistenceRepositories } from '@/db/persistence/core-repositories';
import type { SemanticIndexRepository } from '@/lib/semantic-index/contracts';
import type { SemanticEmbeddingProvider } from '@/lib/semantic-index/embedding-provider';
import type { SemanticSourcePort } from '@/lib/semantic-index/source/contracts';
import type { InsightsSnapshot } from '@/lib/stats/insights';
import type { TriageItem } from '@/types';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  generateText: vi.fn(async (input: { system?: string; prompt?: string }) => {
    mocks.calls.push('provider-call');
    if (input.system?.includes('productivity analyst')) {
      return {
        text: JSON.stringify({
          observations: [{
            type: 'pattern',
            title: 'Steady delivery',
            description: 'Delivery remained steady.',
          }],
        }),
      };
    }
    if (input.system?.includes('task extraction assistant')) {
      return {
        text: JSON.stringify({
          actions: [{ title: 'Review release notes', confidence: 0.9 }],
        }),
      };
    }
    if (input.system?.includes('key takeaways')) {
      return { text: JSON.stringify(['Keep the rollout staged']) };
    }
    return {
      text: JSON.stringify({
        summary: 'Review the requested changes',
        suggestedAction: 'open_url',
        urgencyBoost: false,
      }),
    };
  }),
  computeInsights: vi.fn(),
  getSourceBreakdown: vi.fn(async () => []),
  getTriageItemById: vi.fn(),
}));

vi.mock('@/db', () => {
  throw new Error('SQLite root must not load after PostgreSQL selection');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema must not load after PostgreSQL selection');
});
vi.mock('better-sqlite3', () => {
  throw new Error('SQLite driver must not load after PostgreSQL selection');
});
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => (model: string) => ({ model }),
}));
vi.mock('ai', () => ({
  generateText: mocks.generateText,
}));
vi.mock('@/lib/stats/insights', () => ({
  computeInsights: mocks.computeInsights,
  getSourceBreakdown: mocks.getSourceBreakdown,
}));
vi.mock('@/lib/stats/delivery', () => ({
  getInclusivePeriodBoundaries: () => ({
    previousPeriodStart: '2026-07-01',
    previousPeriodEnd: '2026-07-30',
  }),
}));
vi.mock('@/lib/triage/query', () => ({
  getTriageItemById: mocks.getTriageItemById,
}));
vi.mock('@/lib/triage/credentials', () => ({
  resolveGitHubCredentials: vi.fn(async () => ({ token: 'test-token' })),
}));

const snapshot = {
  period: 30,
  periodStart: '2026-08-01',
  periodEnd: '2026-08-30',
  kpis: {
    completed: { label: 'Completed', value: 4, unit: 'tasks' },
    created: { label: 'Created', value: 4, unit: 'tasks' },
    netChange: { label: 'Net change', value: 0, unit: 'tasks' },
    avgTaskAge: { label: 'Average age', value: 2, unit: 'days' },
    streak: { label: 'Streak', value: 2, unit: 'days' },
  },
  trends: [],
  sourceBreakdown: [],
  taskAge: [],
  planningFriction: {
    signalsInPeriod: 0,
    affectedTaskCount: 0,
    pushesInPeriod: 0,
    pushedTaskCount: 0,
    missedCommitments: 0,
    elapsedBlocks: 0,
    overdueTransitions: 0,
    snoozeExtensions: 0,
    totalDaysDeferred: 0,
    averageDaysPerPush: 0,
    topTasks: [],
    topLists: [],
    topTags: [],
  },
} as InsightsSnapshot;

const triageItem = {
  id: 'triage-1',
  sourcePlatform: 'github',
  sourceId: 'github:triage-1',
  sourceUrl: 'https://example.test/item',
  canonicalUrl: 'https://example.test/item',
  title: 'Review release notes',
  description: 'Keep the rollout staged.',
  capturedAt: '2026-09-06T12:00:00.000Z',
  ingestedAt: '2026-09-06T12:00:00.000Z',
  status: 'pending',
  contentType: 'article',
  aiSummary: 'Keep the rollout staged.',
  aiCategories: ['development'],
  aiSuggestedActions: [],
  aiRelevanceScore: 80,
  aiUrgency: 'soon',
  rawMetadata: {},
  actionsTaken: [],
} as TriageItem;

function coreRepositories(): CorePersistenceRepositories {
  return {
    tasks: {} as CorePersistenceRepositories['tasks'],
    projects: {} as CorePersistenceRepositories['projects'],
    connectors: {} as CorePersistenceRepositories['connectors'],
    notifications: {} as CorePersistenceRepositories['notifications'],
    houstonMemories: {} as CorePersistenceRepositories['houstonMemories'],
    settings: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      getMany: vi.fn(async () => {
        mocks.calls.push('settings-read');
        return {
          ai_provider_config: {
            provider: 'ollama',
            model: 'test-model',
            baseUrl: 'http://localhost:11434/v1',
          },
          ai_routing_policy: null,
        };
      }),
      setMany: vi.fn(async () => undefined),
      getActiveEmbeddingIdentity: vi.fn(async () => null),
      listSmartScoreSettings: vi.fn(async () => ({})),
      setSmartScoreSetting: vi.fn(async () => undefined),
    },
  };
}

describe('residual AI PostgreSQL boundary with poisoned SQLite', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    resetProcessRuntimeRegistries();
    mocks.calls.length = 0;
    mocks.computeInsights.mockResolvedValue(snapshot);
    mocks.getTriageItemById.mockResolvedValue(triageItem);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_KNOWLEDGE_REPO = 'owner/knowledge';

    const persistence = await import('@/lib/persistence/runtime');
    persistence.registerCorePersistenceRepositories(coreRepositories());
  });

  afterEach(() => {
    resetProcessRuntimeRegistries();
    delete process.env.MC_DATABASE_BACKEND;
    delete process.env.MC_KNOWLEDGE_REPO;
    vi.unstubAllGlobals();
  });

  it('imports both routes and executes all four async AI consumers without fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (
      init?.method === 'PUT'
        ? new Response(JSON.stringify({
            content: { html_url: 'https://github.com/owner/knowledge/blob/main/note.md' },
          }), { status: 200 })
        : new Response('', { status: 404 })
    )));

    const semanticRepository = {
      getActiveIdentity: vi.fn(async () => null),
    } as SemanticIndexRepository;
    const semanticEmbeddings = {
      resolveRoute: vi.fn(async () => ({ status: 'unavailable', reason: 'test' })),
    } as SemanticEmbeddingProvider;
    const semanticSource = {
      get: vi.fn(async () => null),
    } as SemanticSourcePort;

    const [
      persistence,
      semanticSearch,
      semanticSourceRuntime,
      semanticRuntime,
      providerRuntime,
      observations,
      multiAction,
      knowledgeBase,
      enrichment,
      observationsRoute,
      extractActionsRoute,
    ] = await Promise.all([
      import('@/lib/persistence/runtime'),
      import('@/lib/search/semantic'),
      import('@/lib/semantic-index/source/facade'),
      import('@/lib/semantic-index/runtime'),
      import('@/lib/ai/provider-runtime'),
      import('@/lib/stats/observations'),
      import('@/lib/triage/actions/multi-action-extract'),
      import('@/lib/triage/actions/knowledge-base'),
      import('@/lib/notifications/enrichment/ai-enrichment'),
      import('@/app/api/insights/observations/route'),
      import('@/app/api/triage/[id]/extract-actions/route'),
    ]);
    expect(persistence.getCorePersistenceRepositories().settings).toBeDefined();
    semanticSearch.registerSemanticSearchRuntime({
      resolve: async () => ({
        repository: semanticRepository,
        embeddings: semanticEmbeddings,
      }),
      scheduleBackfill: async () => ({ status: 'skipped', reason: 'test' }),
    });
    semanticSourceRuntime.registerSemanticSourcePort(semanticSource);

    const composed = await semanticRuntime.createSemanticIndexRuntime();
    expect(composed.repository).toBe(semanticRepository);
    expect(composed.source).toBe(semanticSource);
    await expect(providerRuntime.getAsyncAIProviderConfiguration()).resolves.toMatchObject({
      configured: true,
      provider: 'ollama',
      model: 'test-model',
    });
    await expect(providerRuntime.getAsyncAIModel('stats-observations')).resolves.toMatchObject({
      model: { model: 'test-model' },
    });

    await expect(observations.generateLLMObservations(snapshot)).resolves.toHaveLength(1);
    await expect(multiAction.extractMultipleActions(triageItem)).resolves.toMatchObject({
      actions: [{ title: 'Review release notes' }],
    });
    await expect(knowledgeBase.saveToKnowledgeBase(triageItem)).resolves.toMatchObject({
      success: true,
    });
    await expect(enrichment.enrichWithAI({
      notificationId: 'notification-1',
      title: 'Review requested',
      connectorType: 'github',
      category: 'development',
      metadata: {},
      presentation: { reason: 'review_requested' },
    })).resolves.toMatchObject({
      summary: 'Review the requested changes',
    });

    await expect(observationsRoute.GET(
      new Request('http://localhost/api/insights/observations?period=30') as never,
    )).resolves.toHaveProperty('status', 200);
    await expect(extractActionsRoute.POST(
      new Request('http://localhost/api/triage/triage-1/extract-actions', { method: 'POST' }),
      { params: Promise.resolve({ id: triageItem.id }) },
    )).resolves.toHaveProperty('status', 200);

    expect(mocks.calls[0]).toBe('settings-read');
    expect(mocks.generateText).toHaveBeenCalledTimes(6);
  });
});
