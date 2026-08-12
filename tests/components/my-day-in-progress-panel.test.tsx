import { fireEvent, render, screen } from '@testing-library/react';
import { InProgressPanel } from '@/components/today/TodayMainPanel';
import type { MyDayItem } from '@/components/today/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span aria-label={alt} />,
}));

function makeItem(): MyDayItem {
  return {
    id: 'my-day-1',
    taskId: 'task-1',
    order: 1,
    isAutoIncluded: false,
    addedAt: '2026-08-05T12:00:00.000Z',
    title: 'Review connector retries',
    status: 'in_progress',
    priority: 'high',
    dueDate: null,
    connectorType: 'github-issues',
    connectorInstanceId: 'github-1',
    sourceId: 'source-1',
    sourceListName: 'Mission Control',
    createdAt: '2026-08-01T12:00:00.000Z',
    tags: [],
    hasDescription: false,
    localDisposition: 'active',
    taskSourceModel: 'remote-managed',
    editPolicy: editableTaskPolicy,
  };
}

describe('InProgressPanel', () => {
  it('selects an active task and starts focus independently', () => {
    const item = makeItem();
    const onSelectTask = vi.fn();
    const onStartFocus = vi.fn();
    render(
      <InProgressPanel
        items={[item]}
        onSelectTask={onSelectTask}
        onStartFocus={onStartFocus}
      />,
    );

    fireEvent.click(screen.getByText(item.title));
    expect(onSelectTask).toHaveBeenCalledWith(item.taskId);

    fireEvent.click(screen.getByRole('button', { name: `Focus on ${item.title}` }));
    expect(onStartFocus).toHaveBeenCalledWith(item);
    expect(onSelectTask).toHaveBeenCalledTimes(1);
  });

  it('shows a useful empty state', () => {
    render(
      <InProgressPanel
        items={[]}
        onSelectTask={vi.fn()}
        onStartFocus={vi.fn()}
      />,
    );

    expect(screen.getByText('Nothing is in progress yet.')).toBeInTheDocument();
  });
});
