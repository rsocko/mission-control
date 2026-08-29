/**
 * Tests for the write-through terminal status detection fix.
 *
 * When a task is set to 'in_progress' locally but the upstream issue is already
 * closed, the write-through should detect the terminal remote state from the
 * updateTask response and correct the local status — preventing the task from
 * being stuck as 'in_progress' indefinitely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskItem } from '@/types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockCurrentTask: Record<string, unknown> = {};
const mockUpdateSets: Array<Record<string, unknown>> = [];
const mockUpdateTaskResult: Partial<TaskItem> = {};
let connectorInitialized = true;

vi.mock('@/db', () => {
  const updateWhereFn = vi.fn();
  const updateSetFn = vi.fn((data: Record<string, unknown>) => {
    mockUpdateSets.push(data);
    return { where: updateWhereFn };
  });
  return {
    default: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => [mockCurrentTask]),
        })),
      })),
      update: vi.fn(() => ({ set: updateSetFn })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn() })),
    },
    runTransaction: vi.fn((fn: (tx: unknown) => void) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ run: vi.fn(() => ({ changes: 1 })) })),
          })),
        })),
        delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
        insert: vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn() })) })),
      };
      fn(tx);
    }),
  };
});

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', sourceId: 'sourceId', connectorInstanceId: 'connectorInstanceId' },
  taskTags: { taskId: 'taskId' },
  taskProjects: { taskId: 'taskId' },
  taskSchedules: { taskId: 'taskId' },
  taskFieldStates: { taskId: 'taskId', fieldName: 'fieldName' },
  myDayItems: { taskId: 'taskId' },
  prioritySyncLog: {},
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock('@/lib/priority', () => ({
  resolveOutboundPriority: vi.fn(() => ({ shouldWrite: false })),
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/connectors/scout/reconciliation-service', () => ({
  suppressAutoCompletionAfterReopen: vi.fn(),
  supersedePendingReconciliationSuggestions: vi.fn(),
  wasTaskAutoCompletedByReconciliation: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn(() =>
      connectorInitialized
        ? { updateTask: vi.fn(() => Promise.resolve(mockUpdateTaskResult)) }
        : null
    ),
  },
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    initializeConnectorFromDb: vi.fn(() =>
      connectorInitialized
        ? Promise.resolve({ updateTask: vi.fn(() => Promise.resolve(mockUpdateTaskResult)) })
        : Promise.resolve(null)
    ),
  },
  logWriteThrough: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    notFound: vi.fn(() => new Response('Not found', { status: 404 })),
    forbidden: vi.fn(() => new Response('Forbidden', { status: 403 })),
    unauthorized: vi.fn(() => new Response('Unauthorized', { status: 401 })),
    internal: vi.fn(() => new Response('Error', { status: 500 })),
  },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => Promise.resolve({
    read: true,
    write: true,
    delete: true,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
  })),
  isConnectorEnabled: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-27'),
}));

vi.mock('@/lib/utils/deep-links', () => ({
  buildDeepLinkUrl: vi.fn(() => 'http://localhost/task/1'),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => 'uuid-test',
  };
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import { PATCH } from '@/app/api/tasks/[id]/route';

describe('write-through terminal status detection', () => {
  beforeEach(() => {
    process.env.MC_API_KEY = 'test-api-key';
    vi.clearAllMocks();
    mockUpdateSets.length = 0;
    connectorInitialized = true;
    for (const key of Object.keys(mockUpdateTaskResult)) {
      delete mockUpdateTaskResult[key as keyof TaskItem];
    }

    mockCurrentTask = {
      id: 'task-1',
      sourceId: 'octo-org/ideation:850',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      title: 'Fix dashboard layout',
      description: null,
      status: 'todo',
      priority: 'medium',
      effort: null,
      dueDate: null,
      isChecklistItem: false,
      parentId: null,
      syncStatus: 'synced',
      lastSyncedAt: '2026-07-26T00:00:00Z',
      updatedAt: '2026-07-26T00:00:00Z',
    };
  });

  it('applies terminal remote status when write-through reveals issue is closed', async () => {
    // Simulate: issue is already closed on GH, user sets in_progress locally
    Object.assign(mockUpdateTaskResult, {
      sourceId: 'octo-org/ideation:850',
      status: 'done',
      completedAt: '2026-07-26T18:00:00Z',
    });

    const request = new Request('http://localhost/api/tasks/task-1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-API-Key': 'test-api-key',
      },
      body: JSON.stringify({ status: 'in_progress' }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(200);

    // Wait for async write-through
    await new Promise(resolve => setTimeout(resolve, 50));

    // The write-through should have detected remote terminal status and applied it
    const terminalUpdate = mockUpdateSets.find(
      (u) => u.status === 'done' && u.syncStatus === 'synced'
    );
    expect(terminalUpdate).toBeDefined();
    expect(terminalUpdate!.completedAt).toBe('2026-07-26T18:00:00Z');
  });

  it('preserves an explicit cancellation when the connector normalizes it to done', async () => {
    Object.assign(mockUpdateTaskResult, {
      sourceId: 'octo-org/ideation:850',
      status: 'done',
      completedAt: '2026-08-09T15:00:00Z',
    });

    const response = await PATCH(new Request('http://localhost/api/tasks/task-1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-MC-API-Key': 'test-api-key',
      },
      body: JSON.stringify({ status: 'cancelled' }),
    }), { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockUpdateSets).not.toContainEqual(expect.objectContaining({
      status: 'done',
      syncStatus: 'synced',
    }));
    expect(mockUpdateSets).toContainEqual(expect.objectContaining({
      syncStatus: 'synced',
    }));
  });
});
