import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskConnectorSyncState } from '@/components/task-list/TaskConnectorSyncState';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TaskConnectorSyncState', () => {
  it('prevents duplicate retries and announces a confirmed retry', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    let resolveSync!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveSync = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onRetryComplete = vi.fn();

    render(
      <TaskConnectorSyncState
        taskId="task-1"
        syncStatus="push_failed"
        connectorType="github-issues"
        connectorInstanceId="github-work"
        pushRetryCount={5}
        onRetryComplete={onRetryComplete}
      />,
    );

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(retry).toBeDisabled();

    resolveSync(new Response(JSON.stringify({ results: [{ success: true }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    expect(await screen.findByText(
      'Sync with GitHub Issues finished. Checking the task state.',
    )).toBeVisible();
    await waitFor(() => expect(onRetryComplete).toHaveBeenCalledOnce());
  });

  it('does not issue a retry while offline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

    render(
      <TaskConnectorSyncState
        syncStatus="push_error"
        connectorType="microsoft-todo"
        connectorInstanceId="todo-work"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are offline. Retry when your connection returns.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps rejected retries actionable without exposing provider details', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ success: false, error: 'secret provider payload' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    render(
      <TaskConnectorSyncState
        syncStatus="conflict"
        connectorType="github-issues"
        connectorInstanceId="github-work"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not sync with GitHub Issues');
    expect(alert).not.toHaveTextContent('secret provider payload');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
