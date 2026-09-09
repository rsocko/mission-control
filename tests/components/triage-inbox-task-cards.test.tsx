import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TriageGalleryView from '@/components/triage/TriageGalleryView';
import TriageStreamItem from '@/components/triage/TriageStreamItem';
import TriageFilterSidebar from '@/components/triage/TriageFilterSidebar';
import { toInboxTaskItem, type InboxTaskDto } from '@/lib/inbox/items';

vi.mock('@/lib/hooks/useListAnimate', () => ({
  useListAnimate: () => [{ current: null }],
}));

function makeTask(): InboxTaskDto {
  return {
    id: 'task-1',
    sourceId: 'source-1',
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: 'Organize captured note',
    status: 'todo',
    priority: 'medium',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
    sourceListName: 'Inbox',
    hubProjectIds: [],
  };
}

describe('Inbox task cards', () => {
  it('renders task-specific routing actions in the stream', () => {
    const onAction = vi.fn();

    render(
      <TriageStreamItem
        item={toInboxTaskItem(makeTask())}
        isSelected={false}
        isBulkSelected={false}
        bulkMode={false}
        onSelect={vi.fn()}
        onBulkToggle={vi.fn()}
        onAction={onAction}
      />,
    );

    expect(screen.getByText(/Needs filing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep task/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /karakeep/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep task/i }));
    expect(onAction).toHaveBeenCalledWith('task:task-1', 'complete_action');
  });

  it('renders tasks in gallery view with filing context', () => {
    render(
      <TriageGalleryView
        items={[toInboxTaskItem(makeTask())]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busyAction={null}
        loading={false}
        density="default"
        onDensityChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Organize captured note')).toBeInTheDocument();
    expect(screen.getByText('Needs filing')).toBeInTheDocument();
    expect(screen.getByTitle('Keep task')).toBeInTheDocument();
  });
});

describe('Inbox groups', () => {
  it('groups tasks and content while keeping content sources nested', () => {
    const onGroupChange = vi.fn();
    const onSourceChange = vi.fn();

    render(
      <TriageFilterSidebar
        stats={{
          total: 5,
          pending: 5,
          snoozed: 0,
          actioned: 0,
          dismissed: 0,
          sourceCounts: { github: 3 },
        }}
        query=""
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        group="all"
        onGroupChange={onGroupChange}
        groupCounts={{ all: 7, tasks: 2, content: 5 }}
        status="pending"
        onStatusChange={vi.fn()}
        source="all"
        onSourceChange={onSourceChange}
        contentTypeFilter={null}
        onContentTypeChange={vi.fn()}
        contentTypeCounts={{ task: 2, repo: 3 }}
        actionTypeFilter={null}
        onActionTypeChange={vi.fn()}
        actionTypeCounts={{}}
      />,
    );

    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getByText('Content sources')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Tasks group (2)' }));
    expect(onGroupChange).toHaveBeenCalledWith('tasks');
    expect(onSourceChange).toHaveBeenCalledWith('all');
  });
});
