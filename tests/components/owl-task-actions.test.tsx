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

    fireEvent.click(screen.getByText('Correct extraction'));
    fireEvent.change(screen.getByLabelText('Urgency'), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save urgency' }));

    await waitFor(() => {
      expect(screen.getByText('Paperless mutation failed')).toBeInTheDocument();
    });
    expect(screen.queryByText('Urgency correction sent to OWL.')).not.toBeInTheDocument();
  });
});
