import { render, screen } from '@testing-library/react';
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
  TaskRowActions: () => <span data-testid="task-row-actions" />,
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
  estimatedDuration: 30,
  smartScore: 80,
  hasDescription: false,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

describe('SortableTaskRow responsive trailing controls', () => {
  it('hides lower-priority badges before they can displace the rightmost action rail', () => {
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
        onOpenNotes={vi.fn()}
        draggable={false}
      />,
    );

    const row = container.firstElementChild;
    const children = Array.from(row?.children ?? []);
    const actions = screen.getByTestId('task-row-actions');
    const effort = screen.getByTitle('Effort: M');
    const duration = screen.getByTitle('Estimated: 30min');
    const recurrence = screen.getByText('Narrow row').closest('.group')
      ?.querySelector('[data-tooltip="Repeats: weekly"]')?.parentElement;
    const smartScore = screen.getByTestId('smart-score').parentElement;

    expect(effort).toHaveClass('hidden', '@min-[640px]:inline');
    expect(duration).toHaveClass('hidden', '@min-[640px]:flex');
    expect(recurrence).toHaveClass('hidden', '@min-[640px]:flex');
    expect(smartScore).toHaveClass('hidden', '@min-[640px]:block');
    expect(children.indexOf(effort)).toBeLessThan(children.indexOf(actions));
    expect(children.indexOf(duration)).toBeLessThan(children.indexOf(actions));
    expect(children.indexOf(recurrence!)).toBeLessThan(children.indexOf(actions));
    expect(children.indexOf(smartScore!)).toBeLessThan(children.indexOf(actions));
  });
});
