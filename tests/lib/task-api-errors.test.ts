import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTaskMove } from '@/lib/api/tasks';

describe('task API errors', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the standardized code and trace ID for client error handling', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: 'Failed to execute task move',
      code: 'INTERNAL_ERROR',
      traceId: 'c1e17ace',
    }, { status: 500 })));

    await expect(executeTaskMove({
      taskId: 'task-1',
      targetConnectorInstanceId: 'inst-2',
      targetSourceListId: 'list-1',
      sourceAction: 'move',
    })).rejects.toMatchObject({
      message: 'Failed to execute task move',
      status: 500,
      code: 'INTERNAL_ERROR',
      traceId: 'c1e17ace',
    });
  });

  it('ignores an unsafe trace ID from an error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: 'Failed to execute task move',
      code: 'INTERNAL_ERROR',
      traceId: 'private task title\nsecret',
    }, { status: 500 })));

    await expect(executeTaskMove({
      taskId: 'task-1',
      targetConnectorInstanceId: 'inst-2',
      targetSourceListId: 'list-1',
      sourceAction: 'move',
    })).rejects.toMatchObject({
      traceId: undefined,
    });
  });
});
