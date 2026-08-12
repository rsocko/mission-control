/**
 * Scout Connector — End-to-End Integration Test
 *
 * Tests the full flow: Scout pushes items via mc_scout_push_tasks →
 * POST /api/scout/ingest → task appears in MC with correct:
 * - Task fields (title, description, priority, status, dueDate)
 * - Connector provenance (connectorType, connectorInstanceId, sourceId)
 * - Scout metadata (scoutContext, sourceType, confidence)
 * - Source list assignment
 * - Tag resolution and assignment
 * - Project assignment
 * - Event emission for real-time UI updates
 *
 * Issue: #1391 [F-10]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const insertValuesFn = vi.fn((_values: unknown) => ({
  run: vi.fn(),
  onConflictDoNothing: vi.fn(() => ({ run: vi.fn(() => ({ changes: 1 })) })),
  onConflictDoUpdate: vi.fn(() => ({ run: vi.fn() })),
}));
const mockInsert = vi.fn(() => ({ values: insertValuesFn }));
const updateSetFn = vi.fn((_values: unknown) => ({ where: vi.fn(() => ({ run: vi.fn() })) }));
const mockUpdate = vi.fn(() => ({ set: updateSetFn }));

function mockSelectChain(results: unknown[]) {
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
    select: vi.fn(() => mockSelectChain([])),
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

const mockEmitEvent = vi.fn();
vi.mock('@/lib/events', () => ({
  emitEvent: mockEmitEvent,
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3099/api/scout/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Simulates a realistic Scout-pushed email action item with full context.
 */
function emailActionItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'scout:email:AAMkAGNiY2I3ZjRiLTZjNzgtNGFkMi1hMDQ3',
    sourceType: 'email',
    title: 'Reply to Johnson about Q3 project timeline',
    description: 'Johnson asked about Q3 delivery dates in yesterday\'s email. He needs a firm commitment by EOW for the board deck.',
    priority: 'high',
    dueDate: '2026-08-01',
    confidence: 0.92,
    context: {
      from: 'johnson@corp.com',
      sourceSubject: 'Re: Q3 Project Timeline — Need Dates',
      extractedAt: '2026-07-29T07:15:00Z',
      reasoning: 'Direct question from manager requiring reply with deadline commitment. Board deck dependency makes this high priority.',
      relatedSourceIds: [],
    },
    suggestedTags: ['work', 'urgent-reply', 'q3-planning'],
    ...overrides,
  };
}

/**
 * Simulates a Teams action item.
 */
function teamsActionItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'scout:teams:msg-20260729-abc123',
    sourceType: 'teams',
    title: 'Share updated budget numbers with finance team',
    description: 'CFO asked in #finance channel for updated budget projections by Thursday.',
    priority: 'medium',
    confidence: 0.78,
    context: {
      from: 'cfo@corp.com',
      sourceSubject: '#finance — Budget Projections',
      extractedAt: '2026-07-29T07:20:00Z',
      reasoning: 'Direct request from CFO in team channel with specific deadline.',
    },
    suggestedTags: ['finance', 'budget'],
    ...overrides,
  };
}

/**
 * Simulates a meeting follow-up action item.
 */
function meetingActionItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'scout:meeting:evt-20260728-standup:0',
    sourceType: 'meeting',
    title: 'Prepare demo for Thursday sprint review',
    description: 'Committed in yesterday\'s standup to demo the Scout integration. Need working E2E flow.',
    priority: 'high',
    dueDate: '2026-07-31',
    confidence: 0.95,
    context: {
      from: 'self (commitment)',
      sourceSubject: 'Daily Standup — 2026-07-28',
      extractedAt: '2026-07-29T07:25:00Z',
      reasoning: 'Self-assigned commitment made during standup. Demo date is fixed.',
    },
    suggestedTags: ['sprint-review', 'demo'],
    suggestedProjectId: 'proj-scout-integration',
    ...overrides,
  };
}

const directConnectorConfig = {
  id: 'scout-primary',
  enabled: true,
  settings: {
    landingMode: 'direct',
    allowedSourceTypes: ['email', 'teams', 'meeting', 'planner', 'cross-source'],
    hybridConfidenceThreshold: 0.8,
    autoProjectId: null,
  },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Scout E2E: Full push flow', () => {
  let POST: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as { select: ReturnType<typeof vi.fn> };
    let selectCall = 0;
    db.select.mockImplementation(() => {
      selectCall++;
      return mockSelectChain(selectCall === 1 ? [directConnectorConfig] : []);
    });

    const mod = await import('@/app/api/scout/ingest/route');
    POST = mod.POST;
  });

  describe('realistic morning triage batch', () => {
    it('processes a mixed-source batch (email + Teams + meeting) in one push', async () => {
      const items = [emailActionItem(), teamsActionItem(), meetingActionItem()];
      const res = await POST(makeRequest({ items }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.created).toBe(3);
      expect(json.updated).toBe(0);
      expect(json.skipped).toBe(0);
      expect(json.total).toBe(3);

      // Each item should have a unique MC task ID
      const mcTaskIds = json.items.map((i: { mcTaskId: string }) => i.mcTaskId);
      expect(new Set(mcTaskIds).size).toBe(3);
      mcTaskIds.forEach((id: string) => expect(id).toBeTruthy());
    });

    it('creates tasks with correct connector provenance', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      // Find the task insert call
      const taskInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.connectorType === 'scout';
      });

      expect(taskInsert).toBeTruthy();
      const taskData = taskInsert![0] as Record<string, unknown>;
      expect(taskData.connectorType).toBe('scout');
      expect(taskData.connectorInstanceId).toBe('scout-primary');
      expect(taskData.sourceId).toBe('scout:email:AAMkAGNiY2I3ZjRiLTZjNzgtNGFkMi1hMDQ3');
      expect(taskData.status).toBe('todo');
      expect(taskData.syncStatus).toBe('synced');
    });

    it('preserves Scout context in task metadata', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      const taskInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.connectorType === 'scout' && typeof val.metadata === 'string';
      });

      expect(taskInsert).toBeTruthy();
      const metadata = JSON.parse(
        (taskInsert![0] as Record<string, unknown>).metadata as string,
      );
      expect(metadata.sourceType).toBe('email');
      expect(metadata.scoutContext).toBeDefined();
      expect(metadata.scoutContext.confidence).toBe(0.92);
      expect(metadata.scoutContext.reasoning).toContain('Direct question from manager');
      expect(metadata.scoutContext.from).toBe('johnson@corp.com');
      expect(metadata.scoutContext.sourceSubject).toBe('Re: Q3 Project Timeline — Need Dates');
    });

    it('assigns source list based on sourceType', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      const taskInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.connectorType === 'scout';
      });

      expect(taskInsert).toBeTruthy();
      const taskData = taskInsert![0] as Record<string, unknown>;
      expect(taskData.sourceListId).toBe('scout:email-actions');
      expect(taskData.sourceListName).toBe('Email Actions');
    });

    it('resolves and assigns suggested tags', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      // Should have insert calls for tags and taskTags
      const tagInserts = insertValuesFn.mock.calls.filter((call: unknown[]) => {
        const val = call[0] as Record<string, unknown> | Record<string, unknown>[];
        return Array.isArray(val)
          ? val.some((entry) => entry.slug !== undefined)
          : val.slug !== undefined;
      });
      expect(tagInserts.length).toBeGreaterThan(0);
    });

    it('assigns suggested project when provided', async () => {
      let selectCall = 0;
      db.select.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return mockSelectChain([directConnectorConfig]);
        if (selectCall === 6) return mockSelectChain([{ id: 'proj-scout-integration' }]);
        return mockSelectChain([]);
      });

      await POST(makeRequest({ items: [meetingActionItem()] }));

      // Should have a taskProjects insert
      const projectInserts = insertValuesFn.mock.calls.filter((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.projectId !== undefined;
      });
      // meetingActionItem has suggestedProjectId
      expect(projectInserts.length).toBeGreaterThanOrEqual(1);
    });

    it('emits task.created events for real-time UI updates', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task.created',
          payload: expect.objectContaining({
            title: 'Reply to Johnson about Q3 project timeline',
            connectorType: 'scout',
          }),
        })
      );
    });

    it('maps all priority levels correctly', async () => {
      const priorities = ['critical', 'high', 'medium', 'low', 'none'] as const;
      for (const priority of priorities) {
        vi.clearAllMocks();
        let selectCall = 0;
        db.select.mockImplementation(() => {
          selectCall++;
          return mockSelectChain(selectCall === 1 ? [directConnectorConfig] : []);
        });

        const res = await POST(makeRequest({
          items: [emailActionItem({ sourceId: `scout:email:priority-${priority}`, priority })],
        }));
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.created).toBe(1);
      }
    });

    it('handles items without optional fields gracefully', async () => {
      const minimalItem = {
        sourceId: 'scout:email:minimal-test',
        sourceType: 'email',
        title: 'Minimal action item with no optional fields',
      };
      const res = await POST(makeRequest({ items: [minimalItem] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(1);
    });
  });

  describe('cross-source task creation', () => {
    it('creates a cross-source task linking email and Teams', async () => {
      const crossSourceItem = {
        sourceId: 'scout:cross:hash-email-teams-budget',
        sourceType: 'cross-source',
        title: 'Resolve budget discrepancy — raised in email and Teams',
        description: 'Both CFO email and #finance Teams channel mention conflicting budget numbers for Q3.',
        priority: 'high',
        confidence: 0.88,
        context: {
          from: 'cfo@corp.com',
          sourceSubject: 'Cross-source: Budget discrepancy',
          extractedAt: '2026-07-29T07:30:00Z',
          reasoning: 'Same issue raised in two channels with urgency signals. Cross-source consolidation.',
          relatedSourceIds: [
            'scout:email:AAMkAG-budget-thread',
            'scout:teams:msg-finance-budget',
          ],
        },
        suggestedTags: ['finance', 'urgent'],
      };

      const res = await POST(makeRequest({ items: [crossSourceItem] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(1);
      expect(json.items[0].sourceId).toBe('scout:cross:hash-email-teams-budget');
    });
  });

  describe('planner source type', () => {
    it('creates a task from Planner source with correct source list', async () => {
      const plannerItem = {
        sourceId: 'scout:planner:task-abc-123',
        sourceType: 'planner',
        title: 'Complete compliance training',
        description: 'Assigned in Planner by HR. Due by end of month.',
        priority: 'medium',
        dueDate: '2026-07-31',
        confidence: 0.99,
        context: {
          from: 'hr@corp.com',
          sourceSubject: 'Compliance Training Q3',
          extractedAt: '2026-07-29T07:35:00Z',
          reasoning: 'Planner task with approaching deadline, assigned to user.',
        },
      };

      const res = await POST(makeRequest({ items: [plannerItem] }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.created).toBe(1);

      const taskInsert = insertValuesFn.mock.calls.find((call: unknown[]) => {
        const val = call[0] as Record<string, unknown>;
        return val.connectorType === 'scout' && val.sourceId === 'scout:planner:task-abc-123';
      });
      expect(taskInsert).toBeTruthy();
      expect((taskInsert![0] as Record<string, unknown>).sourceListId).toBe('scout:planner-sync');
    });
  });

  describe('response structure', () => {
    it('returns correct summary counts and per-item details', async () => {
      const items = [emailActionItem(), teamsActionItem()];
      const res = await POST(makeRequest({ items }));
      const json = await res.json();

      // Top-level counts
      expect(json).toHaveProperty('created');
      expect(json).toHaveProperty('updated');
      expect(json).toHaveProperty('skipped');
      expect(json).toHaveProperty('total');
      expect(json.total).toBe(2);

      // Per-item details
      expect(json.items).toHaveLength(2);
      json.items.forEach((item: { sourceId: string; mcTaskId: string; action: string }) => {
        expect(item).toHaveProperty('sourceId');
        expect(item).toHaveProperty('mcTaskId');
        expect(item).toHaveProperty('action');
        expect(item.action).toBe('created');
      });
    });
  });
});
