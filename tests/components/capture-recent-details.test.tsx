import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecentCaptures } from '@/components/capture/RecentCaptures';
import CapturePageInner from '@/app/capture/CapturePageInner';

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock('@/lib/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ enqueue: vi.fn() }),
}));

vi.mock('@/components/capture/VoiceButton', () => ({
  VoiceButton: ({ className }: { className?: string }) => (
    <button type="button" className={className}>Voice</button>
  ),
}));

vi.mock('@/components/capture/ContextChips', () => ({
  ContextChips: () => null,
}));

vi.mock('@/components/PendingSyncIndicator', () => ({
  PendingSyncIndicator: () => null,
}));

vi.mock('@/components/ui/MobileSheet', () => ({
  MobileSheet: ({
    isOpen,
    children,
    onClose,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    onClose: () => void;
    ariaLabel: string;
  }) => isOpen ? (
    <div role="dialog" aria-label={ariaLabel}>
      <button type="button" onClick={onClose}>Close sheet</button>
      {children}
    </div>
  ) : null,
}));

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    taskId,
    mode,
    onClose,
  }: {
    taskId: string;
    mode: string;
    onClose: () => void;
  }) => (
    <section data-testid="task-detail" data-task-id={taskId} data-mode={mode}>
      <button type="button" onClick={onClose}>Close task detail</button>
    </section>
  ),
}));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      tasks: [{
        id: 'capture-1',
        title: 'Review mobile capture',
        createdAt: new Date().toISOString(),
        status: 'todo',
      }],
    }),
  });
});

describe('recent capture task details', () => {
  it('renders the capture heading without a secondary label', () => {
    render(<CapturePageInner />);

    expect(screen.getByRole('heading', { name: 'Quick Capture' })).toBeInTheDocument();
    expect(screen.queryByText('Capture now, triage later.')).not.toBeInTheDocument();
  });

  it('reports the selected task when a recent capture is clicked', async () => {
    const onSelectTask = vi.fn();
    render(<RecentCaptures onSelectTask={onSelectTask} />);

    fireEvent.click(await screen.findByRole('button', { name: /Review mobile capture/ }));

    expect(onSelectTask).toHaveBeenCalledWith('capture-1');
  });

  it('opens the selected capture in the shared mobile task detail sheet', async () => {
    render(<CapturePageInner />);

    fireEvent.click(await screen.findByRole('button', { name: /Review mobile capture/ }));

    const sheet = screen.getByRole('dialog', { name: 'Task details' });
    const detail = within(sheet).getByTestId('task-detail');
    expect(detail).toHaveAttribute('data-task-id', 'capture-1');
    expect(detail).toHaveAttribute('data-mode', 'mobile');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close task detail' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Task details' })).not.toBeInTheDocument();
    });
  });
});

describe('mobile capture controls', () => {
  it('places the voice control after the title field on mobile', () => {
    render(<CapturePageInner />);

    const titleInput = screen.getByLabelText('Task or note');
    const voiceButton = screen.getByRole('button', { name: 'Voice' });
    const controlGroup = titleInput.parentElement;

    expect(controlGroup).toHaveClass(
      'grid',
      'grid-cols-1',
      'sm:grid-cols-[1fr_auto]',
      'sm:items-start',
    );
    expect(titleInput.compareDocumentPosition(voiceButton) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(titleInput).toHaveClass('sm:col-span-2', 'sm:row-start-2');
    expect(voiceButton).toHaveClass(
      'mt-2',
      'sm:col-start-2',
      'sm:row-start-1',
      'sm:mt-0',
    );
  });
});
