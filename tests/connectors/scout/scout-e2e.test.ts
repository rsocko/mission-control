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
 *
 * The route now owns no SQLite: `@/db` and `@/db/schema` are poisoned here so
 * the suite fails loudly if the handler ever reaches back into them, and every
 * write is observed through the backend-neutral ingestion port.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeScoutIngestion } from '../../contracts/scout-ingestion-reconciliation-persistence.contract';

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

const mockEmitEvent = vi.fn(async () => undefined);
vi.mock('@/lib/events', () => ({
  emitEvent: mockEmitEvent,
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Scout E2E: Full push flow', () => {
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

      expect(ingestion.creations).toHaveLength(1);
      const taskData = ingestion.creations[0];
      expect(taskData.connectorType).toBe('scout');
      expect(taskData.connectorInstanceId).toBe('scout-primary');
      expect(taskData.sourceId).toBe('scout:email:AAMkAGNiY2I3ZjRiLTZjNzgtNGFkMi1hMDQ3');
      expect(taskData.status).toBe('todo');
    });

    it('preserves Scout context in task metadata', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      expect(ingestion.creations).toHaveLength(1);
      const metadata = JSON.parse(ingestion.creations[0].metadata);
      expect(metadata.sourceType).toBe('email');
      expect(metadata.scoutContext).toBeDefined();
      expect(metadata.scoutContext.confidence).toBe(0.92);
      expect(metadata.scoutContext.reasoning).toContain('Direct question from manager');
      expect(metadata.scoutContext.from).toBe('johnson@corp.com');
      expect(metadata.scoutContext.sourceSubject).toBe('Re: Q3 Project Timeline — Need Dates');
    });

    it('assigns source list based on sourceType', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      expect(ingestion.creations).toHaveLength(1);
      const taskData = ingestion.creations[0];
      expect(taskData.sourceListId).toBe('scout:email-actions');
      expect(taskData.sourceListName).toBe('Email Actions');
    });

    it('resolves and assigns suggested tags', async () => {
      await POST(makeRequest({ items: [emailActionItem()] }));

      expect(ingestion.creations).toHaveLength(1);
      expect(ingestion.creations[0].tags.length).toBeGreaterThan(0);
      expect(ingestion.creations[0].tags.map((tag) => tag.slug)).toEqual(
        expect.arrayContaining(['work', 'urgent-reply', 'q3-planning']),
      );
    });

    it('assigns suggested project when provided', async () => {
      ingestion.projects.add('proj-scout-integration');

      await POST(makeRequest({ items: [meetingActionItem()] }));

      // meetingActionItem has suggestedProjectId
      expect(ingestion.creations).toHaveLength(1);
      expect(ingestion.creations[0].projectId).toBe('proj-scout-integration');
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
        ingestion = new FakeScoutIngestion();
        workerRepositories.current = {
          scoutIngestionReconciliation: { ingestion },
        };

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

      expect(ingestion.creations).toHaveLength(1);
      const taskData = ingestion.creations[0];
      expect(taskData.sourceId).toBe('scout:planner:task-abc-123');
      expect(taskData.sourceListId).toBe('scout:planner-sync');
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
