import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncHistorySection } from '@/app/settings/components/SyncHistorySection';

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    message,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) => open ? (
    <div role="alertdialog">
      <p>{message}</p>
      <button onClick={onConfirm}>{confirmLabel}</button>
    </div>
  ) : null,
}));

describe('Sync History retained items', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('explains retained items and shows safe reason-specific actions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      history: [{
        id: 'log-1',
        connectorId: 'doc-1',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 1,
        notificationsAdded: 0,
        errors: [],
        details: [{
          action: 'protected',
          taskId: 'task-1',
          taskTitle: 'Pay invoice',
          taskSourceId: '42',
          reason: 'Has pending local changes (push_error)',
        }],
        syncedAt: '2026-08-03T20:00:00.000Z',
        durationMs: 120,
      }],
      hasMore: false,
    }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    const row = await screen.findByRole('button', { name: /OWL/i });
    fireEvent.click(row);

    expect(await screen.findByText('Local changes pending')).toBeInTheDocument();
    expect(screen.getByText('Action recommended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry push' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as local task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard local changes' })).toBeInTheDocument();
    expect(screen.queryByText(/^Protected$/i)).not.toBeInTheDocument();
  });

  it('links capability-blocked items to the exact connector settings panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      history: [{
        id: 'log-2',
        connectorId: 'email-1',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 1,
        notificationsAdded: 0,
        errors: [],
        details: [{
          action: 'protected',
          taskTitle: 'Email follow-up',
          taskSourceId: 'email-42',
          reason: 'Write disabled for connector',
        }],
        syncedAt: '2026-08-03T20:00:00.000Z',
        durationMs: 120,
      }],
      hasMore: false,
    }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'email-1',
      type: 'outlook-email',
      name: 'Email',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: false },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Email/i }));
    const link = await screen.findByRole('link', { name: 'Open write setting' });
    expect(link).toHaveAttribute('href', '/settings/connectors?setting=Capabilities&connector=email-1');
    await waitFor(() => expect(screen.getByText('Configuration required')).toBeInTheDocument());
  });

  it('replaces retry with the connector write setting when writes are currently disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      history: [{
        id: 'log-current-capability',
        connectorId: 'doc-1',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 1,
        notificationsAdded: 0,
        errors: [],
        details: [{
          action: 'protected',
          taskId: 'task-1',
          taskTitle: 'Pending local edit',
          taskSourceId: 'source-1',
          reason: 'Has pending local changes (push_error)',
        }],
        syncedAt: '2026-08-03T20:00:00.000Z',
        durationMs: 120,
      }],
      hasMore: false,
    }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: false },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /OWL/i }));

    expect(await screen.findByRole('link', { name: 'Open write setting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry push' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as local task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard local changes' })).toBeInTheDocument();
  });

  it('uses task creation capability instead of write capability for local-task retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      history: [{
        id: 'log-create-only',
        connectorId: 'doc-1',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 1,
        notificationsAdded: 0,
        errors: [],
        details: [{
          action: 'protected',
          taskId: 'task-1',
          taskTitle: 'Create-only task',
          taskSourceId: 'local:task-1',
          reason: 'Local-only task not yet pushed to remote',
        }],
        syncedAt: '2026-08-03T20:00:00.000Z',
        durationMs: 120,
      }],
      hasMore: false,
    }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Create-only connector',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: false, taskCreate: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /Create-only connector/i }));

    expect(await screen.findByRole('button', { name: 'Retry push' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open task creation setting' })).not.toBeInTheDocument();
  });

  it('confirms reason-compatible bulk actions and applies partial results immediately', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [{
          id: 'log-bulk',
          connectorId: 'doc-1',
          success: true,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          tasksPushed: 0,
          localOnlyProtected: 3,
          notificationsAdded: 0,
          errors: [],
          details: [
            {
              action: 'protected',
              taskId: 'task-1',
              taskTitle: 'Pending edit one',
              taskSourceId: 'source-1',
              reason: 'Has pending local changes (push_error)',
            },
            {
              action: 'protected',
              taskId: 'task-2',
              taskTitle: 'Pending edit two',
              taskSourceId: 'source-2',
              reason: 'Has pending local changes (pending_push)',
            },
            {
              action: 'protected',
              taskId: 'task-3',
              taskTitle: 'Closed history',
              taskSourceId: 'source-3',
              reason: 'Completed/cancelled task retained locally (status: done)',
            },
          ],
          syncedAt: '2026-08-03T20:00:00.000Z',
          durationMs: 120,
        }],
        hasMore: false,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        succeeded: 1,
        failed: 1,
        results: [
          {
            syncLogId: 'log-bulk',
            detailIndex: 0,
            resolution: 'discard_local_changes',
            success: true,
            resolutionStatus: 'succeeded',
            message: 'Discarded first task',
            syncStatus: 'deleted',
          },
          {
            syncLogId: 'log-bulk',
            detailIndex: 1,
            resolution: 'discard_local_changes',
            success: false,
            resolutionStatus: 'failed',
            message: 'Second task changed',
          },
        ],
      }), { status: 207 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /OWL/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Discard local changes' }))[0]);

    expect(await screen.findByText(/permanently delete these 2 tasks/i)).toBeInTheDocument();
    const confirmationButtons = screen.getAllByRole('button', { name: 'Discard local changes' });
    fireEvent.click(confirmationButtons[confirmationButtons.length - 1]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      items: [
        { detailIndex: 0, resolution: 'discard_local_changes', confirmed: true },
        { detailIndex: 1, resolution: 'discard_local_changes', confirmed: true },
      ],
    });
    expect(await screen.findByText(/Resolved: Discarded first task/i)).toBeInTheDocument();
    expect(screen.getByText(/Last attempt failed: Second task changed/i)).toBeInTheDocument();
  });

  it('does not offer retry when an interrupted create has an unknown outcome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      history: [{
        id: 'log-3',
        connectorId: 'doc-1',
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        tasksPushed: 0,
        localOnlyProtected: 1,
        notificationsAdded: 0,
        errors: [],
        details: [{
          action: 'protected',
          taskId: 'task-1',
          taskTitle: 'Create upstream task',
          taskSourceId: 'local:task-1',
          reason: 'Local-only task not yet pushed to remote',
          resolution: {
            action: 'retry_push',
            status: 'indeterminate',
            resolvedAt: '2026-08-03T20:00:00.000Z',
            message: 'The upstream outcome is unknown.',
          },
        }],
        syncedAt: '2026-08-03T20:00:00.000Z',
        durationMs: 120,
      }],
      hasMore: false,
    }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /OWL/i }));

    expect(await screen.findByText(/upstream outcome is unknown/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry push' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep as local task' })).toBeInTheDocument();
  });

  it('refreshes when a sync history change event is emitted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [],
        hasMore: false,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [{
          id: 'log-failed',
          connectorId: 'doc-1',
          success: false,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          tasksPushed: 0,
          localOnlyProtected: 0,
          notificationsAdded: 0,
          errors: ['HTTP 502'],
          details: [],
          syncedAt: '2026-08-03T22:30:00.000Z',
          durationMs: 250,
        }],
        hasMore: false,
      }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    expect(await screen.findByText('Sync history will appear here once you run your first sync.')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('mission-control:sync-complete'));

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('HTTP 502')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows overdue schedule timing and an explicit sync action', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [{
          id: 'log-scheduled',
          connectorId: 'doc-1',
          success: true,
          tasksAdded: 0,
          tasksUpdated: 0,
          tasksRemoved: 0,
          tasksPushed: 0,
          localOnlyProtected: 0,
          notificationsAdded: 0,
          errors: [],
          details: [],
          syncedAt: '2026-08-03T20:01:00.000Z',
          durationMs: 1000,
          jobId: 'job-1',
          trigger: 'schedule',
          scheduledFor: '2026-08-03T20:00:00.000Z',
          startedAt: '2026-08-03T20:00:30.000Z',
          attempt: 1,
          maxAttempts: 3,
        }],
        scheduleHealth: {
          status: 'action_required',
          message: '1 connector schedule is overdue while the worker is online.',
          userAction: {
            type: 'sync_now',
            label: 'Sync overdue connectors now',
            detail: 'Run this sync now.',
          },
          worker: {
            available: true,
            startedAt: '2026-08-03T19:00:00.000Z',
            heartbeatAt: '2026-08-03T20:05:00.000Z',
          },
          schedules: [{
            connectorId: 'doc-1',
            intervalMinutes: 5,
            nextDueAt: '2026-08-03T20:05:00.000Z',
            lastEnqueuedAt: '2026-08-03T20:00:00.000Z',
            overdueMs: 300000,
            overdue: true,
          }],
        },
        hasMore: false,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [],
        scheduleHealth: {
          status: 'healthy',
          message: 'Automatic sync schedules are on time.',
          userAction: null,
          worker: null,
          schedules: [],
        },
        hasMore: false,
      }), { status: 200 }));

    render(<SyncHistorySection connectors={[{
      id: 'doc-1',
      type: 'document-intelligence',
      name: 'Document Intelligence',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, write: true },
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
    }]} />);

    expect(await screen.findByText('Action required')).toBeInTheDocument();
    expect(screen.getByText(/overdue 5m/i)).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('No action needed')).toBeInTheDocument();
  });
});
