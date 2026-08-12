import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from '@/app/kanban/components/KanbanBoard';
import type { KanbanColumn, Task } from '@/app/kanban/components/types';

const dndHandlers = vi.hoisted(() => ({
  onDragEnd: undefined as ((event: { over: { id: string } | null }) => void) | undefined,
}));
const motionDivProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragEnd: (event: { over: { id: string } | null }) => void;
  }) => {
    dndHandlers.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  closestCorners: vi.fn(),
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn() })),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
      motionDivProps.push(props);
      return <div>{children}</div>;
    },
  },
}));

vi.mock('@/app/kanban/components/ColumnHeader', () => ({
  ColumnHeader: () => null,
}));

vi.mock('@/app/kanban/components/KanbanCard', () => ({
  KanbanCard: () => null,
}));

vi.mock('@/app/kanban/components/QuickAddInput', () => ({
  QuickAddInput: () => null,
}));

const columns: KanbanColumn[] = [
  { id: 'backlog', name: 'Backlog', color: '#64748b' },
  { id: 'doing', name: 'Doing', color: '#3b82f6' },
];

const task = {
  id: 'task-1',
  title: 'Move me',
  status: 'open',
  priority: 'none',
  dueDate: null,
  connectorType: 'local',
  sourceListId: null,
  sourceListName: null,
  kanbanColumn: 'backlog',
  kanbanOrder: null,
  tags: [],
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: {} as Task['editPolicy'],
} satisfies Task;

function renderBoard(onDrop: (columnId: string) => void, tasks: Task[] = []) {
  render(
    <KanbanBoard
      loading={false}
      tasks={tasks}
      columns={columns}
      globalColumns={columns}
      unmappedColumns={[]}
      isProjectView={false}
      editingColumns={false}
      renamingColumn={null}
      renameValue=""
      quickAddColumn={null}
      quickAddTitle=""
      expandedColumns={new Set()}
      showSources={false}
      showDueDates={false}
      searchQuery=""
      swimlaneMode="none"
      showScores={false}
      dragging={null}
      bulk={{ bulkMode: false, bulkSelected: new Set(), toggleItem: vi.fn() }}
      getTasksForColumn={(column) => tasks.filter((item) => item.kanbanColumn === column.id)}
      getSwimlaneGroups={() => [{ key: 'all', label: '' }]}
      getTasksForSwimlane={(tasks) => tasks}
      taskMatchesSearch={() => true}
      onFixMappings={vi.fn()}
      onDragStart={vi.fn()}
      onDrop={onDrop}
      onTaskClick={vi.fn()}
      onStartRename={vi.fn()}
      onRenameChange={vi.fn()}
      onConfirmRename={vi.fn()}
      onCancelRename={vi.fn()}
      onReorder={vi.fn()}
      onRemoveColumn={vi.fn()}
      onToggleQuickAdd={vi.fn()}
      onWipLimitChange={vi.fn()}
      onUpdateColumnMapping={vi.fn()}
      onExpandColumn={vi.fn()}
      onCollapseColumn={vi.fn()}
      onQuickAddChange={vi.fn()}
      onQuickAddSubmit={vi.fn()}
      onQuickAddCancel={vi.fn()}
      onSnoozeTask={vi.fn()}
    />,
  );
}

describe('KanbanBoard drag and drop', () => {
  beforeEach(() => {
    dndHandlers.onDragEnd = undefined;
    motionDivProps.length = 0;
  });

  it('moves a dropped task immediately when it lands on a column', () => {
    const onDrop = vi.fn();
    renderBoard(onDrop);

    act(() => {
      dndHandlers.onDragEnd?.({ over: { id: 'doing' } });
    });

    expect(onDrop).toHaveBeenCalledWith('doing');
  });

  it('does not add a full-layout Motion wrapper around sortable cards', () => {
    renderBoard(vi.fn(), [task]);

    expect(motionDivProps.some((props) => props.layout === true)).toBe(false);
    expect(motionDivProps.some((props) => props.layout === 'position')).toBe(true);
  });
});
