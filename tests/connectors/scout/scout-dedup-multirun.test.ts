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
 *
 * The route now owns no SQLite: `@/db` and `@/db/schema` are poisoned here so
 * the suite fails loudly if the handler ever reaches back into them, and every
 * write is observed through the backend-neutral ingestion port. Because the
 * fake ingestion port is genuinely stateful (unlike the old ad-hoc drizzle
 * mocks), sequential pushes within a test naturally observe each other's
 * writes — matching how a real SQLite/PostgreSQL backend behaves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FakeScoutIngestion,
  type FakeTask,
} from '../../contracts/scout-ingestion-reconciliation-persistence.contract';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

vi.mock('@/lib/dedup', () => ({
  findFuzzyMatches: vi.fn(() => []),
  isAutoLinkMatch: vi.fn(() => false),
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/semantic-index/publication', () => ({
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const workerRepositories = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => workerRepositories.current,
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

function expectedMetadata(item = baseItem()) {
  const context = item.context as Record<string, unknown>;
  return JSON.stringify({
    sourceType: item.sourceType,
    scoutContext: {
      confidence: item.confidence,
      reasoning: context.reasoning,
      from: context.from,
      sourceSubject: context.sourceSubject,
      extractedAt: context.extractedAt,
      originalSource: null,
      relatedSourceIds: [],
    },
    confidence: item.confidence,
  });
}

/** Seeds a pre-existing task as if created by an earlier Scout run. */
function seedExistingTask(
  ingestion: FakeScoutIngestion,
  overrides: Partial<FakeTask> & { id: string; sourceId: string },
): void {
  ingestion.tasks.set(overrides.id, {
    connectorType: 'scout',
    title: 'Follow up on Q3 budget review',
    description: 'Finance team needs updated numbers by Thursday',
    priority: 'medium',
    dueDate: null,
    metadata: expectedMetadata(),
    status: 'todo',
    snoozedUntil: null,
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Scout Multi-Run Deduplication', () => {
  let POST: (request: Request) => Promise<Response>;
  let ingestion: FakeScoutIngestion;

  beforeEach(async () => {
    vi.clearAllMocks();
    ingestion = new FakeScoutIngestion();
    workerRepositories.current = {
      scoutIngestionReconciliation: { ingestion },
    };

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
      const taskId = json1.items[0].mcTaskId as string;

      // Run 2: same item, unchanged — the fake ingestion port persists the
      // task created in Run 1, so the dedup lookup finds it for real.
      const res2 = await POST(makeRequest({ items: [baseItem()] }));
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      expect(json2.skipped).toBe(1);
      expect(json2.created).toBe(0);
      expect(json2.updated).toBe(0);
      expect(json2.items[0].action).toBe('skipped');
      expect(json2.items[0].reason).toBe('unchanged');
      expect(json2.items[0].mcTaskId).toBe(taskId);
    });
  });

  describe('Run 1 → Run 2: changed content triggers update', () => {
    it('updates when title changes between runs', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-existing-002',
        sourceId: 'scout:email:dedup-test-001',
        title: 'Follow up on Q3 budget review', // original title
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
      expect(ingestion.mergeWrites).toHaveLength(1);
      expect(ingestion.mergeWrites[0].taskWrite).toMatchObject({
        rendered: { title: 'URGENT: Follow up on Q3 budget review — CFO escalated' },
      });
    });

    it('updates when priority changes between runs', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-existing-003',
        sourceId: 'scout:email:dedup-test-001',
        priority: 'medium', // original priority
      });

      // Push with escalated priority
      const res = await POST(makeRequest({ items: [baseItem({ priority: 'critical' })] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
      expect(ingestion.mergeWrites[0].taskWrite).toMatchObject({
        rendered: { priority: 'critical' },
      });
    });

    it('updates when description changes between runs', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-existing-004',
        sourceId: 'scout:email:dedup-test-001',
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
      expect(ingestion.mergeWrites[0].taskWrite).toMatchObject({
        rendered: {
          description: 'Finance team needs updated numbers by Thursday. CFO sent a follow-up asking for breakdown by department.',
        },
      });
    });

    it('updates when dueDate is added on subsequent run', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-existing-005',
        sourceId: 'scout:email:dedup-test-001',
        dueDate: null, // no due date originally
      });

      const res = await POST(makeRequest({
        items: [baseItem({ dueDate: '2026-07-31' })],
      }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
      expect(ingestion.mergeWrites[0].taskWrite).toMatchObject({
        rendered: { dueDate: '2026-07-31' },
      });
    });
  });

  describe('closed tasks are protected', () => {
    it('skips update for tasks with status "done"', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-done-001',
        sourceId: 'scout:email:dedup-test-001',
        status: 'done',
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
      // the task itself should NOT be updated
      expect(ingestion.mergeWrites).toEqual([]);
      expect(ingestion.tasks.get('tsk-done-001')?.title).toBe('Follow up on Q3 budget review');
    });

    it('skips update for tasks with status "cancelled"', async () => {
      seedExistingTask(ingestion, {
        id: 'tsk-cancelled-001',
        sourceId: 'scout:email:dedup-test-001',
        description: null,
        priority: 'none',
        status: 'cancelled',
      });

      const res = await POST(makeRequest({ items: [baseItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('task_closed');
      expect(ingestion.mergeWrites).toEqual([]);
    });

    it('skips update for snoozed tasks (snooze not yet expired)', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      seedExistingTask(ingestion, {
        id: 'tsk-snoozed-001',
        sourceId: 'scout:email:dedup-test-001',
        snoozedUntil: futureDate,
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
      expect(ingestion.mergeWrites).toEqual([]);
    });

    it('allows update for tasks with expired snooze', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      seedExistingTask(ingestion, {
        id: 'tsk-expired-snooze-001',
        sourceId: 'scout:email:dedup-test-001',
        title: 'Old title',
        description: 'Old description',
        priority: 'low',
        snoozedUntil: pastDate,
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
      seedExistingTask(ingestion, {
        id: 'tsk-unchanged',
        sourceId: 'scout:email:unchanged-001',
        title: 'Existing unchanged task',
        description: 'Same description',
        priority: 'low',
        metadata: expectedMetadata(baseItem({
          sourceId: 'scout:email:unchanged-001',
          title: 'Existing unchanged task',
          description: 'Same description',
          priority: 'low',
        })),
      });
      seedExistingTask(ingestion, {
        id: 'tsk-changed',
        sourceId: 'scout:email:changed-001',
        title: 'Old title',
        description: 'Old description',
        priority: 'low',
      });
      seedExistingTask(ingestion, {
        id: 'tsk-closed',
        sourceId: 'scout:email:closed-001',
        title: 'Closed task',
        description: null,
        priority: 'none',
        status: 'done',
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
    it('has the second item observe the first item\'s write since intra-batch dedup is not client-tracked', async () => {
      // Intra-batch dedup is handled by Scout's pre-push logic (mc_search_tasks),
      // not by the ingest endpoint. The endpoint processes items sequentially,
      // and each item's dedup lookup runs against the shared, stateful
      // ingestion port — just like a real SQLite/PostgreSQL backend, the
      // second item's lookup observes the first item's just-committed write
      // and is merged into it rather than creating a duplicate.
      const items = [
        baseItem({ sourceId: 'scout:email:dup-within-batch', title: 'First push' }),
        baseItem({ sourceId: 'scout:email:dup-within-batch', title: 'Second push same ID' }),
      ];

      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(2);
      expect(json.created).toBe(1);
      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('created');
      expect(json.items[1].action).toBe('updated');
      expect(json.items[1].mcTaskId).toBe(json.items[0].mcTaskId);
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

      // Push 2: items B (exists, unchanged), C (new)
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
