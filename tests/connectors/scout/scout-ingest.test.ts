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
 *
 * The route now owns no SQLite: `@/db` and `@/db/schema` are poisoned here so
 * the suite fails loudly if the handler ever reaches back into them, and every
 * write is observed through the backend-neutral ingestion port.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskFieldStateRecord } from '@/lib/tasks/field-state';
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

const mockFindFuzzyMatches = vi.hoisted(() => vi.fn(() => []));

vi.mock('@/lib/dedup', () => ({
  findFuzzyMatches: mockFindFuzzyMatches,
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

function existingTask(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    id: 'tsk-existing',
    sourceId: 'scout:email:msg-123',
    connectorType: 'scout',
    title: 'Reply to Johnson about project timeline',
    description: 'Johnson asked about Q3 delivery dates in yesterday\'s email',
    priority: 'medium',
    dueDate: null,
    metadata: expectedMetadata(),
    status: 'todo',
    snoozedUntil: null,
    ...overrides,
  };
}

function fieldState(
  fieldName: string,
  value: unknown,
  locallyOverridden = false,
): TaskFieldStateRecord {
  return {
    taskId: 'tsk-existing',
    fieldName,
    sourceValue: JSON.stringify(value),
    locallyOverridden,
    sourceObservedAt: '2026-08-01T00:00:00.000Z',
    localEditedAt: locallyOverridden ? '2026-08-02T00:00:00.000Z' : null,
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/scout/ingest', () => {
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

    it('accepts requests with a valid bearer token', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const req = new Request('http://localhost:3099/api/scout/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'test-secret-key'}` },
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

    it('validates the whole request before writing anything', async () => {
      const res = await POST(makeRequest({
        items: [validItem(), validItem({ sourceId: 'scout:email:bad', title: '' })],
      }));

      expect(res.status).toBe(400);
      expect(ingestion.creations).toEqual([]);
      expect(ingestion.triageWrites).toEqual([]);
    });

    it('rejects the batch when the connector is disabled', async () => {
      ingestion.connector = { ...ingestion.connector, enabled: false };

      const res = await POST(makeRequest({ items: [validItem()] }));

      expect(res.status).toBe(403);
      expect(ingestion.creations).toEqual([]);
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

    it('writes the task with scout connector identity, tags, and provenance metadata', async () => {
      await POST(makeRequest({ items: [validItem()] }));

      expect(ingestion.creations).toHaveLength(1);
      const creation = ingestion.creations[0];
      expect(creation).toMatchObject({
        connectorType: 'scout',
        connectorInstanceId: 'scout-primary',
        sourceId: 'scout:email:msg-123',
        sourceListId: 'scout:email-actions',
        sourceListName: 'Email Actions',
        status: 'todo',
      });
      expect(creation.tags.map((tag) => tag.id)).toEqual(['tag-work', 'tag-urgent-reply']);
      expect(JSON.parse(creation.metadata)).toMatchObject({
        sourceType: 'email',
        scoutContext: expect.objectContaining({ confidence: 0.85 }),
      });
    });

    it('records initial source snapshots without local overrides', async () => {
      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);

      expect(ingestion.creations[0].fieldStates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'title',
          sourceValue: '"Reply to Johnson about project timeline"',
          locallyOverridden: false,
        }),
        expect.objectContaining({ fieldName: 'description', locallyOverridden: false }),
        expect.objectContaining({ fieldName: 'priority', locallyOverridden: false }),
        expect.objectContaining({
          fieldName: 'dueDate',
          sourceValue: 'null',
          locallyOverridden: false,
        }),
      ]));
    });

    it('requeues a concurrent first-ingest loser through normal merge semantics', async () => {
      ingestion.conflictWinnerId = 'tsk-concurrent-winner';
      ingestion.tasks.set('tsk-concurrent-winner', existingTask({
        id: 'tsk-concurrent-winner',
        title: 'Earlier concurrent observation',
        description: null,
        priority: 'none',
        metadata: '{}',
      }));

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toMatchObject({ created: 0, updated: 1, skipped: 0, total: 1 });
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

      const metadata = JSON.parse(ingestion.creations[0].metadata);
      expect(metadata.scoutContext.confidence).toBe(0.91);
      expect(metadata.scoutContext.reasoning).toBe('Test reasoning value');
      expect(metadata.scoutContext.originalSource).toEqual({ type: 'email', from: 'test@example.com' });
    });
  });

  describe('deduplication', () => {
    it('skips unchanged existing task', async () => {
      ingestion.tasks.set('tsk-existing', existingTask());
      ingestion.fieldStates.set('tsk-existing', [
        fieldState('title', 'Reply to Johnson about project timeline'),
        fieldState('description', 'Johnson asked about Q3 delivery dates in yesterday\'s email'),
        fieldState('priority', 'medium'),
        fieldState('dueDate', null),
      ]);

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.created).toBe(0);
      expect(json.items[0].action).toBe('skipped');
      expect(json.items[0].reason).toBe('unchanged');
    });

    it('updates existing task when content changed', async () => {
      ingestion.tasks.set('tsk-existing', existingTask({
        title: 'Old title that differs',
        description: 'Old description',
        priority: 'low',
        metadata: '{}',
      }));

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.updated).toBe(1);
      expect(json.items[0].action).toBe('updated');
      expect(json.items[0].mcTaskId).toBe('tsk-existing');
      expect(json.items[0].appliedFields).toEqual(['title', 'description', 'priority']);
      expect(json.items[0].unchangedFields).toContain('dueDate');
      expect(ingestion.mergeWrites[0].taskWrite).toMatchObject({
        rendered: {
          title: 'Reply to Johnson about project timeline',
          priority: 'medium',
        },
      });
    });

    it('advances source snapshots without overwriting local overrides', async () => {
      ingestion.tasks.set('tsk-existing', existingTask({
        title: 'Local title',
        description: null,
        priority: 'none',
        metadata: '{}',
      }));
      ingestion.fieldStates.set('tsk-existing', [
        fieldState('title', 'Old source title', true),
      ]);

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      expect(ingestion.mergeWrites[0].taskWrite?.rendered).not.toHaveProperty('title');
      expect(ingestion.mergeWrites[0].observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'title',
          sourceValue: '"Reply to Johnson about project timeline"',
          locallyOverridden: true,
        }),
      ]));
    });

    it('preserves a local edit committed after the initial deduplication read', async () => {
      const item = validItem();
      ingestion.tasks.set('tsk-existing', existingTask());
      ingestion.fieldStates.set('tsk-existing', [fieldState('title', item.title, true)]);
      ingestion.mergeSnapshotOverride = existingTask({ title: 'Concurrent local title' });

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.updated).toBe(0);
      expect(json.skipped).toBe(1);
      expect(json.items[0].reason).toBe('unchanged');
    });

    it('clears an override when the source converges without changing the rendered task', async () => {
      const item = validItem({ priority: 'high' });
      ingestion.tasks.set('tsk-existing', existingTask({
        priority: 'high',
        metadata: expectedMetadata(item),
      }));
      ingestion.fieldStates.set('tsk-existing', [fieldState('priority', 'none', true)]);

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      expect(ingestion.mergeWrites[0].observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'priority',
          sourceValue: '"high"',
          locallyOverridden: false,
        }),
      ]));
    });

    it('preserves overrides independently across all mergeable fields', async () => {
      ingestion.tasks.set('tsk-existing', existingTask({
        title: 'Local title',
        description: 'Local description',
        priority: 'critical',
        dueDate: '2026-09-01',
        metadata: JSON.stringify({ missionControl: { pinned: true } }),
      }));
      ingestion.fieldStates.set('tsk-existing', [
        fieldState('title', 'Old source title', true),
        fieldState('description', 'Old source description', true),
        fieldState('priority', 'low', true),
        fieldState('dueDate', '2026-08-01', true),
      ]);

      const res = await POST(makeRequest({ items: [validItem({ dueDate: '2026-08-15' })] }));
      const json = await res.json();

      const rendered = ingestion.mergeWrites[0].taskWrite?.rendered ?? {};
      expect(rendered).not.toHaveProperty('title');
      expect(rendered).not.toHaveProperty('description');
      expect(rendered).not.toHaveProperty('priority');
      expect(rendered).not.toHaveProperty('dueDate');
      expect(json.items[0]).toMatchObject({
        action: 'updated',
        appliedFields: [],
        preservedOverrides: ['title', 'description', 'priority', 'dueDate'],
        unchangedFields: [],
      });
    });

    it('clears an override when Scout converges on the local value', async () => {
      ingestion.tasks.set('tsk-existing', existingTask({
        priority: 'high',
        metadata: '{}',
      }));
      ingestion.fieldStates.set('tsk-existing', [
        fieldState('priority', 'medium', true),
        fieldState('title', 'Reply to Johnson about project timeline'),
        fieldState('description', 'Johnson asked about Q3 delivery dates in yesterday\'s email'),
        fieldState('dueDate', null),
      ]);

      const res = await POST(makeRequest({ items: [validItem({ priority: 'high' })] }));
      const json = await res.json();
      expect(json.items[0].appliedFields).toContain('priority');
      expect(ingestion.mergeWrites[0].observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldName: 'priority', locallyOverridden: false }),
      ]));
    });

    it('refreshes Scout provenance while preserving unrelated metadata', async () => {
      const item = validItem();
      ingestion.tasks.set('tsk-existing', existingTask({
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
      }));

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      expect(JSON.parse(ingestion.mergeWrites[0].taskWrite!.metadata)).toMatchObject({
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
      ingestion.tasks.set('tsk-existing', existingTask({ metadata: 'not-json' }));

      const res = await POST(makeRequest({ items: [item] }));
      expect(res.status).toBe(200);
      expect((await res.json()).updated).toBe(1);
      expect(JSON.parse(ingestion.mergeWrites[0].taskWrite!.metadata)).toMatchObject({
        legacyMetadata: 'not-json',
        sourceType: 'email',
      });
    });

    it('suppresses a tombstoned item before task creation or source linking', async () => {
      ingestion.suppressions.add('scout:email:msg-123');

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();

      expect(json.items[0]).toMatchObject({
        action: 'suppressed',
        reason: 'ingest_tombstone',
        appliedFields: [],
        preservedOverrides: [],
        unchangedFields: [],
      });
      expect(ingestion.creations).toEqual([]);
      expect(ingestion.linkWrites).toEqual([]);
    });

    it('keeps repeated pushes attached to the existing linked task', async () => {
      ingestion.links.set('scout:email:msg-123', 'remote-task-1');

      const res = await POST(makeRequest({ items: [validItem({ title: 'Changed source title' })] }));
      const json = await res.json();

      expect(json.items[0]).toMatchObject({
        action: 'linked',
        reason: 'existing_link',
        mcTaskId: 'remote-task-1',
        linkedTo: 'remote-task-1',
      });
      expect(ingestion.creations).toEqual([]);
    });

    it('skips update for completed tasks', async () => {
      ingestion.tasks.set('tsk-done', existingTask({
        id: 'tsk-done',
        title: 'Old title',
        description: null,
        priority: 'none',
        metadata: '{}',
        status: 'done',
      }));

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.skipped).toBe(1);
      expect(json.items[0].action).toBe('suppressed');
      expect(json.items[0].reason).toBe('task_closed');
      expect(ingestion.mergeWrites).toEqual([]);
    });
  });

  describe('source list auto-creation', () => {
    it('creates the source list for a newly ingested source type', async () => {
      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      expect(ingestion.createdSourceLists).toEqual(['scout:email-actions']);
      expect(ingestion.countRefreshes).toEqual([
        expect.objectContaining({ sourceListId: 'scout:email-actions' }),
      ]);
    });

    it('does not re-create source list if it already exists', async () => {
      ingestion.sourceLists.add('scout:email-actions');

      const res = await POST(makeRequest({ items: [validItem()] }));
      expect(res.status).toBe(200);
      expect(ingestion.createdSourceLists).toEqual([]);
    });
  });

  it('normalizes PostgreSQL jsonb candidate metadata before fuzzy matching', async () => {
    ingestion.crossConnectorCandidates = [{
      id: 'github-task-1',
      title: 'Reply to Johnson about project timeline',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-primary',
      sourceId: 'github:issue:1',
      metadata: {
        scoutContext: {
          from: 'johnson@corp.com',
          sourceSubject: 'Re: Q3 Project Timeline',
        },
      },
    }];

    const res = await POST(makeRequest({ items: [validItem()] }));

    expect(res.status).toBe(200);
    expect(mockFindFuzzyMatches).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({
        id: 'github-task-1',
        metadata: JSON.stringify(ingestion.crossConnectorCandidates[0].metadata),
      })],
      expect.objectContaining({
        contextFrom: 'johnson@corp.com',
        contextSubject: 'Re: Q3 Project Timeline',
      }),
    );
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
    function withSettings(overrides: Record<string, unknown>) {
      ingestion.connector = {
        ...ingestion.connector,
        settings: {
          ...(ingestion.connector.settings as Record<string, unknown>),
          ...overrides,
        },
      };
    }

    it('skips source types that are not allowed', async () => {
      withSettings({ allowedSourceTypes: ['teams'] });

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
      withSettings({ landingMode: 'triage' });

      const res = await POST(makeRequest({ items: [validItem()] }));
      const json = await res.json();

      expect(json.created).toBe(0);
      expect(json.triaged).toBe(1);
      expect(json.items[0].action).toBe('triaged');
      expect(json.items[0].reason).toBe('landing_mode');
      expect(ingestion.triageWrites[0]).toMatchObject({
        sourcePlatform: 'scout',
        sourceId: 'scout:email:msg-123',
      });
      expect(ingestion.creations).toEqual([]);
    });

    it('routes low-confidence hybrid items to triage', async () => {
      withSettings({ landingMode: 'hybrid', hybridConfidenceThreshold: 0.8 });

      const res = await POST(makeRequest({
        items: [validItem({ confidence: 0.79 })],
      }));
      const json = await res.json();

      expect(json.triaged).toBe(1);
      expect(json.items[0].action).toBe('triaged');
    });

    it('stores the effective default project on triaged items', async () => {
      withSettings({ landingMode: 'triage', autoProjectId: 'proj-triage' });
      ingestion.projects.add('proj-triage');

      await POST(makeRequest({ items: [validItem()] }));

      expect(ingestion.triageWrites[0].values.rawMetadata).toMatchObject({
        effectiveProjectId: 'proj-triage',
        priority: 'medium',
        suggestedTags: ['work', 'urgent-reply'],
      });
    });

    it('refreshes pending triage items from repeat pushes', async () => {
      withSettings({ landingMode: 'triage' });
      ingestion.triageItems.set('scout:email:msg-123', {
        id: 'triage-existing',
        status: 'pending',
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
      expect(ingestion.triageWrites[0].values).toMatchObject({
        title: 'Updated triage title',
        aiRelevanceScore: 70,
      });
    });

    it('keeps previously triaged items in triage when routing becomes direct', async () => {
      ingestion.triageItems.set('scout:email:msg-123', {
        id: 'triage-existing',
        status: 'pending',
      });

      const res = await POST(makeRequest({ items: [validItem({ confidence: 0.99 })] }));
      const json = await res.json();

      expect(json.created).toBe(0);
      expect(json.triaged).toBe(1);
      expect(json.items[0]).toMatchObject({
        action: 'triaged',
        reason: 'triage_updated',
        triageItemId: 'triage-existing',
      });
      expect(ingestion.creations).toEqual([]);
    });

    it('never reopens a closed triage item', async () => {
      ingestion.triageItems.set('scout:email:msg-123', {
        id: 'triage-closed',
        status: 'actioned',
      });

      const res = await POST(makeRequest({ items: [validItem({ confidence: 0.99 })] }));
      const json = await res.json();

      expect(json.triaged).toBe(0);
      expect(json.skipped).toBe(1);
      expect(json.items[0]).toMatchObject({
        action: 'suppressed',
        reason: 'triage_closed',
        triageItemId: 'triage-closed',
      });
    });

    it('uses the configured project when Scout does not suggest one', async () => {
      withSettings({ autoProjectId: 'proj-default' });
      ingestion.projects.add('proj-default');

      await POST(makeRequest({ items: [validItem()] }));

      expect(ingestion.creations[0].projectId).toBe('proj-default');
    });

    it('prefers Scout project suggestions over the configured fallback', async () => {
      withSettings({ autoProjectId: 'proj-default' });
      ingestion.projects.add('proj-default');
      ingestion.projects.add('proj-suggested');

      await POST(makeRequest({
        items: [validItem({ suggestedProjectId: 'proj-suggested' })],
      }));

      expect(ingestion.creations[0].projectId).toBe('proj-suggested');
    });

    it('falls back when Scout suggests an unknown project', async () => {
      withSettings({ autoProjectId: 'proj-default' });
      ingestion.projects.add('proj-default');

      await POST(makeRequest({
        items: [validItem({ suggestedProjectId: 'proj-missing' })],
      }));

      expect(ingestion.creations[0].projectId).toBe('proj-default');
    });
  });
});
