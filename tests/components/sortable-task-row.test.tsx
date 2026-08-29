import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SortableTaskRow } from '@/components/today/SortableTaskRow';
import type { MyDayItem } from '@/components/today/types';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock('motion/react', () => ({
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  useMotionValue: () => 0,
  useTransform: () => 0,
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/lib/stores/dashboardViewStore', () => ({
  useDashboardViewStore: () => ({ tagFilter: [], setTagFilter: vi.fn() }),
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <span data-tooltip={typeof content === 'string' ? content : undefined}>{children}</span>
  ),
}));

vi.mock('@/components/ui/CompletionBurst', () => ({
  CompletionBurst: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/SubtaskPill', () => ({
  SubtaskPill: () => null,
}));

vi.mock('@/components/smart-score/SmartScoreBadge', () => ({
  SmartScoreBadge: () => <span data-testid="smart-score" />,
}));

vi.mock('@/components/task-row/TaskRowActions', () => ({
  TaskRowActions: (props: {
    smartScore?: number | null;
    planningHorizon?: string | null;
    effort?: number | null;
    priority: string;
    status: string;
    onFilterPriority?: (priority: string) => void;
    onFilterStatus?: (status: string) => void;
  }) => (
    <>
      <span
        data-testid="task-row-actions"
        data-score={props.smartScore}
        data-horizon={props.planningHorizon}
        data-effort={props.effort}
        data-priority={props.priority}
        data-status={props.status}
      />
      <button type="button" onClick={() => props.onFilterPriority?.(props.priority)}>Filter priority</button>
      <button type="button" onClick={() => props.onFilterStatus?.(props.status)}>Filter status</button>
    </>
  ),
}));

vi.mock('@/types/dashboard', () => ({
  CONNECTOR_ICONS: {},
}));

vi.mock('@/types', () => ({
  MICRO_STATUS_CONFIG: {},
}));

const item: MyDayItem = {
  id: 'day-item-1',
  taskId: 'task-1',
  order: 0,
  isAutoIncluded: false,
  addedAt: '2026-08-06T12:00:00.000Z',
  completedAt: null,
  title: 'Narrow row',
  status: 'in_progress',
  priority: 'high',
  dueDate: null,
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListName: null,
  createdAt: '2026-08-06T12:00:00.000Z',
  tags: [],
  metadata: JSON.stringify({ recurrence: 'weekly' }),
  effort: 3,
  planningHorizon: 'soon',
  estimatedDuration: 30,
  smartScore: 80,
  hasDescription: false,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('SortableTaskRow aligned properties', () => {
  it('passes comparable properties to the shared grid and keeps secondary signals with task metadata', () => {
    const onFilterPriority = vi.fn();
    const onFilterStatus = vi.fn();
    const { container } = render(
      <SortableTaskRow
        item={item}
        onComplete={vi.fn()}
        onFocus={vi.fn()}
        onSchedule={vi.fn()}
        onRemove={vi.fn()}
        onSelect={vi.fn()}
        isSelected={false}
        onSetDueDate={vi.fn()}
        onSetPriority={vi.fn()}
        onSetStatus={vi.fn()}
        onFilterPriority={onFilterPriority}
        onFilterStatus={onFilterStatus}
        onOpenNotes={vi.fn()}
        draggable={false}
      />,
    );

    const row = container.firstElementChild;
    const children = Array.from(row?.children ?? []);
    const actions = screen.getByTestId('task-row-actions');
    const duration = screen.getByTitle('Estimated: 30min');
    const recurrence = screen.getByText('Narrow row').closest('.flex-1')
      ?.querySelector<HTMLElement>('[data-tooltip="Repeats: weekly"]') ?? null;
    const taskCopy = screen.getByText('Narrow row').closest('.flex-1');

    expect(actions).toHaveAttribute('data-score', '80');
    expect(actions).toHaveAttribute('data-horizon', 'soon');
    expect(actions).toHaveAttribute('data-effort', '3');
    expect(actions).toHaveAttribute('data-priority', 'high');
    expect(actions).toHaveAttribute('data-status', 'in_progress');
    expect(duration).toHaveClass('hidden', '@min-[640px]:flex');
    expect(taskCopy).toContainElement(duration);
    expect(taskCopy).toContainElement(recurrence);
    expect(children.indexOf(actions)).toBeGreaterThan(children.indexOf(taskCopy!));

    fireEvent.click(screen.getByRole('button', { name: 'Filter priority' }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter status' }));
    expect(onFilterPriority).toHaveBeenCalledWith('high');
    expect(onFilterStatus).toHaveBeenCalledWith('in_progress');
  });
});
