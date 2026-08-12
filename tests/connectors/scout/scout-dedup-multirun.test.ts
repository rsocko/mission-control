/**
 * Scout Connector — Multi-Run Deduplication Validation
 *
 * Tests that deduplication works correctly across multiple sequential
 * ingest calls, simulating real Scout automation runs:
 * - Run 1: Items created fresh
 * - Run 2: Same items → skipped (unchanged)
 * - Run 2 variant: Same sourceId, changed content → updated
 * - Closed tasks are never reopened or updated
 * - Mixed batches (new + existing + changed) produce correct counts
 *
 * Issue: #1394 [F-11]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const insertValuesFn = vi.fn(() => ({
  run: vi.fn(),
  onConflictDoNothing: vi.fn(() => ({ run: vi.fn(() => ({ changes: 1 })) })),
  onConflictDoUpdate: vi.fn(() => ({ run: vi.fn() })),
}));
const mockInsert = vi.fn(() => ({ values: insertValuesFn }));
const updateSetFn = vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
const mockUpdate = vi.fn(() => ({ set: updateSetFn }));
let mockTransactionTask: Record<string, unknown> | null = null;

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
  runTransaction: vi.fn((fn: (tx: unknown) => unknown) => {
    return fn({
      select: vi.fn((selection?: Record<string, unknown>) => (
        selection?.status && mockTransactionTask
          ? mockSelectChain([mockTransactionTask])
          : mockSelectChain([])
      )),
      insert: mockInsert,
      update: mockUpdate,
    });
  }),
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

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'scout:email:dedup-test-001',
    sourceType: 'email',
    title: 'Follow up on Q3 budget review',
    description: 'Finance team needs updated numbers by Thursday',
    priority: 'medium',
    confidence: 0.85,
    context: {
      from: 'finance@corp.com',
      sourceSubject: 'Q3 Budget Review',
      extractedAt: '2026-07-29T07:00:00Z',
      reasoning: 'Direct request with deadline',
    },
    ...overrides,
  };
}

function expectedMetadata() {
  const item = baseItem();
  return JSON.stringify({
    sourceType: item.sourceType,
    scoutContext: {
      confidence: item.confidence,
      reasoning: item.context.reasoning,
      from: item.context.from,
      sourceSubject: item.context.sourceSubject,
      extractedAt: item.context.extractedAt,
      originalSource: null,
      relatedSourceIds: [],
    },
    confidence: item.confidence,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Scout Multi-Run Deduplication', () => {
  let POST: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockTransactionTask = null;

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as { select: ReturnType<typeof vi.fn> };
    db.select.mockImplementation(() => mockSelectChain([]));

    const mod = await import('@/app/api/scout/ingest/route');
    POST = mod.POST;
  });

  describe('Run 1 → Run 2: identical items skipped', () => {
    it('skips items that already exist with identical content', async () => {
      // Run 1: create the item (no existing task)
      const res1 = await POST(makeRequest({ items: [baseItem()] }));
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.created).toBe(1);

      // Run 2: same item exists in DB, unchanged
      db.select.mockImplementation(() => {
        return mockSelectChain([]);
      });

      // For Run 2, simulate the task existing by mocking the select to
      // return the existing task on the dedup check
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        // Third select call: task dedup check (after candidates fetch + source list)
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing-001',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res2 = await POST(makeRequest({ items: [baseItem()] }));
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      expect(json2.skipped).toBe(1);
      expect(json2.created).toBe(0);
      expect(json2.updated).toBe(0);
      expect(json2.items[0].action).toBe('skipped');
      expect(json2.items[0].reason).toBe('unchanged');
      expect(json2.items[0].mcTaskId).toBe('tsk-existing-001');
    });
  });

  describe('Run 1 → Run 2: changed content triggers update', () => {
    it('updates when title changes between runs', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing-002',
            title: 'Follow up on Q3 budget review',  // original title
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      // Push with changed title
      const changedItem = baseItem({
        title: 'URGENT: Follow up on Q3 budget review — CFO escalated',
      });
      const res = await POST(makeRequest({ items: [changedItem] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.created).toBe(0);
      expect(json.skipped).toBe(0);
      expect(json.items[0].action).toBe('updated');
      expect(json.items[0].mcTaskId).toBe('tsk-existing-002');
      expect(mockUpdate).toHaveBeenCalled();
    });

    it('updates when priority changes between runs', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing-003',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',  // original priority
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      // Push with escalated priority
      const res = await POST(makeRequest({ items: [baseItem({ priority: 'critical' })] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
    });

    it('updates when description changes between runs', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing-004',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({
        items: [baseItem({
          description: 'Finance team needs updated numbers by Thursday. CFO sent a follow-up asking for breakdown by department.',
        })],
      }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
    });

    it('updates when dueDate is added on subsequent run', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-existing-005',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,  // no due date originally
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({
        items: [baseItem({ dueDate: '2026-07-31' })],
      }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
    });
  });

  describe('closed tasks are protected', () => {
    it('skips update for tasks with status "done"', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-done-001',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'done',
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({
        items: [baseItem({ title: 'Changed title should not matter' })],
      }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.updated).toBe(0);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('task_closed');
      // but the task itself should NOT be updated — verify via updateSetFn
      // not being called with task fields (title, description, etc.)
      const taskUpdateCalls = updateSetFn.mock.calls.filter((call: unknown[]) => {
        const setObj = call[0] as Record<string, unknown>;
        return setObj.title !== undefined;
      });
      expect(taskUpdateCalls).toHaveLength(0);
    });

    it('skips update for tasks with status "cancelled"', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-cancelled-001',
            title: 'Follow up on Q3 budget review',
            description: null,
            priority: 'none',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'cancelled',
            snoozedUntil: null,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [baseItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('task_closed');
    });

    it('skips update for snoozed tasks (snooze not yet expired)', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-snoozed-001',
            title: 'Follow up on Q3 budget review',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
            snoozedUntil: futureDate,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({
        items: [baseItem({ title: 'Updated title should be ignored while snoozed' })],
      }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.created).toBe(0);
      expect(json.updated).toBe(0);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('snoozed');
    });

    it('allows update for tasks with expired snooze', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-expired-snooze-001',
            title: 'Old title',
            description: 'Old description',
            priority: 'low',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
            snoozedUntil: pastDate,
          }]);
        }
        return mockSelectChain([]);
      });

      const res = await POST(makeRequest({ items: [baseItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
    });
  });

  describe('mixed batches across runs', () => {
    it('handles a batch with new, unchanged, changed, and closed items', async () => {
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;

        // Call 1: connector settings, call 2: batch-level candidates.

        // Item 1: task check (3), triage check (4), then source-list check (5).

        if (selectCallCount === 5) return mockSelectChain([{ id: 'sl-scout-email' }]);

        // Item 2: task check (6) returns existing, unchanged.
        if (selectCallCount === 6) return mockSelectChain([{
          id: 'tsk-unchanged',
          title: 'Existing unchanged task',
          description: 'Same description',
          priority: 'low',
          dueDate: null,
          metadata: expectedMetadata(),
          status: 'todo',
        }]);

        // Item 3: task check (7) returns existing, changed.
        if (selectCallCount === 7) return mockSelectChain([{
          id: 'tsk-changed',
          title: 'Old title',
          description: 'Old description',
          priority: 'low',
          dueDate: null,
          metadata: expectedMetadata(),
          status: 'todo',
        }]);

        // Item 4: task check (8) returns existing, done.
        if (selectCallCount === 8) return mockSelectChain([{
          id: 'tsk-closed',
          title: 'Closed task',
          description: null,
          priority: 'none',
          dueDate: null,
          metadata: expectedMetadata(),
          status: 'done',
        }]);

        return mockSelectChain([]);
      });

      const items = [
        baseItem({ sourceId: 'scout:email:new-001', title: 'Brand new task' }),
        baseItem({ sourceId: 'scout:email:unchanged-001', title: 'Existing unchanged task', description: 'Same description', priority: 'low' }),
        baseItem({ sourceId: 'scout:email:changed-001', title: 'Updated title', description: 'Updated description', priority: 'high' }),
        baseItem({ sourceId: 'scout:email:closed-001', title: 'Closed task' }),
      ];

      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.total).toBe(4);
      expect(json.created).toBe(1);
      expect(json.updated).toBe(1);
      expect(json.skipped).toBe(2); // 1 unchanged + 1 closed

      // Verify per-item actions
      const actions = json.items.map((i: { sourceId: string; action: string; reason?: string }) => ({
        sourceId: i.sourceId,
        action: i.action,
        reason: i.reason,
      }));

      expect(actions).toEqual([
        { sourceId: 'scout:email:new-001', action: 'created', reason: undefined },
        { sourceId: 'scout:email:unchanged-001', action: 'skipped', reason: 'unchanged' },
        { sourceId: 'scout:email:changed-001', action: 'updated', reason: undefined },
        { sourceId: 'scout:email:closed-001', action: 'suppressed', reason: 'task_closed' },
      ]);
    });
  });

  describe('duplicate sourceIds within same batch', () => {
    it('processes both items since intra-batch dedup is not enforced (server-side)', async () => {
      // Intra-batch dedup is handled by Scout's pre-push logic (mc_search_tasks),
      // not by the ingest endpoint. The endpoint processes items sequentially and
      // each item's DB lookup runs independently. With no stateful in-memory tracking,
      // both items will be created. This test documents that behavior.
      const items = [
        baseItem({ sourceId: 'scout:email:dup-within-batch', title: 'First push' }),
        baseItem({ sourceId: 'scout:email:dup-within-batch', title: 'Second push same ID' }),
      ];

      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(2);
      // Both are created since DB mock returns empty for both dedup checks.
      // In production, the DB unique constraint on sourceId would prevent true duplicates.
      expect(json.created).toBe(2);
    });
  });

  describe('rapid sequential pushes', () => {
    it('handles back-to-back pushes of overlapping batches', async () => {
      // Push 1: items A, B
      const res1 = await POST(makeRequest({
        items: [
          baseItem({ sourceId: 'scout:email:rapid-A', title: 'Task A' }),
          baseItem({ sourceId: 'scout:email:rapid-B', title: 'Task B' }),
        ],
      }));
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.created).toBe(2);

      // Push 2: items B (exists), C (new)
      let selectCallCount = 0;
      db.select.mockImplementation(() => {
        selectCallCount++;
        // Item B: task check returns existing
        if (selectCallCount === 3) {
          return mockSelectChain([{
            id: 'tsk-rapid-B',
            title: 'Task B',
            description: 'Finance team needs updated numbers by Thursday',
            priority: 'medium',
            dueDate: null,
            metadata: expectedMetadata(),
            status: 'todo',
          }]);
        }
        return mockSelectChain([]);
      });

      const res2 = await POST(makeRequest({
        items: [
          baseItem({ sourceId: 'scout:email:rapid-B', title: 'Task B' }),
          baseItem({ sourceId: 'scout:email:rapid-C', title: 'Task C' }),
        ],
      }));
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      expect(json2.skipped).toBe(1);  // B unchanged
      expect(json2.created).toBe(1);  // C new
      expect(json2.total).toBe(2);
    });
  });
});
