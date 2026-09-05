import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetModulesPreservingProcessRuntimeRegistries,
  resetProcessRuntimeRegistries,
} from '../helpers/process-runtime-registries';

const mocks = vi.hoisted(() => ({
  listDeletedIds: vi.fn(async () => ['deleted-connector']),
  keywordSearch: vi.fn(async () => [{
    type: 'task' as const,
    id: 'task-1',
    title: 'Planning task',
    snippet: 'Planning task',
    score: 1,
    source: 'fts' as const,
    href: '/tasks/task-1',
    metadata: {},
  }]),
}));

vi.mock('@/db', () => {
  throw new Error('SQLite must not be evaluated by the PostgreSQL AI search route');
});
vi.mock('@/lib/telemetry/operations', () => ({
  withRuntimeOperation: vi.fn((_operation, run: () => unknown) => run()),
}));

describe('poisoned-SQLite PostgreSQL AI search route', () => {
  beforeEach(async () => {
    resetProcessRuntimeRegistries();
    vi.clearAllMocks();
    process.env.MC_DATABASE_BACKEND = 'postgres';
    const [persistence, keyword] = await Promise.all([
      import('@/lib/persistence/runtime'),
      import('@/lib/search/keyword-runtime'),
    ]);
    persistence.registerCorePersistenceRepositories({
      connectors: { listDeletedIds: mocks.listDeletedIds },
    } as never);
    keyword.registerKeywordSearchRepository({
      rebuild: vi.fn(async () => undefined),
      indexTask: vi.fn(async () => undefined),
      removeTask: vi.fn(async () => undefined),
      indexNotification: vi.fn(async () => undefined),
      removeNotification: vi.fn(async () => undefined),
      warmUp: vi.fn(async () => undefined),
      search: mocks.keywordSearch,
    });
  });

  afterEach(() => {
    resetProcessRuntimeRegistries();
    delete process.env.MC_DATABASE_BACKEND;
  });

  it('uses the selected persistence and search repositories without evaluating SQLite', async () => {
    const { GET } = await import('@/app/api/ai/search/route');
    const response = await GET(new Request(
      'http://localhost/api/ai/search?q=planning&type=tasks&mode=keyword&universeEligible=true',
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(mocks.listDeletedIds).toHaveBeenCalledOnce();
    expect(mocks.keywordSearch).toHaveBeenCalledWith('planning', expect.objectContaining({
      type: 'tasks',
      excludeConnectorInstanceIds: ['deleted-connector'],
    }));
  });

  it('keeps semantic runtime selection process-wide and resettable', async () => {
    const first = await import('@/lib/search/semantic');
    const selected = {
      resolve: vi.fn(),
      scheduleBackfill: vi.fn(),
    };
    first.registerSemanticSearchRuntime(selected);

    resetModulesPreservingProcessRuntimeRegistries(vi.resetModules);
    const second = await import('@/lib/search/semantic');
    expect(second.getSemanticSearchRuntime()).toBe(selected);
    expect(() => second.registerSemanticSearchRuntime(selected)).not.toThrow();
    expect(() => second.registerSemanticSearchRuntime({
      resolve: vi.fn(),
      scheduleBackfill: vi.fn(),
    })).toThrow('Semantic search runtime is already selected');

    first.clearSemanticSearchRuntime(selected);
    expect(() => second.getSemanticSearchRuntime()).toThrow(
      'Semantic search runtime has not been registered',
    );

    second.registerSemanticSearchRuntime(selected);
    resetProcessRuntimeRegistries();
    expect(() => second.getSemanticSearchRuntime()).toThrow(
      'Semantic search runtime has not been registered',
    );
  });
});
