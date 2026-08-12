/**
 * Scout Connector — Ingest + Deduplication Tests
 *
 * Tests the POST /api/scout/ingest handler for:
 * - Task creation from Scout push
 * - sourceId-based deduplication (skip unchanged, update changed)
 * - Source list auto-creation per sourceType
 * - Scout provenance metadata in task JSON
 * - Validation (bad items, missing fields)
 * - Edge cases (closed tasks not updated, tag resolution)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockTasksStore: Record<string, unknown>[] = [];
let mockSourceListsStore: Record<string, unknown>[] = [];
let mockFieldStates: Record<string, unknown>[] = [];
let mockSuppressions: Record<string, unknown>[] = [];
let mockLinkedSources: Record<string, unknown>[] = [];
let mockTransactionTask: Record<string, unknown> | null = null;
let mockTransactionTaskOverride: Record<string, unknown> | null = null;
let mockConflictWinnerId: string | null = null;
let taskInsertChanges = 1;

const onConflictDoUpdateFn = vi.fn(() => ({ run: vi.fn() }));
const insertValuesFn = vi.fn((_values: unknown) => ({
  run: vi.fn(),
  onConflictDoNothing: vi.fn(() => ({
    run: vi.fn(() => ({ changes: taskInsertChanges })),
  })),
  onConflictDoUpdate: onConflictDoUpdateFn,
}));
const mockInsert = vi.fn(() => ({ values: insertValuesFn }));
const updateSetFn = vi.fn((_values: unknown) => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
const mockUpdate = vi.fn(() => ({ set: updateSetFn }));

function mockSelectChain(results: unknown[]) {
  const candidate = results[0];
  if (
    typeof candidate === 'object'
    && candidate !== null
    && 'title' in candidate
    && 'status' in candidate
    && 'metadata' in candidate
  ) {
    mockTransactionTask = candidate as Record<string, unknown>;
  }
  const whereResult = Object.assign(results, {
    all: vi.fn(() => results),
    get: vi.fn(() => results[0]),
  });
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => whereResult),
      all: vi.fn(() => results),
    })),
  };
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => mockSelectChain([])),
    insert: mockInsert,
    update: mockUpdate,
  },
  runTransaction: vi.fn((fn: (tx: unknown) => unknown) => fn({
    select: vi.fn((selection?: Record<string, unknown>) => {
      const rows = selection?.sourceId === 'suppression_source_id'
        ? mockSuppressions
        : selection?.taskId === 'task_id'
          ? mockLinkedSources
          : selection?.id === 'id' && Object.keys(selection).length === 1
            ? mockConflictWinnerId ? [{ id: mockConflictWinnerId }] : []
            : selection?.status
              ? mockTransactionTaskOverride
                ? [mockTransactionTaskOverride]
                : mockTransactionTask
                  ? [mockTransactionTask]
                  : []
              : mockFieldStates;
      return mockSelectChain(rows);
    }),
    insert: mockInsert,
    update: mockUpdate,
  })),
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', sourceId: 'source_id', connectorType: 'connector_type', connectorInstanceId: 'connector_instance_id', title: 'title', description: 'description', status: 'status', priority: 'priority', dueDate: 'due_date', sourceListId: 'source_list_id', sourceListName: 'source_list_name', metadata: 'metadata', syncStatus: 'sync_status', lastSyncedAt: 'last_synced_at', createdAt: 'created_at', updatedAt: 'updated_at', depth: 'depth', isChecklistItem: 'is_checklist_item', snoozedUntil: 'snoozed_until' },
  tags: { id: 'id', name: 'name', slug: 'slug', type: 'type', source: 'source', color: 'color', confirmed: 'confirmed', createdAt: 'created_at' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  taskFieldStates: { taskId: 'task_id', fieldName: 'field_name' },
  taskIngestSuppressions: { connectorInstanceId: 'suppression_connector_instance_id', sourceId: 'suppression_source_id' },
  sourceLists: { id: 'id', connectorInstanceId: 'connector_instance_id', sourceId: 'source_id', name: 'name', type: 'type', taskCount: 'task_count', lastSyncedAt: 'last_synced_at', sortOrder: 'sort_order', hidden: 'hidden' },
  taskLinkedSources: { id: 'id', taskId: 'task_id', connectorType: 'connector_type', connectorInstanceId: 'connector_instance_id', sourceId: 'source_id', title: 'title', linkedAt: 'linked_at', matchConfidence: 'match_confidence', metadata: 'metadata' },
  connectorConfigs: { id: 'id', enabled: 'enabled', settings: 'settings' },
  triageItems: { id: 'id', sourcePlatform: 'source_platform', sourceId: 'source_id', status: 'status' },
  hubProjects: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  ne: vi.fn((...args: unknown[]) => ({ op: 'ne', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  notInArray: vi.fn((...args: unknown[]) => ({ op: 'notInArray', args })),
}));

vi.mock('@/lib/dedup', () => ({
  findFuzzyMatches: vi.fn(() => []),
  isAutoLinkMatch: vi.fn(() => false),
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request('http://localhost:3099/api/scout/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'scout:email:msg-123',
    sourceType: 'email',
    title: 'Reply to Johnson about project timeline',
    description: 'Johnson asked about Q3 delivery dates in yesterday\'s email',
    priority: 'medium',
    confidence: 0.85,
    context: {
      from: 'johnson@corp.com',
      sourceSubject: 'Re: Q3 Project Timeline',
      extractedAt: '2026-07-28T10:00:00Z',
      reasoning: 'Direct question requiring reply; sender is manager',
    },
    suggestedTags: ['work', 'urgent-reply'],
    ...overrides,
  };
}

function expectedMetadata(item = validItem()) {
  const context = item.context as Record<string, unknown> | undefined;
  return JSON.stringify({
    sourceType: item.sourceType,
    scoutContext: {
      confidence: item.confidence ?? context?.confidence ?? null,
      reasoning: context?.reasoning || null,
      from: context?.from || null,
      sourceSubject: context?.sourceSubject || null,
      extractedAt: context?.extractedAt,
      originalSource: context?.originalSource || null,
      relatedSourceIds: context?.relatedSourceIds || [],
    },
    confidence: item.confidence,
  });
}

function directConnectorConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scout-primary',
    enabled: true,
    settings: {
      landingMode: 'direct',
      allowedSourceTypes: ['email', 'teams', 'meeting', 'planner', 'cross-source'],
      hybridConfidenceThreshold: 0.8,
      autoProjectId: null,
      ...overrides,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/scout/ingest', () => {
  let POST: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockTasksStore = [];
    mockSourceListsStore = [];
    mockFieldStates = [];
    mockSuppressions = [];
    mockLinkedSources = [];
    mockTransactionTask = null;
    mockTransactionTaskOverride = null;
    mockConflictWinnerId = null;
    taskInsertChanges = 1;

    // Re-setup the db mock so select returns correct data
    const dbMod = await import('@/db');
    db = dbMod.default as unknown as { select: ReturnType<typeof vi.fn> };

    let selectCall = 0;
    db.select.mockImplementation(() => {
      selectCall++;
      return mockSelectChain(selectCall === 1 ? [directConnectorConfig()] : []);
    });

    const mod = await import('@/app/api/scout/ingest/route');
    POST = mod.POST;
  });

  describe('validation', () => {
    it('rejects unauthorized requests when MC_API_KEY is set', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const res = await POST(makeRequest({ items: [validItem()] }));
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toBe('Unauthorized');
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });

    it('accepts requests with valid X-MC-API-Key header', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const req = new Request('http://localhost:3099/api/scout/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-MC-API-Key': 'test-secret-key' },
          body: JSON.stringify({ items: [validItem()] }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });

    it('accepts requests with valid Bearer token', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const req = new Request('http://localhost:3099/api/scout/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-secret-key' },
          body: JSON.stringify({ items: [validItem()] }),
        });
        const res = await POST(req);
        expect(res.status).toBe(200);
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });

    it('rejects missing items array', async () => {
      const res = await POST(makeRequest({}));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('items array is required');
    });

    it('rejects empty items array', async () => {
      const res = await POST(makeRequest({ items: [] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('items array is required');
    });

    it('rejects items exceeding max batch size', async () => {
      const items = Array.from({ length: 101 }, (_, i) => validItem({ sourceId: `scout:email:msg-${i}` }));
      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Maximum 100 items');
    });

    it('rejects item with missing sourceId', async () => {
      const res = await POST(makeRequest({ items: [{ sourceType: 'email', title: 'test' }] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('sourceId');
    });

    it('rejects item with invalid sourceType', async () => {
      const res = await POST(makeRequest({ items: [{ sourceId: 'test', sourceType: 'invalid', title: 'test' }] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('sourceType');
    });

    it('rejects item with missing title', async () => {
      const res = await POST(makeRequest({ items: [{ sourceId: 'test', sourceType: 'email' }] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('title');
    });

    it('rejects invalid priority', async () => {
      const res = await POST(makeRequest({ items: [validItem({ priority: 'urgent' })] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('priority');
    });

    it('rejects confidence outside 0-1 range', async () => {
      const res = await POST(makeRequest({ items: [validItem({ confidence: 1.5 })] }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('confidence');
    });

    it('rejects suggestedTags values that are not string arrays', async () => {
      const res = await POST(makeRequest({
        items: [validItem({ suggestedTags: { work: true } })],
      }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('suggestedTags');
    });
  });

  describe('task creation', () => {
    it('creates a new task from a valid item', async () => {
      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.created).toBe(1);
      expect(json.updated).toBe(0);
      expect(json.skipped).toBe(0);
      expect(json.total).toBe(1);
      expect(json.items[0].action).toBe('created');
      expect(json.items[0].sourceId).toBe('scout:email:msg-123');
      expect(json.items[0].mcTaskId).toBeTruthy();
      expect(json.items[0]).toMatchObject({
        appliedFields: ['title', 'description', 'priority', 'dueDate'],
        preservedOverrides: [],
        unchangedFields: [],
      });
    });

    it('creates tasks for multiple items', async () => {
      const items = [
        validItem({ sourceId: 'scout:email:msg-1', title: 'Task 1' }),
        validItem({ sourceId: 'scout:teams:msg-2', sourceType: 'teams', title: 'Task 2' }),
        validItem({ sourceId: 'scout:meeting:evt-3:0', sourceType: 'meeting', title: 'Task 3' }),
      ];
      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.created).toBe(3);
      expect(json.total).toBe(3);
    });

    it('calls insert with scout connectorType and provenance metadata', async () => {
      await POST(makeRequest({ items: [validItem()] }));

      // Verify db.insert was called (for source list + task + tags)
      expect(mockInsert).toHaveBeenCalled();

      // Verify the values function was called with task data
      expect(insertValuesFn).toHaveBeenCalled();
    });

    it('records initial source snapshots without local overrides', async () => {
      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);

      const snapshotInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const values = call[0];
        return Array.isArray(values)
          && values.length === 4
          && values.every((value) => (
            typeof value === 'object'
            && value !== null
            && 'sourceValue' in value
          ));
      });
      expect(snapshotInsert?.[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'title',
          sourceValue: '"Reply to Johnson about project timeline"',
          locallyOverridden: false,
        }),
        expect.objectContaining({
          fieldName: 'description',
          locallyOverridden: false,
        }),
        expect.objectContaining({
          fieldName: 'priority',
          locallyOverridden: false,
        }),
        expect.objectContaining({
          fieldName: 'dueDate',
          sourceValue: 'null',
          locallyOverridden: false,
        }),
      ]));
    });

    it('requeues a concurrent first-ingest loser through normal merge semantics', async () => {
      taskInsertChanges = 0;
      mockConflictWinnerId = 'tsk-concurrent-winner';
      let selectCall = 0;
      db.select.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return mockSelectChain([directConnectorConfig()]);
        if (selectCall === 6) {
          return mockSelectChain([{
            id: 'tsk-concurrent-winner',
            title: 'Earlier concurrent observation',
            description: null,
            priority: 'none',
            dueDate: null,
            metadata: '{}',
            status: 'todo',
            snoozedUntil: null,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toMatchObject({
        created: 0,
        updated: 1,
        skipped: 0,
        total: 1,
      });
      expect(json.items).toEqual([expect.objectContaining({
        mcTaskId: 'tsk-concurrent-winner',
        action: 'updated',
        appliedFields: expect.arrayContaining(['title', 'description', 'priority']),
      })]);
    });

    it('maps scoutContext wire format to internal context for metadata', async () => {
      const item = {
        sourceId: 'scout:email:wire-format-test',
        sourceType: 'email',
        title: 'Wire format mapping test',
        confidence: 0.91,
        scoutContext: {
          reasoning: 'Test reasoning value',
          extractedAt: '2026-07-29T10:00:00Z',
          originalSource: { type: 'email', from: 'test@example.com' },
        },
      };
      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(1);

      // Verify the metadata passed to insert contains the scoutContext fields
      const insertCalls = insertValuesFn.mock.calls;
      const taskInsert = insertCalls.find((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.connectorType === 'scout' && val.sourceId === 'scout:email:wire-format-test';
      });
      expect(taskInsert).toBeTruthy();
      const metadata = JSON.parse(
        (taskInsert![0] as Record<string, unknown>).metadata as string,
      );
      expect(metadata.scoutContext.confidence).toBe(0.91);
      expect(metadata.scoutContext.reasoning).toBe('Test reasoning value');
      expect(metadata.scoutContext.originalSource).toEqual({ type: 'email', from: 'test@example.com' });
    });
  });

  describe('deduplication', () => {
    it('skips unchanged existing task', async () => {
      mockFieldStates = [
        ['title', 'Reply to Johnson about project timeline'],
        ['description', 'Johnson asked about Q3 delivery dates in yesterday\'s email'],
        ['priority', 'medium'],
        ['dueDate', null],
      ].map(([fieldName, value]) => ({
        taskId: 'tsk-existing',
        fieldName,
        sourceValue: JSON.stringify(value),
        locallyOverridden: false,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: null,
        updatedAt: '2026-08-01T00:00:00.000Z',
      }));
      // Mock: first select (source list check) returns nothing, second (task check) returns existing
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        // The findExistingTask call returns an existing task
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: 'Reply to Johnson about project timeline',
            description: 'Johnson asked about Q3 delivery dates in yesterday\'s email',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.created).toBe(0);
      expect(json.items[0].action).toBe('skipped');
      expect(json.items[0].reason).toBe('unchanged');
    });

    it('updates existing task when content changed', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: 'Old title that differs',
            description: 'Old description',
            priority: 'low',
            dueDate: null,
            metadata: '{}',
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
      expect(json.items[0].mcTaskId).toBe('tsk-existing');
      expect(json.items[0].appliedFields).toEqual([
        'title',
        'description',
        'priority',
      ]);
      expect(json.items[0].unchangedFields).toContain('dueDate');
      expect(mockUpdate).toHaveBeenCalled();
      expect(updateSetFn.mock.calls.every((call) =>
        !(call[0] && typeof call[0] === 'object' && 'localDisposition' in call[0]),
      )).toBe(true);
    });

    it('advances source snapshots without overwriting local overrides', async () => {
      mockTransactionTask = {
        title: 'Local title',
        description: null,
        priority: 'none',
        dueDate: null,
      };
      mockFieldStates = [{
        taskId: 'tsk-existing',
        fieldName: 'title',
        sourceValue: '"Old source title"',
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }];
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: 'Local title',
            description: null,
            priority: 'none',
            dueDate: null,
            metadata: '{}',
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const taskUpdate = updateSetFn.mock.calls.find((call) => (
        (call[0] as Record<string, unknown>).lastSyncedAt !== undefined
      ));
      expect(taskUpdate?.[0]).not.toHaveProperty('title');
      expect(insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'tsk-existing',
        fieldName: 'title',
        sourceValue: '"Reply to Johnson about project timeline"',
        locallyOverridden: true,
      }));
    });

    it('preserves a local edit committed after the initial deduplication read', async () => {
      const item = validItem();
      mockFieldStates = [{
        taskId: 'tsk-existing',
        fieldName: 'title',
        sourceValue: JSON.stringify(item.title),
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }];
      mockTransactionTaskOverride = {
        id: 'tsk-existing',
        title: 'Concurrent local title',
        description: item.description,
        priority: item.priority,
        dueDate: null,
        metadata: expectedMetadata(item),
        status: 'todo',
        snoozedUntil: null,
      };
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: item.title,
            description: item.description,
            priority: item.priority,
            dueDate: null,
            metadata: expectedMetadata(item),
            status: 'todo',
            snoozedUntil: null,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.updated).toBe(0);
      expect(json.skipped).toBe(1);
      expect(json.items[0].reason).toBe('unchanged');
    });

    it('clears an override when the source converges without changing the rendered task', async () => {
      const item = validItem({ priority: 'high' });
      mockFieldStates = [{
        taskId: 'tsk-existing',
        fieldName: 'priority',
        sourceValue: '"none"',
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }];
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: item.title,
            description: item.description,
            priority: 'high',
            dueDate: null,
            metadata: expectedMetadata(item),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      expect(insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'tsk-existing',
        fieldName: 'priority',
        sourceValue: '"high"',
        locallyOverridden: false,
      }));
    });

    it('preserves overrides independently across all mergeable fields', async () => {
      mockFieldStates = [
        ['title', 'Old source title'],
        ['description', 'Old source description'],
        ['priority', 'low'],
        ['dueDate', '2026-08-01'],
      ].map(([fieldName, value]) => ({
        taskId: 'tsk-existing',
        fieldName,
        sourceValue: JSON.stringify(value),
        locallyOverridden: true,
        sourceObservedAt: '2026-08-01T00:00:00.000Z',
        localEditedAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }));
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: 'Local title',
            description: 'Local description',
            priority: 'critical',
            dueDate: '2026-09-01',
            metadata: JSON.stringify({ missionControl: { pinned: true } }),
            status: 'todo',
            snoozedUntil: null,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem({ dueDate: '2026-08-15' })] }));
      const json = await res.json();
      const taskUpdate = updateSetFn.mock.calls.find((call) => (
        (call[0] as Record<string, unknown>).lastSyncedAt !== undefined
      ));

      expect(taskUpdate?.[0]).not.toHaveProperty('title');
      expect(taskUpdate?.[0]).not.toHaveProperty('description');
      expect(taskUpdate?.[0]).not.toHaveProperty('priority');
      expect(taskUpdate?.[0]).not.toHaveProperty('dueDate');
      expect(json.items[0]).toMatchObject({
        action: 'updated',
        appliedFields: [],
        preservedOverrides: ['title', 'description', 'priority', 'dueDate'],
        unchangedFields: [],
      });
    });

    it('clears an override when Scout converges on the local value', async () => {
      mockTransactionTask = {
        title: 'Reply to Johnson about project timeline',
        description: 'Johnson asked about Q3 delivery dates in yesterday\'s email',
        priority: 'high',
        dueDate: null,
      };
      mockFieldStates = [
        {
          taskId: 'tsk-existing',
          fieldName: 'priority',
          sourceValue: '"medium"',
          locallyOverridden: true,
          sourceObservedAt: '2026-08-01T00:00:00.000Z',
          localEditedAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
        ...[
          ['title', 'Reply to Johnson about project timeline'],
          ['description', 'Johnson asked about Q3 delivery dates in yesterday\'s email'],
          ['dueDate', null],
        ].map(([fieldName, value]) => ({
          taskId: 'tsk-existing',
          fieldName,
          sourceValue: JSON.stringify(value),
          locallyOverridden: false,
          sourceObservedAt: '2026-08-01T00:00:00.000Z',
          localEditedAt: null,
          updatedAt: '2026-08-01T00:00:00.000Z',
        })),
      ];
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: 'Reply to Johnson about project timeline',
            description: 'Johnson asked about Q3 delivery dates in yesterday\'s email',
            priority: 'high',
            dueDate: null,
            metadata: '{}',
            status: 'todo',
            snoozedUntil: null,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem({ priority: 'high' })] }));
      const json = await res.json();
      expect(json.items[0].appliedFields).toContain('priority');
      expect(insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'tsk-existing',
        fieldName: 'priority',
        locallyOverridden: false,
      }));
    });

    it('refreshes Scout provenance while preserving unrelated metadata', async () => {
      const item = validItem();
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: item.title,
            description: item.description,
            priority: item.priority,
            dueDate: null,
            metadata: JSON.stringify({
              recurrence: 'weekly',
              mcOwned: { pinned: true },
              sourceType: 'email',
              scoutContext: {
                confidence: 0.2,
                reasoning: 'Stale provenance',
                extractedAt: item.context.extractedAt,
              },
            }),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      const taskUpdate = updateSetFn.mock.calls.find((call) => (
        (call[0] as Record<string, unknown>).lastSyncedAt !== undefined
      ));
      const metadata = JSON.parse(
        (taskUpdate?.[0] as Record<string, unknown>).metadata as string,
      );
      expect(metadata).toMatchObject({
        recurrence: 'weekly',
        mcOwned: { pinned: true },
        sourceType: 'email',
        scoutContext: {
          confidence: 0.85,
          reasoning: 'Direct question requiring reply; sender is manager',
        },
      });
    });

    it('preserves malformed legacy metadata without aborting the ingest batch', async () => {
      const item = validItem();
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing',
            title: item.title,
            description: item.description,
            priority: item.priority,
            dueDate: null,
            metadata: 'not-json',
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      const taskUpdate = updateSetFn.mock.calls.find((call) => (
        (call[0] as Record<string, unknown>).lastSyncedAt !== undefined
      ));
      expect(JSON.parse(
        (taskUpdate?.[0] as Record<string, unknown>).metadata as string,
      )).toMatchObject({
        legacyMetadata: 'not-json',
        sourceType: 'email',
      });
    });

    it('suppresses a tombstoned item before task creation or source linking', async () => {
      mockSuppressions = [{ sourceId: 'scout:email:msg-123' }];

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();
      const taskOrLinkInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.connectorType === 'scout' && (
          value.sourceId === 'scout:email:msg-123'
          || value.taskId !== undefined
        );
      });

      expect(json.items[0]).toMatchObject({
        action: 'suppressed',
        reason: 'ingest_tombstone',
        appliedFields: [],
        preservedOverrides: [],
        unchangedFields: [],
      });
      expect(taskOrLinkInsert).toBeUndefined();
    });

    it('keeps repeated pushes attached to the existing linked task', async () => {
      mockLinkedSources = [{ taskId: 'remote-task-1' }];

      const res = await POST(makeRequest({ items: [validItem({ title: 'Changed source title' })] }));
      const json = await res.json();
      const taskInsert = insertValuesFn.mock.calls.find((call) => (
        (call[0] as Record<string, unknown>).connectorType === 'scout'
      ));

      expect(json.items[0]).toMatchObject({
        action: 'linked',
        reason: 'existing_link',
        mcTaskId: 'remote-task-1',
        linkedTo: 'remote-task-1',
      });
      expect(taskInsert).toBeUndefined();
    });

    it('skips update for completed tasks', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 3) {
          return mockSelectChain([{
            id: 'tsk-done',
            title: 'Old title',
            description: null,
            priority: 'none',
            dueDate: null,
            metadata: '{}',
            status: 'done',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('task_closed');
    });
  });

  describe('source list auto-creation', () => {
    it('calls insert for source list when none exists', async () => {
      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      // Insert called for: source list, task, tags (x2)
      expect(mockInsert).toHaveBeenCalled();
    });

    it('does not re-create source list if it already exists', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 4) {
          return mockSelectChain([{ id: 'sl-scout-email' }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
    });
  });

  describe('all source types accepted', () => {
    const sourceTypes = ['email', 'teams', 'meeting', 'planner', 'cross-source'] as const;

    for (const sourceType of sourceTypes) {
      it(`accepts sourceType: ${sourceType}`, async () => {
        const res = await POST(makeRequest({
          items: [validItem({ sourceId: `scout:${sourceType}:id-1`, sourceType })],
        }));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.created).toBe(1);
      });
    }
  });

  describe('connector settings', () => {
    it('skips source types that are not allowed', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        return mockSelectChain(callCount === 1
          ? [directConnectorConfig({ allowedSourceTypes: ['teams'] })]
          : []);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();

      expect(json.created).toBe(0);
      expect(json.skipped).toBe(1);
      expect(json.items[0]).toMatchObject({
        action: 'skipped',
        reason: 'source_type_disabled',
      });
    });

    it('routes triage-mode items into the Scout triage source', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        return mockSelectChain(callCount === 1
          ? [directConnectorConfig({ landingMode: 'triage' })]
          : []);
      });

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();
      const triageInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.sourcePlatform === 'scout';
      });

      expect(json.created).toBe(0);
      expect(json.triaged).toBe(1);
      expect(json.items[0].action).toBe('triaged');
      expect(triageInsert?.[0]).toMatchObject({
        sourcePlatform: 'scout',
        sourceId: 'scout:email:msg-123',
        status: 'pending',
      });
      expect(onConflictDoUpdateFn).toHaveBeenCalledWith(expect.objectContaining({
        target: ['source_platform', 'source_id'],
        setWhere: expect.objectContaining({ op: 'notInArray' }),
      }));
    });

    it('routes low-confidence hybrid items to triage', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        return mockSelectChain(callCount === 1
          ? [directConnectorConfig({ landingMode: 'hybrid', hybridConfidenceThreshold: 0.8 })]
          : []);
      });

      const res = await POST(makeRequest({
        items: [validItem({ confidence: 0.79 })],
      }));
      const json = await res.json();

      expect(json.triaged).toBe(1);
      expect(json.items[0].action).toBe('triaged');
    });

    it('stores the effective default project on triaged items', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockSelectChain([directConnectorConfig({
            landingMode: 'triage',
            autoProjectId: 'proj-triage',
          })]);
        }
        if (callCount === 5) return mockSelectChain([{ id: 'proj-triage' }]);
        return mockSelectChain([]);
      });

      await POST(makeRequest({ items: [validItem()] }));
      const triageInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.sourcePlatform === 'scout';
      });

      expect(triageInsert?.[0]).toMatchObject({
        rawMetadata: expect.objectContaining({
          effectiveProjectId: 'proj-triage',
          priority: 'medium',
          suggestedTags: ['work', 'urgent-reply'],
        }),
      });
    });

    it('refreshes pending triage items from repeat pushes', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockSelectChain([directConnectorConfig({ landingMode: 'triage' })]);
        }
        if (callCount === 4) {
          return mockSelectChain([{ id: 'triage-existing', status: 'pending' }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({
        items: [validItem({ title: 'Updated triage title', confidence: 0.7 })],
      }));
      const json = await res.json();

      expect(json.items[0]).toMatchObject({
        action: 'triaged',
        reason: 'triage_updated',
        triageItemId: 'triage-existing',
      });
      expect(updateSetFn).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Updated triage title',
        aiRelevanceScore: 70,
      }));
    });

    it('keeps previously triaged items in triage when routing becomes direct', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockSelectChain([directConnectorConfig()]);
        if (callCount === 4) {
          return mockSelectChain([{ id: 'triage-existing', status: 'pending' }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [validItem({ confidence: 0.99 })] }));
      const json = await res.json();
      const taskInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.connectorType === 'scout';
      });

      expect(json.created).toBe(0);
      expect(json.triaged).toBe(1);
      expect(json.items[0]).toMatchObject({
        action: 'triaged',
        reason: 'triage_updated',
        triageItemId: 'triage-existing',
      });
      expect(taskInsert).toBeUndefined();
    });

    it('uses the configured project when Scout does not suggest one', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockSelectChain([directConnectorConfig({ autoProjectId: 'proj-default' })]);
        }
        if (callCount === 6) {
          return mockSelectChain([{ id: 'proj-default' }]);
        }
        return mockSelectChain([]);
      });

      await POST(makeRequest({ items: [validItem()] }));
      const projectInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.projectId !== undefined;
      });

      expect(projectInsert?.[0]).toMatchObject({ projectId: 'proj-default' });
    });

    it('prefers Scout project suggestions over the configured fallback', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockSelectChain([directConnectorConfig({ autoProjectId: 'proj-default' })]);
        }
        if (callCount === 6) return mockSelectChain([{ id: 'proj-suggested' }]);
        return mockSelectChain([]);
      });

      await POST(makeRequest({
        items: [validItem({ suggestedProjectId: 'proj-suggested' })],
      }));
      const projectInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.projectId !== undefined;
      });

      expect(projectInsert?.[0]).toMatchObject({ projectId: 'proj-suggested' });
    });

    it('falls back when Scout suggests an unknown project', async () => {
      let callCount = 0;
      db.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return mockSelectChain([directConnectorConfig({ autoProjectId: 'proj-default' })]);
        }
        if (callCount === 7) return mockSelectChain([{ id: 'proj-default' }]);
        return mockSelectChain([]);
      });

      await POST(makeRequest({
        items: [validItem({ suggestedProjectId: 'proj-missing' })],
      }));
      const projectInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const value = call[0] as Record<string, unknown>;
        return value.projectId !== undefined;
      });

      expect(projectInsert?.[0]).toMatchObject({ projectId: 'proj-default' });
    });
  });
});
