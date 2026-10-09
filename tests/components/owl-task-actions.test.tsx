import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwlTaskActions } from '@/components/task-detail/OwlTaskActions';
import { getTaskStatusOptions } from '@/components/task-detail/TaskPropertiesSection';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OWL task lifecycle controls', () => {
  it('exposes only OWL-supported statuses with source-specific labels', () => {
    expect(getTaskStatusOptions(
      'document-intelligence',
      ['todo', 'done', 'cancelled'],
    ).map(({ value, label }) => ({ value, label }))).toEqual([
      { value: 'todo', label: 'To Do' },
      { value: 'done', label: 'Done' },
      { value: 'cancelled', label: "Won't do" },
    ]);
  });

  it('sends no-action classifier feedback and announces success', async () => {
    const onTaskUpdate = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      task: {
        status: 'cancelled',
        statusReason: 'not_planned',
        snoozedUntil: null,
        priority: 'high',
        metadata: { owlStatus: 'not_an_action' },
        updatedAt: '2026-08-22T13:00:00.000Z',
        syncStatus: 'synced',
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <OwlTaskActions
        taskId="task-1"
        metadata={{ actionType: 'pay', urgency: 'high', amount: 50 }}
        onTaskUpdate={onTaskUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No action needed' }));

    expect(await screen.findByText('Marked as no action needed in OWL.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/owl', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'not_an_action' }),
    }));
    expect(onTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('surfaces remote correction failures without reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Paperless mutation failed',
    }), { status: 502 })));
    render(
      <OwlTaskActions
        taskId="task-1"
        metadata={{ actionType: 'pay', urgency: 'high', amount: 50 }}
        onTaskUpdate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'OWL urgency' }));
    fireEvent.click(screen.getByRole('option', { name: 'P3 · Low' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save source corrections' }));

    await waitFor(() => {
      expect(screen.getByText('Paperless mutation failed')).toBeInTheDocument();
    });
    expect(screen.queryByText('1 source correction saved in OWL.')).not.toBeInTheDocument();
  });

  it('saves changed OWL fields as one correction batch', async () => {
    const onTaskUpdate = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      task: {
        status: 'todo',
        statusReason: null,
        snoozedUntil: null,
        priority: 'high',
        metadata: { actionType: 'sign', urgency: 'critical', amount: 75 },
        updatedAt: '2026-08-24T13:00:00.000Z',
        syncStatus: 'synced',
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <OwlTaskActions
        taskId="task-1"
        metadata={{ actionType: 'pay', urgency: 'high', amount: 50 }}
        onTaskUpdate={onTaskUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'OWL action type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Sign' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'OWL urgency' }));
    fireEvent.click(screen.getByRole('option', { name: 'P0 · Critical' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save source corrections' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/tasks/task-1/owl', expect.objectContaining({
      body: JSON.stringify({ action: 'correct', field: 'action_type', value: 'sign' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/tasks/task-1/owl', expect.objectContaining({
      body: JSON.stringify({ action: 'correct', field: 'urgency', value: 'critical' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/tasks/task-1/owl', expect.objectContaining({
      body: JSON.stringify({ action: 'correct', field: 'amount', value: 75 }),
    }));
    expect(onTaskUpdate).toHaveBeenCalledOnce();
    expect(await screen.findByText('3 source corrections saved in OWL.')).toBeInTheDocument();
  });

  it('renders source-only controls without duplicating Mission Control completion', async () => {
    const onTaskUpdate = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      task: {
        status: 'done',
        statusReason: 'completed',
        snoozedUntil: null,
        priority: 'low',
        metadata: { owlStatus: 'completed' },
        updatedAt: '2026-08-24T13:00:00.000Z',
        syncStatus: 'synced',
      },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <OwlTaskActions
        taskId="task-1"
        metadata={{
          actionType: 'file',
          primaryActionLabel: 'Open filing instructions',
          primaryActionUrl: 'https://owl.example/instructions',
          reviewUrl: 'https://owl.example/needs-review/task-1',
          sourceActions: [{
            id: 'file_document',
            label: 'File in Paperless',
            method: 'POST',
            url: '/api/action-queue/actions/task-1/file',
          }],
        }}
        onTaskUpdate={onTaskUpdate}
      />,
    );

    expect(screen.getByRole('link', { name: 'Open filing instructions' })).toHaveAttribute(
      'href',
      'https://owl.example/instructions',
    );
    expect(screen.getByRole('link', { name: 'Review/correct in OWL' })).toHaveAttribute(
      'href',
      'https://owl.example/needs-review/task-1',
    );
    expect(screen.getByText(/Done becomes completed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done in OWL' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'File in Paperless' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1/owl',
      expect.objectContaining({
        body: JSON.stringify({
          action: 'source_action',
          sourceActionId: 'file_document',
        }),
      }),
    ));
  });
});
