import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageItem } from '@/types';
import type {
  ScoutIngestionReconciliationPersistence,
} from '@/db/persistence/scout-ingestion-reconciliation';

/**
 * Poisoned-SQLite proof for the eight routes PR 1 owns. Both SQLite modules
 * throw on evaluation, so importing or calling any of these handlers with
 * PostgreSQL-shaped collaborators fails loudly if the route ever reaches back
 * into `@/db`. External AI, Microsoft Graph, GitHub, Karakeep, and document
 * connectors are mocked at their own neutral boundaries.
 */
vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const calls = vi.hoisted(() => ({
  publishSemanticUpsert: vi.fn(async () => undefined),
  emitEvent: vi.fn(async () => undefined),
  extractMultipleActions: vi.fn(async () => ({ actions: [] })),
  createGitHubIssue: vi.fn(),
  saveToKarakeep: vi.fn(),
  createTodoTaskFromTriageItem: vi.fn(),
  findTodoTaskFromTriageItem: vi.fn(),
  completeDocumentAction: vi.fn(async () => ({ success: true })),
  deferDocumentAction: vi.fn(async () => undefined),
  reopenDocumentAction: vi.fn(async () => undefined),
  owlCompleteTask: vi.fn(async () => undefined),
  hardDeleteTriageItem: vi.fn(async () => true),
}));

vi.mock('@/lib/semantic-index/publication', () => ({
  publishSemanticEntityUpsert: calls.publishSemanticUpsert,
  publishSemanticEntityDelete: vi.fn(async () => undefined),
}));
vi.mock('@/lib/events', () => ({ emitEvent: calls.emitEvent }));
vi.mock('@/lib/dedup', () => ({
  findFuzzyMatches: () => [],
  isAutoLinkMatch: () => false,
  computeSimilarity: () => 0,
}));
vi.mock('@/lib/triage/actions/multi-action-extract', () => ({
  extractMultipleActions: calls.extractMultipleActions,
}));
vi.mock('@/lib/triage/actions/github-issue', () => ({
  createGitHubIssue: calls.createGitHubIssue,
  buildGitHubIssueActionRecord: () => ({ note: 'Created issue' }),
}));
vi.mock('@/lib/triage/actions/karakeep', () => ({ saveToKarakeep: calls.saveToKarakeep }));
vi.mock('@/lib/triage/actions/ms-todo', () => ({
  createTodoTaskFromTriageItem: calls.createTodoTaskFromTriageItem,
  findTodoTaskFromTriageItem: calls.findTodoTaskFromTriageItem,
  TodoTaskCreationError: class extends Error {
    constructor(message: string, readonly outcomeUnknown: boolean) {
      super(message);
    }
  },
}));
vi.mock('@/lib/triage/actions/model-catalog', () => ({ saveToModelCatalog: vi.fn() }));
vi.mock('@/lib/triage/actions/knowledge-base', () => ({
  saveToKnowledgeBase: vi.fn(),
  buildKnowledgeBaseActionRecord: () => ({ note: null, metadata: {} }),
}));
vi.mock('@/lib/triage/actions/document-intelligence', () => ({
  completeDocumentAction: calls.completeDocumentAction,
  deferDocumentAction: calls.deferDocumentAction,
  reopenDocumentAction: calls.reopenDocumentAction,
}));
vi.mock('@/lib/triage/lifecycle', () => ({
  hardDeleteTriageItem: calls.hardDeleteTriageItem,
}));
vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: () => ({
      type: 'document-intelligence',
      completeTask: calls.owlCompleteTask,
      snoozeAction: vi.fn(async () => undefined),
      submitActionFeedback: vi.fn(async () => null),
      fetchActionTask: vi.fn(async () => null),
      executeSourceAction: vi.fn(async () => null),
    }),
  },
}));
vi.mock('@/lib/sync', () => ({
  syncScheduler: { initializeConnectorFromDb: vi.fn(async () => null) },
}));

const triageItem: TriageItem = {
  id: 'triage-1',
  sourcePlatform: 'reddit',
  sourceId: 'reddit:1',
  sourceUrl: 'https://example.com/a',
  title: 'Saved article',
  contentType: 'article',
  capturedAt: '2026-09-08T12:00:00.000Z',
  ingestedAt: '2026-09-08T12:00:00.000Z',
  status: 'pending',
  aiCategories: [],
  aiSuggestedActions: [],
  aiRelevanceScore: 50,
  aiUrgency: 'evergreen',
  rawMetadata: {},
  actionsTaken: [],
} as TriageItem;

const triageRepositories = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => triageRepositories.current,
}));

const scoutSettings = {
  current: {
    landingMode: 'direct',
    allowedSourceTypes: ['email', 'teams', 'meeting', 'planner', 'cross-source'],
    hybridConfidenceThreshold: 0.8,
    autoProjectId: null,
  } as Record<string, unknown>,
};

const scoutPersistence: ScoutIngestionReconciliationPersistence = {
  ingestion: {
    bootstrapConnector: async () => ({
      existed: true,
      enabled: true,
      settings: scoutSettings.current,
    }),
    ensureSourceList: async () => ({ created: false }),
    listCrossConnectorCandidates: async () => [],
    findExistingTask: async () => null,
    findTriageItem: async () => null,
    filterExistingProjectIds: async () => [],
    readIngestGuard: async () => ({ suppressed: false, linkedTaskId: null }),
    mergeExistingTask: async () => ({ kind: 'skip', reason: 'task_missing' }),
    createTask: async () => ({ kind: 'created' }),
    linkSourceToTask: async () => ({ kind: 'linked' }),
    upsertTriageItem: async (input) => ({
      kind: 'created',
      triageItemId: input.triageItemId,
    }),
    refreshSourceListCounts: async () => undefined,
  },
  comparison: {
    readWindow: async () => ({ scoutTasks: [], comparisonTasks: [], linkedPairs: [] }),
  },
  reconciliation: {
    getConnectorConfiguration: async () => ({ enabled: true, settings: {} }),
    expireStaleRuns: async () => undefined,
    findRunByIdempotencyKey: async () => null,
    loadRunEvaluations: async () => [],
    findRecentCompletedRun: async () => null,
    createRun: async () => ({ kind: 'created' }),
    resumeFailedRun: async () => ({ kind: 'resumed' }),
    failRun: async () => undefined,
    listScopedTasks: async () => [],
    listTaskStates: async () => [],
    commitRun: async (input) => {
      const summary = input.summarize([]);
      input.digest(summary);
      return { results: [], summary };
    },
    listPendingSuggestions: async () => [],
    actOnSuggestion: async ({ decide }) => decide({
      suggestion: {
        id: 'suggestion-1',
        taskId: 'task-1',
        runId: 'run-1',
        evaluationId: 'evaluation-1',
        action: 'suggest-complete',
        status: 'pending',
        payloadHash: 'a'.repeat(64),
        evidenceHash: 'evidence-1',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
      task: {
        id: 'task-1',
        title: 'Scout task',
        connectorType: 'scout',
        connectorInstanceId: 'scout-primary',
        sourceId: 'scout:email:1',
        status: 'todo',
        priority: 'medium',
        dueDate: null,
        completedAt: null,
        statusReason: null,
      },
      connector: { enabled: true, settings: {} },
    }).result,
    hasAppliedAutoCompletion: async () => false,
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    scoutIngestionReconciliation: scoutPersistence,
  }),
}));
vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    connectors: { listEnabled: async () => [] },
  }),
}));

const BASE = 'http://localhost:3099';
function request(path: string, init?: RequestInit) {
  return new Request(`${BASE}${path}`, {
    headers: {
      host: 'localhost:3099',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    ...init,
  });
}

describe('poisoned-SQLite Scout ingestion, reconciliation, and triage action routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    triageRepositories.current = {
      items: { get: async () => triageItem, seedIfEmpty: async () => undefined },
      actions: {
        getActionSnapshot: async () => triageItem,
        readClaim: async () => null,
        reserveClaim: async () => ({ acquired: true }),
        heartbeatClaim: async () => true,
        recordClaimTarget: async () => true,
        releaseClaim: async () => true,
        completeClaim: async () => ({ completed: true, item: triageItem }),
        appendAction: async () => ({ ...triageItem, status: 'dismissed' }),
        casActions: async () => ({ ...triageItem, status: 'pending' }),
      },
      documentTaskActions: {
        getTask: async () => ({
          id: 'owl-task-1',
          connectorType: 'document-intelligence',
          connectorInstanceId: 'owl',
          sourceId: 'owl:action:1',
          title: 'Pay invoice',
          description: null,
          status: 'todo',
          statusReason: null,
          snoozedUntil: null,
          priority: 'high',
          dueDate: null,
          completedAt: null,
          metadata: {},
        }),
        applyTaskWrite: async () => ({
          kind: 'applied',
          task: {
            id: 'owl-task-1',
            connectorType: 'document-intelligence',
            connectorInstanceId: 'owl',
            sourceId: 'owl:action:1',
            title: 'Pay invoice',
            description: null,
            status: 'done',
            statusReason: 'completed',
            snoozedUntil: null,
            priority: 'high',
            dueDate: null,
            completedAt: '2026-09-08T12:00:00.000Z',
            metadata: {},
          },
        }),
      },
    };
  });

  it('imports and executes all eight routes from PostgreSQL-shaped collaborators', async () => {
    const ingest = await import('@/app/api/scout/ingest/route');
    const ingested = await ingest.POST(request('/api/scout/ingest', {
      method: 'POST',
      body: JSON.stringify({
        items: [{
          sourceId: 'scout:email:1',
          sourceType: 'email',
          title: 'Reply to Johnson',
        }],
      }),
    }));
    expect(ingested.status).toBe(200);
    expect(await ingested.json()).toMatchObject({ created: 1 });

    const comparison = await import('@/app/api/scout/parallel-comparison/route');
    expect((await comparison.GET(request('/api/scout/parallel-comparison'))).status).toBe(200);

    process.env.MC_API_KEY = 'trusted-key';
    try {
      const reconcile = await import('@/app/api/scout/reconcile/route');
      const reconciled = await reconcile.POST(new Request(`${BASE}/api/scout/reconcile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.MC_API_KEY}`,
        },
        body: JSON.stringify({
          scope: 'all',
          dryRun: true,
          sourceIdentity: 'poisoned-suite',
          signals: [],
        }),
      }));
      expect(reconciled.status).toBe(200);

      const suggestions = await import('@/app/api/scout/reconciliation/suggestions/route');
      expect((await suggestions.GET(
        request('/api/scout/reconciliation/suggestions'),
      )).status).toBe(200);

      const suggestionAction = await import(
        '@/app/api/scout/reconciliation/suggestions/[id]/route'
      );
      const acted = await suggestionAction.POST(
        new Request(`${BASE}/api/scout/reconciliation/suggestions/suggestion-1`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.MC_API_KEY}`,
          },
          body: JSON.stringify({ action: 'accept', payloadHash: 'a'.repeat(64) }),
        }),
        { params: Promise.resolve({ id: 'suggestion-1' }) },
      );
      expect(acted.status).toBe(200);
    } finally {
      delete process.env.MC_API_KEY;
    }

    const triage = await import('@/app/api/triage/[id]/route');
    const dismissed = await triage.PATCH(
      request('/api/triage/triage-1', {
        method: 'PATCH',
        body: JSON.stringify({ actionType: 'dismiss' }),
      }),
      { params: Promise.resolve({ id: 'triage-1' }) },
    );
    expect(dismissed.status).toBe(200);

    const extract = await import('@/app/api/triage/[id]/extract-actions/route');
    expect((await extract.POST(
      request('/api/triage/triage-1/extract-actions', { method: 'POST' }),
      { params: Promise.resolve({ id: 'triage-1' }) },
    )).status).toBe(200);

    const owl = await import('@/app/api/tasks/[id]/owl/route');
    const completed = await owl.POST(
      request('/api/tasks/owl-task-1/owl', {
        method: 'POST',
        body: JSON.stringify({ action: 'complete' }),
      }),
      { params: Promise.resolve({ id: 'owl-task-1' }) },
    );
    expect(completed.status).toBe(200);
    expect(calls.owlCompleteTask).toHaveBeenCalledWith('owl:action:1');
  }, 20_000);

  it('routes a triage-mode Scout push through the triage upsert and publishes after commit', async () => {
    scoutSettings.current = { ...scoutSettings.current, landingMode: 'triage' };
    const ingest = await import('@/app/api/scout/ingest/route');
    const response = await ingest.POST(request('/api/scout/ingest', {
      method: 'POST',
      body: JSON.stringify({
        items: [{
          sourceId: 'scout:email:triaged',
          sourceType: 'email',
          title: 'Low confidence',
          confidence: 0.1,
          scoutContext: { extractedAt: '2026-09-08T12:00:00.000Z' },
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 0, triaged: 1 });
    expect(calls.publishSemanticUpsert).toHaveBeenCalledWith(
      'triage-item',
      expect.any(String),
    );
  });
});
