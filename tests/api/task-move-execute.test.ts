/**
 * Tests for the cross-source task move/copy APIs:
 * - POST /api/tasks/move/preview
 * - POST /api/tasks/move/execute
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ─── Chainable mock helper ───────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T): ChainableProxy {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

// ─── DB mock ─────────────────────────────────────────────────────────────────

const selectResults: unknown[][] = [];
let selectCallIndex = 0;

const mockDb = {
  select: vi.fn(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex++;
    return chainable(result);
  }),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

const mockTxDelete = vi.fn();
const mockTxValues = vi.fn();
const mockTxUpdates = vi.fn();
const txSelectResults: unknown[][] = [];
let txSelectCallIndex = 0;
const mockRunTransaction = vi.fn((fn: (tx: unknown) => unknown) => {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => txSelectResults[txSelectCallIndex++] ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        mockTxValues(values);
        return { run: vi.fn() };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        mockTxUpdates(values);
        return { where: vi.fn(() => ({ run: vi.fn() })) };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      mockTxDelete(table);
      return { where: vi.fn(() => ({ run: vi.fn() })) };
    }),
  };
  return fn(tx);
});

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: mockRunTransaction,
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', parentId: 'parent_id', connectorType: 'connector_type', connectorInstanceId: 'connector_instance_id', sourceListId: 'source_list_id' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  projectAutoIncludeExclusions: { taskId: 'task_id' },
  taskAttachments: {
    id: 'attachment_id',
    taskId: 'task_id',
    name: 'attachment_name',
    contentType: 'content_type',
    size: 'attachment_size',
    contentBase64: 'content_base64',
    sourceAttachmentId: 'source_attachment_id',
    createdAt: 'attachment_created_at',
  },
  taskLinkedSources: { taskId: 'task_id' },
  taskDependencies: { taskId: 'task_id', dependsOnTaskId: 'depends_on_task_id' },
  tags: { id: 'id', name: 'name', slug: 'slug', type: 'type', color: 'color' },
  myDayItems: { taskId: 'task_id' },
  myDayExclusions: { taskId: 'task_id' },
  focusItems: { taskId: 'task_id' },
  taskSchedules: { taskId: 'task_id', estimatedDuration: 'estimated_duration', recurrence: 'recurrence' },
  prioritySyncLog: { taskId: 'task_id' },
  quickSortLog: { taskId: 'task_id' },
  projectPhaseItems: { taskId: 'task_id' },
  weeklyOneThing: { taskId: 'task_id' },
  connectorConfigs: { id: 'id', type: 'type', deletedAt: 'deleted_at' },
  sourceLists: { id: 'id', name: 'name', sourceId: 'source_id', connectorInstanceId: 'connector_instance_id', hidden: 'hidden', sortOrder: 'sort_order' },
  listGroups: { id: 'id', name: 'name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq-condition'),
  and: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn(() => 'is-null-condition'),
  inArray: vi.fn(() => 'in-array-condition'),
  count: vi.fn(() => 'count-fn'),
}));

// ─── Connector mock ──────────────────────────────────────────────────────────

const mockCreateTask = vi.fn(async (task: { sourceListId?: string }) => {
  if (task.sourceListId?.includes('/')) {
    return {
      sourceId: `${task.sourceListId}:123`,
      title: 'Test',
      metadata: {
        issueNumber: 123,
        nodeId: 'I_created',
        url: `https://github.com/${task.sourceListId}/issues/123`,
      },
    };
  }
  return { sourceId: 'new-source-123', title: 'Test' };
});
const mockDeleteTask = vi.fn(async () => {});
const mockCompleteTask = vi.fn(async () => {});
const mockAddComment = vi.fn(async () => {});
const mockAddTagToTask = vi.fn(async () => {});
const mockTransferTask = vi.fn(async () => ({
  newSourceId: 'acme/repo-b:42',
  identityVerified: true as const,
}));
const mockCanTransferTask = vi.fn(() => true);
const mockRefreshTransferIdentity = vi.fn();
const mockReconcileTransferIdentity = vi.fn();
const mockCreateSubTask = vi.fn(async () => ({ sourceId: 'sub-1', title: 'Sub' }));
const mockListAttachments = vi.fn(async (): Promise<Array<{
  id: string;
  name: string;
  contentType: string;
  size: number;
}>> => []);
const mockGetAttachmentContent = vi.fn(async () => ({
  contentBase64: 'cmVtb3RlIGNvbnRlbnQ=',
  contentType: 'text/plain',
}));
const mockUploadAttachment = vi.fn(async (_sourceId: string, attachment: { name: string }) => ({
  id: 'uploaded-attachment-1',
  name: attachment.name,
  size: 14,
}));

const mockConnector = {
  createTask: mockCreateTask,
  deleteTask: mockDeleteTask,
  completeTask: mockCompleteTask,
  addComment: mockAddComment,
  addTagToTask: mockAddTagToTask,
  transferTask: mockTransferTask,
  canTransferTask: mockCanTransferTask,
  createSubTask: mockCreateSubTask,
  listAttachments: mockListAttachments,
  getAttachmentContent: mockGetAttachmentContent,
  uploadAttachment: mockUploadAttachment,
};
let mockConnectorDeleteSupported = true;
let mockConnectorRefreshSupported = false;

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn((id: string) => id === 'local'
      ? undefined
      : {
          ...mockConnector,
          deleteTask: mockConnectorDeleteSupported ? mockDeleteTask : undefined,
          refreshTransferIdentity: mockConnectorRefreshSupported
            ? mockRefreshTransferIdentity
            : undefined,
        }),
  },
}));

vi.mock('@/lib/connectors/transfer-identity', () => ({
  reconcileTransferIdentity: mockReconcileTransferIdentity,
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    initializeConnectorFromDb: vi.fn(async () => null),
  },
}));

const mockMoveLogInfo = vi.fn();
const mockMoveLogWarn = vi.fn();
const mockMoveLogError = vi.fn();

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  connectorLogger: {
    info: mockMoveLogInfo,
    warn: mockMoveLogWarn,
    error: mockMoveLogError,
  },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

vi.mock('@/lib/api-error', () => ({
  apiError: vi.fn((error: string, code: string, status: number) => (
    NextResponse.json({ error, code }, { status })
  )),
  ApiErrors: {
    internal: vi.fn((msg: string, error?: unknown, traceId?: string) => {
      return NextResponse.json({
        error: msg,
        detail: error instanceof Error ? error.message : undefined,
        code: 'INTERNAL_ERROR',
        ...(traceId ? { traceId } : {}),
      }, { status: 500 });
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  selectCallIndex = 0;
  selectResults.length = 0;
  txSelectCallIndex = 0;
  txSelectResults.length = 0;
  mockConnectorDeleteSupported = true;
  mockConnectorRefreshSupported = false;
});

const BASE = 'http://localhost:3099';

// ═══════════════════════════════════════════════════════════════════════════════
// PREVIEW ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks/move/preview', () => {
  it('returns 400 when taskId is missing', async () => {
    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('required');
  });

  it('returns 400 when targetConnectorInstanceId is missing', async () => {
    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it('returns 404 when task does not exist', async () => {
    selectResults.push([]); // task not found
    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'missing-task', targetConnectorInstanceId: 'inst-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
  });

  it('returns 404 when target connector does not exist', async () => {
    selectResults.push([{ id: 'task-1', title: 'Test', connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1', status: 'todo' }]); // task
    selectResults.push([]); // task tags
    selectResults.push([{ count: 0 }]); // subtask count
    selectResults.push([]); // target connector not found
    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'missing-conn' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
  });

  it('returns 400 when target connector has no write capability', async () => {
    selectResults.push([{ id: 'task-1', title: 'Test', connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1', status: 'todo' }]); // task
    selectResults.push([]); // task tags
    selectResults.push([{ count: 0 }]); // subtask count
    selectResults.push([{ id: 'inst-2', type: 'outlook-email', capabilities: { read: true, write: false } }]); // target connector (no write)
    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('write');
  });

  it('rejects the task current source as the preview destination', async () => {
    selectResults.push([{
      id: 'task-1',
      title: 'Already here',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceListId: 'rsocko/mission-control',
      status: 'todo',
    }]);
    selectResults.push([]);
    selectResults.push([{ count: 0 }]);
    selectResults.push([{
      id: 'github-1',
      type: 'github-issues',
      name: 'GitHub',
      capabilities: { write: true, taskCreate: true },
    }]);

    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'github-1',
        targetSourceListId: 'rsocko/mission-control',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'This task is already in the selected destination',
      code: 'SAME_SOURCE_DESTINATION',
    });
  });

  it('returns valid preview with field mappings', async () => {
    mockListAttachments.mockResolvedValueOnce([{
      id: 'remote-attachment-1',
      name: 'remote.txt',
      contentType: 'text/plain',
      size: 14,
    }]);
    selectResults.push([{
      id: 'task-1', title: 'Fix login', description: 'Broken auth', connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', status: 'todo', priority: 'high',
      sourceId: 'list-a:task-1', dueDate: '2026-08-01', assignee: 'user@example.com', effort: 3,
    }]); // task
    selectResults.push([{ name: 'bug', slug: 'bug' }]); // task tags
    selectResults.push([{ count: 2 }]); // subtask count
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub - Acme', capabilities: { read: true, write: true } }]); // target connector
    selectResults.push([{ id: 'list-1', name: 'acme/repo', sourceId: 'acme/repo' }]); // target lists
    selectResults.push([{ estimatedDuration: 60, recurrence: null }]); // task schedule
    selectResults.push([]); // locally stored attachments
    selectResults.push([{ count: 1 }]); // projects

    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    const data = await res.json();
    expect(res.status, data.detail).toBe(200);

    expect(data.task.id).toBe('task-1');
    expect(data.targetConnector.type).toBe('github-issues');
    expect(data.fieldMappings.length).toBeGreaterThan(0);
    expect(data.sourceActions).toHaveLength(2);
    expect(data.hasLossyFields).toBe(false);
    expect(data.subtasks).not.toBeNull();
    expect(data.subtasks.count).toBe(2);
    expect(data.fieldMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'effort', targetValue: 'label: effort:3' }),
      expect.objectContaining({ field: 'estimatedDuration', targetValue: '(kept in Mission Control)' }),
      expect.objectContaining({ field: 'projects', targetValue: '(preserved in Mission Control)' }),
      expect.objectContaining({ field: 'attachments', sourceValue: '1 attachment' }),
    ]));
  });

  it('detects GitHub native transfer when same owner and safety bindings are ready', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Move me', connectorType: 'github-issues',
      connectorInstanceId: 'inst-2', sourceListId: 'acme/repo-a', sourceId: 'acme/repo-a:1', status: 'todo',
    }]); // task
    selectResults.push([]); // task tags
    selectResults.push([{ count: 0 }]); // subtask count
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub - Acme B', capabilities: { read: true, write: true } }]); // target connector
    selectResults.push([{ id: 'list-1', name: 'acme/repo-b', sourceId: 'acme/repo-b' }]); // target lists (same owner)
    selectResults.push([]); // task schedule
    selectResults.push([]); // attachments
    selectResults.push([{ count: 0 }]); // projects

    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const request = new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'inst-2', targetSourceListId: 'acme/repo-b' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    const data = await res.json();
    expect(res.status, data.detail).toBe(200);
    expect(data.isNativeTransfer).toBe(true);
    expect(data.nativeTransferNote).toContain('GitHub');
  });

  it('does not advertise native transfer before safety bindings are ready', async () => {
    mockCanTransferTask.mockReturnValueOnce(false);
    selectResults.push([{
      id: 'task-1', title: 'Fresh issue', connectorType: 'github-issues',
      connectorInstanceId: 'inst-2', sourceListId: 'acme/repo-a',
      sourceId: 'acme/repo-a:1', status: 'todo',
    }]);
    selectResults.push([]);
    selectResults.push([{ count: 0 }]);
    selectResults.push([{
      id: 'inst-2', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true },
    }]);
    selectResults.push([{ id: 'list-1', name: 'acme/repo-b', sourceId: 'acme/repo-b' }]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([{ count: 0 }]);

    const { POST } = await import('@/app/api/tasks/move/preview/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/preview`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo-b',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));
    const data = await res.json();

    expect(res.status, data.detail).toBe(200);
    expect(data.isNativeTransfer).toBe(false);
    expect(data.nativeTransferNote).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTE ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks/move/execute', () => {
  it('rejects the task current source before creating a destination task', async () => {
    selectResults.push([{
      id: 'task-1',
      title: 'Already here',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceListId: 'rsocko/mission-control',
      sourceId: 'rsocko/mission-control:1',
    }]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'github-1',
        targetSourceListId: 'rsocko/mission-control',
        sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'This task is already in the selected destination',
      code: 'SAME_SOURCE_DESTINATION',
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('rejects excessive subtasks before creating a destination task', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Oversized parent', connectorType: 'local',
      connectorInstanceId: 'local', sourceId: 'local:task-1',
      status: 'todo', priority: 'none',
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true, taskCreate: true },
    }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]);
    selectResults.push(Array.from({ length: 101 }, (_, index) => ({
      id: `sub-${index}`,
      title: `Subtask ${index}`,
      parentId: 'task-1',
    })));

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const response = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo',
        sourceAction: 'move',
      }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TASK_MOVE_BUDGET_EXCEEDED',
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('required');
  });

  it('returns 400 when sourceAction is invalid', async () => {
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 't-1', targetConnectorInstanceId: 'inst-2', targetSourceListId: 'list-1', sourceAction: 'teleport' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(request);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('sourceAction');
  });

  it('rejects a subtask drop strategy', async () => {
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 't-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'list-1',
        sourceAction: 'move',
        subtaskStrategy: 'drop',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(400);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('returns 404 when source task does not exist', async () => {
    selectResults.push([]); // task not found
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'missing', targetConnectorInstanceId: 'inst-2', targetSourceListId: 'list-1', sourceAction: 'move' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
  });

  it('returns 404 when target connector does not exist', async () => {
    selectResults.push([{ id: 'task-1', title: 'Test', connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1', sourceListId: 'list-a' }]); // task found
    selectResults.push([]); // target connector not found
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'missing', targetSourceListId: 'list-1', sourceAction: 'move' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(404);
  });

  it('returns 400 when target connector has no write capability', async () => {
    selectResults.push([{ id: 'task-1', title: 'Test', connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1', sourceListId: 'list-a' }]);
    selectResults.push([{ id: 'inst-2', type: 'outlook-email', capabilities: { write: false } }]);
    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetConnectorInstanceId: 'inst-2', targetSourceListId: 'list-1', sourceAction: 'copy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it('rejects an oversized remote attachment before creating the destination', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Large attachment', description: null,
      connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1',
      sourceListId: 'list-a', sourceId: 'ms-source-1', status: 'todo',
      priority: 'none', metadata: null,
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true, attachments: true },
    }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([]);
    mockListAttachments.mockResolvedValueOnce([{
      id: 'remote-large',
      name: 'large.bin',
      contentType: 'application/octet-stream',
      size: 10 * 1024 * 1024 + 1,
    }]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const response = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo',
        sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(response.status).toBe(413);
    expect(mockGetAttachmentContent).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('executes a move (generic cross-source) and returns 201', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Test Task', description: 'desc', connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'in_progress', priority: 'high', dueDate: '2026-08-01', assignee: 'user',
      effort: 4, microStatus: 'blocked_external', reminderAt: '2026-08-01T12:00:00Z',
      sourceId: 'ms-source-1', metadata: null,
    }]); // source task
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]); // target connector
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]); // target list
    selectResults.push([]); // task tags
    selectResults.push([]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo', sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json', 'x-trace-id': 'aabbccdd' },
    });
    const res = await POST(request);
    expect(res.status).toBe(201);
    const data = await res.json();

    expect(data.newTaskId).toBeDefined();
    expect(data.newSourceId).toBe('acme/repo:123');
    expect(data.sourceAction).toBe('move');
    expect(mockCreateTask).toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      effort: 4,
      status: 'in_progress',
      microStatus: 'blocked_external',
    }));
    expect(mockRunTransaction).toHaveBeenCalled();
    expect(mockMoveLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'task_move',
        phase: 'start',
        taskId: 'task-1',
        source_type: 'microsoft-todo',
        sourceConnectorType: 'microsoft-todo',
        sourceConnectorInstanceId: 'inst-1',
        destinationConnectorType: 'github-issues',
        destinationConnectorInstanceId: 'inst-2',
        destinationListId: 'acme/repo',
        traceId: 'aabbccdd',
        sourceAction: 'move',
        durationMs: 0,
      }),
      'Task move started',
    );
    const startFields = mockMoveLogInfo.mock.calls.find(([, message]) => message === 'Task move started')?.[0];
    expect(startFields).not.toHaveProperty('outcome');
    expect(mockMoveLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'task_move',
        outcome: 'success',
        source_type: 'microsoft-todo',
        traceId: 'aabbccdd',
        durationMs: expect.any(Number),
      }),
      'Task move succeeded',
    );
  });

  it('executes a copy and does not delete from source', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Test Task', description: null, connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'todo', priority: 'medium', dueDate: null, assignee: null,
      sourceId: 'ms-source-1', metadata: null,
    }]); // source task
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]); // target connector
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]); // target list
    selectResults.push([]); // task tags
    selectResults.push([]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo', sourceAction: 'copy',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sourceAction).toBe('copy');
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockAddComment).toHaveBeenCalled(); // cross-reference
  });

  it('passes schedule recurrence to target task creation', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Recurring Task', description: null, connectorType: 'local',
      connectorInstanceId: 'local', sourceListId: null, sourceListName: null,
      status: 'todo', priority: 'medium', dueDate: '2026-08-01', assignee: null,
      sourceId: 'local:task-1', metadata: { retained: true },
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'microsoft-todo', name: 'Microsoft To Do',
      capabilities: { read: true, write: true, taskCreate: true },
    }]);
    selectResults.push([{ name: 'Tasks', sourceId: 'list-1' }]);
    selectResults.push([]); // task tags
    selectResults.push([]); // subtasks
    selectResults.push([]); // attachments
    selectResults.push([{
      taskId: 'task-1',
      scheduledDate: '2026-08-01',
      scheduledTime: null,
      estimatedDuration: 30,
      isTimeBlocked: false,
      recurrence: 'weekly',
    }]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'list-1',
        sourceAction: 'copy',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(201);
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        retained: true,
        recurrence: 'weekly',
      }),
    }));
  });

  it('removes the original local record after a move', async () => {
    selectResults.push([{
      id: 'task-local', title: 'Local Task', description: null, connectorType: 'local',
      connectorInstanceId: 'local', sourceListId: null, sourceListName: null,
      status: 'todo', priority: 'none', dueDate: null, assignee: null,
      sourceId: 'local:task-local', metadata: null, createdAt: '2026-07-30T12:00:00Z',
    }]);
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([{
      id: 'attachment-1',
      taskId: 'task-local',
      name: 'spec.txt',
      contentType: 'text/plain',
      size: 12,
      contentBase64: 'cHJlc2VydmUgbWU=',
      sourceAttachmentId: null,
      createdAt: '2026-07-30T12:00:00Z',
    }]); // attachments
    selectResults.push([]); // source schedule
    selectResults.push([{
      id: 'attachment-1',
      contentBase64: 'cHJlc2VydmUgbWU=',
    }]); // bounded attachment content load

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-local',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo',
        sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(201);
    expect(mockDeleteTask).not.toHaveBeenCalled();
    expect(mockTxDelete).toHaveBeenCalledWith(expect.objectContaining({
      id: 'id',
      connectorType: 'connector_type',
    }));
    expect(mockTxValues).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        name: 'spec.txt',
        contentBase64: 'cHJlc2VydmUgbWU=',
      }),
    ]));
  });

  it('uses native transfer for same-owner GitHub→GitHub move', async () => {
    selectResults.push([{
      id: 'task-1', title: 'GH Issue', description: 'body', connectorType: 'github-issues',
      connectorInstanceId: 'inst-1', sourceListId: 'acme/repo-a', sourceListName: 'acme/repo-a',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'acme/repo-a:10', metadata: null,
    }]); // source task
    selectResults.push([{ id: 'inst-1', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]); // same connector
    selectResults.push([{ name: 'acme/repo-b', sourceId: 'acme/repo-b' }]); // target list
    selectResults.push([]); // task tags
    selectResults.push([]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-1',
        targetSourceListId: 'acme/repo-b', sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.nativeTransfer).toBe(true);
    expect(data.newSourceId).toBe('acme/repo-b:42');
    expect(mockTransferTask).toHaveBeenCalledWith('acme/repo-a:10', 'acme/repo-b');
  });

  it('refreshes only the selected GitHub issue before native transfer', async () => {
    mockCanTransferTask.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockConnectorRefreshSupported = true;
    const sourceTask = {
      id: 'task-1', title: 'Fresh issue', description: 'old body', connectorType: 'github-issues',
      connectorInstanceId: 'inst-1', sourceListId: 'acme/repo-a', sourceListName: 'acme/repo-a',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'acme/repo-a:10', metadata: null,
    };
    const refreshedTask = { ...sourceTask, description: 'current body' };
    const refresh = {
      task: refreshedTask,
      sourceLists: [],
    };
    mockRefreshTransferIdentity.mockResolvedValueOnce(refresh);
    selectResults.push([sourceTask]);
    selectResults.push([{
      id: 'inst-1', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true, taskCreate: true },
    }]);
    selectResults.push([{ name: 'acme/repo-b', sourceId: 'acme/repo-b' }]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([refreshedTask]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-1',
        targetSourceListId: 'acme/repo-b',
        sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));
    const data = await res.json();

    expect(res.status, data.detail).toBe(200);
    expect(data.nativeTransfer).toBe(true);
    expect(mockRefreshTransferIdentity).toHaveBeenCalledWith(
      'acme/repo-a:10',
      'acme/repo-b',
    );
    expect(mockReconcileTransferIdentity).toHaveBeenCalledWith(
      'task-1',
      'inst-1',
      refresh,
    );
    expect(mockTransferTask).toHaveBeenCalledWith('acme/repo-a:10', 'acme/repo-b');
  });

  it('falls back to create-and-close for a fresh GitHub issue without transfer bindings', async () => {
    mockCanTransferTask.mockReturnValueOnce(false);
    mockConnectorDeleteSupported = false;
    mockCreateTask.mockResolvedValueOnce({
      sourceId: 'acme/repo-b:42',
      title: 'Fresh issue',
      metadata: {
        issueNumber: 42,
        nodeId: 'I_destination',
        url: 'https://github.com/acme/repo-b/issues/42',
      },
    });
    selectResults.push([{
      id: 'task-1', title: 'Fresh issue', description: 'body', connectorType: 'github-issues',
      connectorInstanceId: 'inst-1', sourceListId: 'acme/repo-a', sourceListName: 'acme/repo-a',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'acme/repo-a:10',
      metadata: {
        issueNumber: 10,
        nodeId: 'I_source',
        url: 'https://github.com/acme/repo-a/issues/10',
        retained: true,
      },
    }]);
    selectResults.push([{
      id: 'inst-1', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true, taskCreate: true },
    }]);
    selectResults.push([{ name: 'acme/repo-b', sourceId: 'acme/repo-b' }]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([]);
    selectResults.push([]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-1',
        targetSourceListId: 'acme/repo-b',
        sourceAction: 'move',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));
    const data = await res.json();

    expect(res.status, data.detail).toBe(201);
    expect(data.nativeTransfer).toBeUndefined();
    expect(mockTransferTask).not.toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      sourceListId: 'acme/repo-b',
    }));
    expect(mockCompleteTask).toHaveBeenCalledWith('acme/repo-a:10');
    const insertedTask = mockTxValues.mock.calls
      .map(([value]) => value)
      .find((value) => value && !Array.isArray(value) && value.sourceId === 'acme/repo-b:42');
    expect(insertedTask).toBeDefined();
    expect(JSON.parse(insertedTask.metadata)).toMatchObject({
      issueNumber: 42,
      nodeId: 'I_destination',
      url: 'https://github.com/acme/repo-b/issues/42',
      retained: true,
    });
  });

  it('does NOT use native transfer when sourceAction is copy (even if same owner)', async () => {
    selectResults.push([{
      id: 'task-1', title: 'GH Issue', description: 'body', connectorType: 'github-issues',
      connectorInstanceId: 'inst-1', sourceListId: 'acme/repo-a', sourceListName: 'acme/repo-a',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'acme/repo-a#10', metadata: null,
    }]);
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub B', capabilities: { read: true, write: true } }]);
    selectResults.push([{ name: 'acme/repo-b', sourceId: 'acme/repo-b' }]);
    selectResults.push([]); // task tags
    selectResults.push([]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo-b', sourceAction: 'copy',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.nativeTransfer).toBeUndefined();
    expect(mockTransferTask).not.toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalled();
    expect(mockRunTransaction).toHaveBeenCalled();
  });

  it('moves subtasks when strategy is move-as-subtasks', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Parent', description: null, connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'ms-1', metadata: null,
    }]);
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]); // task tags
    selectResults.push([
      { id: 'sub-1', title: 'Subtask 1', status: 'todo', parentId: 'task-1', isChecklistItem: true },
      { id: 'sub-2', title: 'Subtask 2', status: 'done', parentId: 'task-1', isChecklistItem: true },
    ]); // subtasks
    selectResults.push([]); // attachments
    txSelectResults.push(
      [], // parent projects
      [{
        id: 'parent-link',
        taskId: 'task-1',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-1',
        sourceId: 'acme/other#1',
      }],
    );

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo', sourceAction: 'move',
        subtaskStrategy: 'move-as-subtasks',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.subtasksMoved).toBe(2);
    expect(mockCreateSubTask).toHaveBeenCalledTimes(2);
    expect(mockListAttachments).toHaveBeenCalledTimes(1);
    expect(mockTxUpdates).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'sub-1',
      connectorType: 'github-issues',
      parentId: expect.any(String),
    }));
    expect(mockTxUpdates).toHaveBeenCalledWith({
      taskId: expect.any(String),
    });
  });

  it('creates Microsoft To Do steps and preserves GitHub subtask details in notes', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Parent', description: 'Parent notes', connectorType: 'github-issues',
      connectorInstanceId: 'inst-1', sourceListId: 'acme/repo', sourceListName: 'acme/repo',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'acme/repo#1', metadata: null,
    }]);
    selectResults.push([{ id: 'inst-2', type: 'microsoft-todo', name: 'Microsoft To Do', capabilities: { read: true, write: true } }]);
    selectResults.push([{ name: 'Tasks', sourceId: 'list-b' }]);
    selectResults.push([]); // task tags
    selectResults.push([
      { id: 'sub-1', title: 'Subtask 1', description: 'Important details', status: 'todo', parentId: 'task-1' },
      { id: 'sub-2', title: 'Subtask 2', description: null, status: 'done', parentId: 'task-1' },
    ]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'list-b', sourceAction: 'move',
        subtaskStrategy: 'preserve-details-and-steps',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);

    expect(res.status).toBe(201);
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('**Subtasks:**'),
    }));
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('Important details'),
    }));
    expect(mockCreateSubTask).toHaveBeenCalledTimes(2);
    expect((await res.json()).subtasksMoved).toBe(2);
  });

  it('copies transferable subtask relations without duplicating linked-source identity', async () => {
    selectResults.push([{
      id: 'task-1', title: 'Parent', description: null, connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'ms-1', metadata: null, depth: 0,
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'github-issues', name: 'GitHub',
      capabilities: { read: true, write: true },
    }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]); // parent task tags
    selectResults.push([{
      id: 'sub-1', title: 'Subtask', status: 'todo', parentId: 'task-1',
      connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1',
      sourceId: 'ms-sub-1', metadata: null, depth: 1,
    }]);
    selectResults.push([{
      id: 'attachment-1', taskId: 'sub-1', name: 'notes.txt',
      contentType: 'text/plain', size: 5, contentBase64: 'aGVsbG8=',
      sourceAttachmentId: null, createdAt: '2026-08-01T12:00:00Z',
    }]); // batched parent/subtask attachment metadata
    selectResults.push([]); // parent schedule
    selectResults.push([{
      id: 'attachment-1',
      contentBase64: 'aGVsbG8=',
    }]); // bounded attachment content load

    txSelectResults.push(
      [], // parent projects
      [], // parent linked sources
      [{ taskId: 'sub-1', tagId: 'tag-1' }],
      [{ taskId: 'sub-1', projectId: 'project-1' }],
      [{
        taskId: 'sub-1', scheduledDate: '2026-08-02', scheduledTime: '09:00',
        estimatedDuration: 45, isTimeBlocked: true, recurrence: 'weekly',
      }],
      [{
        id: 'link-1', taskId: 'sub-1', connectorType: 'github-issues',
        connectorInstanceId: 'github-1', sourceId: 'acme/other#1',
        title: 'Related', linkedAt: '2026-08-01T12:00:00Z', metadata: {},
      }],
    );

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo',
        sourceAction: 'copy',
        subtaskStrategy: 'move-as-subtasks',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(201);
    expect(mockCreateSubTask).toHaveBeenCalledTimes(1);
    expect(mockTxValues).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Subtask',
      parentId: expect.any(String),
      sourceId: 'sub-1',
    }));
    expect(mockTxValues).toHaveBeenCalledWith([
      expect.objectContaining({ tagId: 'tag-1', taskId: expect.any(String) }),
    ]);
    expect(mockTxValues).toHaveBeenCalledWith([
      expect.objectContaining({ projectId: 'project-1', taskId: expect.any(String) }),
    ]);
    expect(mockTxValues).toHaveBeenCalledWith([
      expect.objectContaining({ recurrence: 'weekly', taskId: expect.any(String) }),
    ]);
    expect(mockTxValues).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'notes.txt',
        contentBase64: 'aGVsbG8=',
        taskId: expect.any(String),
      }),
    ]);
    expect(mockTxValues).not.toHaveBeenCalledWith([
      expect.objectContaining({ sourceId: 'acme/other#1' }),
    ]);
  });

  it('downloads and uploads remote subtask attachments before deleting the source', async () => {
    mockListAttachments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'remote-attachment-1',
        name: 'remote.txt',
        contentType: 'text/plain',
        size: 14,
      }]);

    selectResults.push([{
      id: 'task-1', title: 'Parent', description: null, connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'ms-1', metadata: null, depth: 0,
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'microsoft-todo', name: 'Microsoft To Do',
      capabilities: { read: true, write: true, attachments: true },
    }]);
    selectResults.push([{ name: 'Tasks', sourceId: 'list-b' }]);
    selectResults.push([]); // parent task tags
    selectResults.push([{
      id: 'sub-1', title: 'Subtask', status: 'todo', parentId: 'task-1',
      connectorType: 'microsoft-todo', connectorInstanceId: 'inst-1',
      sourceId: 'ms-sub-1', metadata: null, depth: 1,
    }]);
    selectResults.push([]); // parent attachments
    selectResults.push([]); // parent schedule
    selectResults.push([]); // stored subtask attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'list-b',
        sourceAction: 'move',
        subtaskStrategy: 'move-as-subtasks',
      }),
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(res.status).toBe(201);
    expect(mockGetAttachmentContent).toHaveBeenCalledWith(
      'ms-sub-1',
      'remote-attachment-1',
    );
    expect(mockUploadAttachment).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({
        name: 'remote.txt',
        contentBase64: 'cmVtb3RlIGNvbnRlbnQ=',
      }),
    );
    expect(mockDeleteTask).toHaveBeenCalledWith('ms-1');
  });

  it('stops the move when a subtask cannot be preserved', async () => {
    mockCreateSubTask.mockRejectedValueOnce(new Error('API error'));

    selectResults.push([{
      id: 'task-1', title: 'Parent', description: null, connectorType: 'microsoft-todo',
      connectorInstanceId: 'inst-1', sourceListId: 'list-a', sourceListName: 'My List',
      status: 'todo', priority: null, dueDate: null, assignee: null,
      sourceId: 'ms-1', metadata: null,
    }]);
    selectResults.push([{ id: 'inst-2', type: 'github-issues', name: 'GitHub', capabilities: { read: true, write: true } }]);
    selectResults.push([{ name: 'acme/repo', sourceId: 'acme/repo' }]);
    selectResults.push([]); // task tags
    selectResults.push([
      { id: 'sub-1', title: 'Failing Sub', status: 'todo', parentId: 'task-1' },
      { id: 'sub-2', title: 'Good Sub', status: 'done', parentId: 'task-1' },
    ]); // subtasks
    selectResults.push([]); // attachments

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const request = new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1', targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'acme/repo', sourceAction: 'move',
        subtaskStrategy: 'move-as-subtasks',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(request);
    expect(res.status).toBe(500);
    expect(mockDeleteTask).toHaveBeenCalledWith('acme/repo:123');
  });

  it('emits one terminal failure when tag write-back and compensation fail', async () => {
    mockAddTagToTask.mockRejectedValueOnce(new Error('upstream payload with private task title'));
    mockDeleteTask.mockRejectedValueOnce(new Error('cleanup payload with private task title'));
    selectResults.push([{
      id: 'task-1', title: 'Private task title', description: 'Private task body',
      connectorType: 'local', connectorInstanceId: 'local', sourceListId: null,
      sourceListName: null, status: 'todo', priority: 'none', dueDate: null,
      assignee: null, sourceId: 'local:task-1', metadata: null,
    }]);
    selectResults.push([{
      id: 'inst-2', type: 'microsoft-todo', name: 'Microsoft To Do',
      capabilities: { read: true, write: true, taskCreate: true },
    }]);
    selectResults.push([{ name: 'Tasks', sourceId: 'list-1' }]);
    selectResults.push([{
      id: 'tag-1', name: 'important', slug: 'important', type: 'hub', color: null,
    }]);
    selectResults.push([]);
    selectResults.push([]);

    const { POST } = await import('@/app/api/tasks/move/execute/route');
    const res = await POST(new Request(`${BASE}/api/tasks/move/execute`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: 'task-1',
        targetConnectorInstanceId: 'inst-2',
        targetSourceListId: 'list-1',
        sourceAction: 'move',
      }),
      headers: {
        'Content-Type': 'application/json',
        'x-trace-id': 'deadbeef',
      },
    }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Failed to execute task move',
      code: 'INTERNAL_ERROR',
      traceId: 'deadbeef',
    });
    expect(mockDeleteTask).toHaveBeenCalledWith('new-source-123');
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockMoveLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'task_move',
        outcome: 'failure',
        source_type: 'local',
        traceId: 'deadbeef',
        failureCode: 'internal_error_compensation_failed',
        exceptionType: 'Error',
        durationMs: expect.any(Number),
      }),
      'Task move failed',
    );
    expect(mockMoveLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'task_move',
        phase: 'compensation',
        compensationStatus: 'failure',
        source_type: 'local',
      }),
      'Task move compensation failed',
    );
    const terminalOutcomes = mockMoveLogError.mock.calls
      .map(([fields]) => fields as { outcome?: string })
      .filter((fields) => fields.outcome);
    expect(terminalOutcomes).toHaveLength(1);
    expect(terminalOutcomes[0].outcome).toBe('failure');
    const loggedFields = mockMoveLogError.mock.calls.map(([fields]) => JSON.stringify(fields)).join(' ');
    expect(loggedFields).not.toContain('Private task title');
    expect(loggedFields).not.toContain('Private task body');
    expect(loggedFields).not.toContain('upstream payload');
  });
});
