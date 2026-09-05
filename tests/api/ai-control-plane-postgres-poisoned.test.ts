import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const run = {
    id: 'run-1',
    featureId: 'document-intake',
    status: 'failed',
    createdAt: '2026-09-04T12:00:00.000Z',
  };
  const memory = {
    id: '11111111-1111-4111-8111-111111111111',
    authorizationScope: 'installation',
    title: 'Release',
    summary: 'Ship safely.',
    decisions: [],
    commitments: [],
    topics: [],
    linkedEntities: [],
    sensitivity: 'restricted',
    retainUntil: '2026-12-01T00:00:00.000Z',
    excludedAt: null,
    createdAt: '2026-09-04T12:00:00.000Z',
    updatedAt: '2026-09-04T12:00:00.000Z',
  };
  return {
    calls,
    run,
    memory,
    listRuns: vi.fn(async () => [run]),
    getRun: vi.fn(async () => run),
    getEventsAfter: vi.fn(async () => [{
      runId: run.id,
      cursor: 1,
      kind: 'run.failed',
      payload: {},
      createdAt: run.createdAt,
    }]),
    requestCancellation: vi.fn(async () => run),
    retryRun: vi.fn(async () => run),
    generateObject: vi.fn(async ({ system }: { system: string }) => {
      calls.push('provider-call');
      return system.includes('privacy-minimized')
        ? {
            object: {
              version: 1,
              title: 'Release',
              summary: 'Ship safely.',
              decisions: [],
              commitments: [],
              topics: [],
              linkedEntities: [],
            },
          }
        : {
            object: {
              title: 'Imported plan',
              findings: [{
                id: 'F-1',
                area: 'Delivery',
                issue: 'Ship the release',
                impact: 'Completes delivery',
                suggestedFix: 'Deploy',
                effort: 'Low',
                priorityOrder: 1,
                priorityTitle: 'Now',
                priorityLabel: 'Priority 1',
                linkedIssueNumbers: [],
              }],
              phases: [],
              priorityGroups: [],
            },
          };
    }),
    memoryGet: vi.fn(async () => {
      calls.push('memory-inspect');
      return memory;
    }),
    memoryList: vi.fn(async () => [memory]),
    memoryUpsert: vi.fn(async (input: Record<string, unknown>) => {
      calls.push('memory-upsert');
      return { ...memory, ...input };
    }),
    memoryExclude: vi.fn(async () => true),
    memoryDelete: vi.fn(async () => true),
    publishUpsert: vi.fn(async () => {
      calls.push('semantic-publish');
    }),
  };
});

vi.mock('@/db', () => {
  throw new Error('SQLite must not be evaluated by PostgreSQL AI control-plane routes');
});
vi.mock('@/lib/api/trusted-request', () => ({
  isTrustedMutationRequest: () => true,
}));
vi.mock('@/lib/houston-memory/request-auth', () => ({
  isTrustedHoustonMemoryRequest: () => true,
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => (model: string) => ({ model }),
}));
vi.mock('ai', () => ({
  generateObject: mocks.generateObject,
}));

describe('poisoned-SQLite PostgreSQL AI control-plane routes', () => {
  beforeEach(async () => {
    resetProcessRuntimeRegistries();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.AI_HOUSTON_MEMORY_ENABLED = 'true';

    const [
      durableRuntime,
      persistenceRuntime,
      sourceRuntime,
      publicationRuntime,
    ] = await Promise.all([
      import('@/lib/ai/durable-runs/runtime'),
      import('@/lib/persistence/runtime'),
      import('@/lib/semantic-index/source/facade'),
      import('@/lib/semantic-index/publication-service'),
    ]);
    durableRuntime.registerDurableAiRunRepository({
      listRuns: mocks.listRuns,
      getRun: mocks.getRun,
      getEventsAfter: mocks.getEventsAfter,
      requestCancellation: mocks.requestCancellation,
      retryRun: mocks.retryRun,
    } as never);
    persistenceRuntime.registerCorePersistenceRepositories({
      settings: {
        get: vi.fn(async () => null),
        getMany: vi.fn(async () => ({
          ai_provider_config: {
            provider: 'ollama',
            model: 'test-model',
          },
          ai_routing_policy: null,
        })),
        setMany: vi.fn(async () => undefined),
        getActiveEmbeddingIdentity: vi.fn(async () => null),
      },
      houstonMemories: {
        get: mocks.memoryGet,
        list: mocks.memoryList,
        upsert: mocks.memoryUpsert,
        exclude: mocks.memoryExclude,
        delete: mocks.memoryDelete,
      },
    } as never);
    sourceRuntime.registerSemanticSourcePort({
      get: vi.fn(async () => null),
    } as never);
    publicationRuntime.registerSemanticPublicationService({
      upsert: mocks.publishUpsert,
      delete: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    resetProcessRuntimeRegistries();
    delete process.env.MC_DATABASE_BACKEND;
    delete process.env.AI_HOUSTON_MEMORY_ENABLED;
  });

  it('serves durable run history, detail, events, cancellation, and retry', async () => {
    const [
      runsRoute,
      runRoute,
      eventsRoute,
      cancelRoute,
      retryRoute,
    ] = await Promise.all([
      import('@/app/api/ai/runs/route'),
      import('@/app/api/ai/runs/[runId]/route'),
      import('@/app/api/ai/runs/[runId]/events/route'),
      import('@/app/api/ai/runs/[runId]/cancel/route'),
      import('@/app/api/ai/runs/[runId]/retry/route'),
    ]);
    const context = { params: Promise.resolve({ runId: mocks.run.id }) };

    await expect(runsRoute.GET(new Request('http://localhost/api/ai/runs')))
      .resolves.toHaveProperty('status', 200);
    await expect(runRoute.GET(
      new Request(`http://localhost/api/ai/runs/${mocks.run.id}`),
      context,
    )).resolves.toHaveProperty('status', 200);
    await expect(eventsRoute.GET(
      new Request(`http://localhost/api/ai/runs/${mocks.run.id}/events`),
      context,
    )).resolves.toHaveProperty('status', 200);
    await expect(cancelRoute.POST(
      new Request(`http://localhost/api/ai/runs/${mocks.run.id}/cancel`, {
        method: 'POST',
      }),
      context,
    )).resolves.toHaveProperty('status', 200);
    await expect(retryRoute.POST(
      new Request(`http://localhost/api/ai/runs/${mocks.run.id}/retry`, {
        method: 'POST',
        headers: { 'idempotency-key': 'retry-1' },
      }),
      context,
    )).resolves.toHaveProperty('status', 200);
    expect(mocks.getEventsAfter).toHaveBeenCalledWith(mocks.run.id, 0, 101);
    expect(mocks.retryRun).toHaveBeenCalledWith(mocks.run.id, 'retry-1');
  });

  it('keeps provider, persistence, and publication ordering for intake and memory', async () => {
    const intakeRoute = await import('@/app/api/ai/intake-document/route');
    const memoryRoute = await import('@/app/api/ai/memories/route');

    const intakeResponse = await intakeRoute.POST(new Request(
      'http://localhost/api/ai/intake-document',
      {
        method: 'POST',
        body: JSON.stringify({ document: 'Unstructured request with no headings.' }),
      },
    ));
    expect(intakeResponse.status).toBe(200);
    expect(mocks.generateObject).toHaveBeenCalledTimes(1);

    mocks.calls.length = 0;
    const memoryResponse = await memoryRoute.POST(new Request(
      'http://localhost/api/ai/memories',
      {
        method: 'POST',
        body: JSON.stringify({
          conversationId: mocks.memory.id,
          messages: [
            { role: 'user', text: 'Plan the release.' },
            { role: 'assistant', text: 'We should ship safely.' },
          ],
        }),
      },
    ));
    expect(memoryResponse.status).toBe(200);
    expect(mocks.calls).toEqual([
      'memory-inspect',
      'provider-call',
      'memory-upsert',
      'semantic-publish',
    ]);
  });

  it('serves memory visibility and mutations through the selected composition', async () => {
    const listRoute = await import('@/app/api/ai/memories/route');
    const itemRoute = await import('@/app/api/ai/memories/[id]/route');
    const context = { params: Promise.resolve({ id: mocks.memory.id }) };

    await expect(listRoute.GET(new Request('http://localhost/api/ai/memories')))
      .resolves.toHaveProperty('status', 200);
    await expect(itemRoute.GET(
      new Request(`http://localhost/api/ai/memories/${mocks.memory.id}`),
      context,
    )).resolves.toHaveProperty('status', 200);
    await expect(itemRoute.PATCH(
      new Request(`http://localhost/api/ai/memories/${mocks.memory.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ excluded: true }),
      }),
      context,
    )).resolves.toHaveProperty('status', 200);
    await expect(itemRoute.DELETE(
      new Request(`http://localhost/api/ai/memories/${mocks.memory.id}`, {
        method: 'DELETE',
      }),
      context,
    )).resolves.toHaveProperty('status', 200);
  });
});
