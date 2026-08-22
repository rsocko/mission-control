import { beforeEach, describe, expect, it, vi } from 'vitest';

const { performOwlTaskAction } = vi.hoisted(() => ({
  performOwlTaskAction: vi.fn(),
}));

vi.mock('@/lib/connectors/document-intelligence/task-actions', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/lib/connectors/document-intelligence/task-actions')
  >();
  return { ...actual, performOwlTaskAction };
});

import {
  OwlTaskActionError,
} from '@/lib/connectors/document-intelligence/task-actions';
import { POST } from '@/app/api/tasks/[id]/owl/route';

function request(body: unknown) {
  return new Request('http://localhost/api/tasks/task-1/owl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/[id]/owl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects malformed action payloads before invoking the service', async () => {
    const response = await POST(request({
      action: 'correct',
      field: 'urgency',
      value: 'eventually',
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(422);
    expect(performOwlTaskAction).not.toHaveBeenCalled();
  });

  it('returns the remote-first local update contract', async () => {
    performOwlTaskAction.mockResolvedValue({
      status: 'todo',
      statusReason: null,
      snoozedUntil: '2026-08-23T13:00:00.000Z',
      priority: 'high',
      metadata: { owlStatus: 'snoozed' },
      updatedAt: '2026-08-22T13:00:00.000Z',
      syncStatus: 'synced',
    });

    const response = await POST(request({
      action: 'snooze',
      until: '2026-08-23T13:00:00.000Z',
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      task: {
        status: 'todo',
        snoozedUntil: '2026-08-23T13:00:00.000Z',
        syncStatus: 'synced',
      },
    });
  });

  it('surfaces task scope and connector write-back failures', async () => {
    performOwlTaskAction.mockRejectedValueOnce(
      new OwlTaskActionError('This action is available only for OWL tasks', 'NOT_OWL', 400),
    );
    const nonOwl = await POST(request({ action: 'not_an_action' }), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    performOwlTaskAction.mockRejectedValueOnce(
      new OwlTaskActionError('Paperless mutation failed', 'REMOTE_WRITE_FAILED', 502),
    );
    const remoteFailure = await POST(request({ action: 'not_an_action' }), {
      params: Promise.resolve({ id: 'task-1' }),
    });

    expect(nonOwl.status).toBe(400);
    await expect(nonOwl.json()).resolves.toMatchObject({ code: 'NOT_OWL' });
    expect(remoteFailure.status).toBe(502);
    await expect(remoteFailure.json()).resolves.toMatchObject({
      code: 'REMOTE_WRITE_FAILED',
      error: 'Paperless mutation failed',
    });
  });
});
