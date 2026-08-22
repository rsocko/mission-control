import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { TaskDetailHeader } from '@/components/task-detail/TaskDetailHeader';
import { TaskTagsSection } from '@/components/task-detail/TaskTagsSection';
import { TaskDocumentPreviewSection } from '@/components/task-detail/TaskDocumentPreviewSection';
import { TaskSourceActionsSection } from '@/components/task-detail/TaskSourceActionsSection';
import { TaskDetailFooter, TaskMobileActionBar } from '@/components/task-detail/TaskDetailFooter';
import { TaskDuplicatesSection } from '@/components/task-detail/TaskDuplicatesSection';

vi.mock('@/components/task-detail/DuplicateTaskPreview', () => ({
  DuplicateTaskPreview: ({ candidate }: { candidate: { title: string } }) => <div>{candidate.title}</div>,
}));

function renderWithTooltips(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const headerProps = {
  mode: 'panel' as const,
  iconSrc: null,
  connectorType: 'github-issues',
  sourceListName: null,
  title: 'Rewrite the importer',
  titleValue: 'Rewrite the importer',
  editingTitle: false,
  canEditTitle: true,
  titleRef: createRef<HTMLInputElement>(),
  onTitleValueChange: vi.fn(),
  onTitleCommit: vi.fn(),
  onTitleCancel: vi.fn(),
  onTitleEditStart: vi.fn(),
  contextLabel: 'Platform',
  displayId: 'GH-42',
  updatedAtLabel: 'Updated today',
  onClose: vi.fn(),
};

describe('TaskDetailHeader', () => {
  it('falls back to a humanized connector name and exposes the display id', () => {
    renderWithTooltips(<TaskDetailHeader {...headerProps} />);

    expect(screen.getByText('github issues')).toBeInTheDocument();
    expect(screen.getByText('GH-42')).toBeInTheDocument();
    expect(screen.getByText('Updated today')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rewrite the importer' })).toBeInTheDocument();
  });

  it('starts title editing from the heading and closes from the header', () => {
    const onTitleEditStart = vi.fn();
    const onClose = vi.fn();
    renderWithTooltips(
      <TaskDetailHeader {...headerProps} onTitleEditStart={onTitleEditStart} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rewrite the importer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close task detail' }));

    expect(onTitleEditStart).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('commits on Enter and cancels on Escape while editing', () => {
    const onTitleCommit = vi.fn();
    const onTitleCancel = vi.fn();
    renderWithTooltips(
      <TaskDetailHeader
        {...headerProps}
        editingTitle
        onTitleCommit={onTitleCommit}
        onTitleCancel={onTitleCancel}
      />,
    );

    const input = screen.getByDisplayValue('Rewrite the importer');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onTitleCommit).toHaveBeenCalledOnce();
    expect(onTitleCancel).toHaveBeenCalledOnce();
  });

  it('explains a locked title instead of offering an editor', () => {
    renderWithTooltips(
      <TaskDetailHeader
        {...headerProps}
        canEditTitle={false}
        titleBlockedReason="title is controlled by the upstream task source"
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rewrite the importer' })).not.toBeInTheDocument();
    expect(screen.getByTitle('title is controlled by the upstream task source')).toBeInTheDocument();
  });

  it('only offers the pin affordance outside panel and mobile modes', () => {
    const onModeChange = vi.fn();
    const { rerender } = renderWithTooltips(
      <TaskDetailHeader {...headerProps} onModeChange={onModeChange} />,
    );
    expect(screen.queryByRole('button', { name: 'Pin to side panel' })).not.toBeInTheDocument();

    rerender(
      <TooltipProvider>
        <TaskDetailHeader {...headerProps} mode="dialog" onModeChange={onModeChange} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin to side panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use full workspace' }));

    expect(onModeChange).toHaveBeenNthCalledWith(1, 'panel');
    expect(onModeChange).toHaveBeenNthCalledWith(2, 'workspace');
  });
});

const tagsProps = {
  mode: 'panel' as const,
  tags: [{ id: 'tag-1', name: 'urgent', slug: 'urgent', color: null }],
  appliedTagIds: ['tag-1'],
  canEditTags: true,
  showPicker: false,
  pickerTags: [
    { id: 'tag-1', name: 'urgent', slug: 'urgent', color: null },
    { id: 'tag-2', name: 'backend', slug: 'backend', color: '#10b981' },
  ],
  pickerLoading: false,
  tagInput: '',
  connectorCaps: null,
  onOpenPicker: vi.fn(),
  onClosePicker: vi.fn(),
  onTagInputChange: vi.fn(),
  onAddTag: vi.fn(),
  onRemoveTag: vi.fn(),
};

describe('TaskTagsSection', () => {
  it('labels tag removal for assistive technology', () => {
    const onRemoveTag = vi.fn();
    renderWithTooltips(<TaskTagsSection {...tagsProps} onRemoveTag={onRemoveTag} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag urgent' }));

    expect(onRemoveTag).toHaveBeenCalledWith('tag-1');
  });

  it('disables editing affordances and explains why', () => {
    renderWithTooltips(
      <TaskTagsSection {...tagsProps} canEditTags={false} tagsBlockedReason="tags are read-only" />,
    );

    expect(screen.getByRole('button', { name: 'Add tag' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove tag urgent' })).toBeDisabled();
  });

  it('hides already applied tags from the picker', () => {
    renderWithTooltips(<TaskTagsSection {...tagsProps} showPicker />);

    const options = screen.getAllByRole('button', { name: 'backend' });
    expect(options).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'urgent' })).not.toBeInTheDocument();
  });

  it('offers freeform creation and closes on Escape', () => {
    const onAddTag = vi.fn();
    const onClosePicker = vi.fn();
    renderWithTooltips(
      <TaskTagsSection
        {...tagsProps}
        showPicker
        tagInput="new-label"
        onAddTag={onAddTag}
        onClosePicker={onClosePicker}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Create/ }));
    fireEvent.keyDown(screen.getByPlaceholderText('Search or create tag…'), { key: 'Escape' });

    expect(onAddTag).toHaveBeenCalledWith('new-label');
    expect(onClosePicker).toHaveBeenCalledOnce();
  });

  it('does not offer creation for predefined label sources', () => {
    renderWithTooltips(
      <TaskTagsSection
        {...tagsProps}
        showPicker
        tagInput="new-label"
        connectorCaps={{ tagWriteBack: true, tagCreationMode: 'predefined', tagScope: 'global' }}
      />,
    );

    expect(screen.queryByRole('button', { name: /Create/ })).not.toBeInTheDocument();
    expect(screen.getByText('No matching labels')).toBeInTheDocument();
  });

  it('closes the picker when the surrounding surface is clicked', () => {
    const onClosePicker = vi.fn();
    renderWithTooltips(<TaskTagsSection {...tagsProps} showPicker onClosePicker={onClosePicker} />);

    fireEvent.mouseDown(document.body);

    expect(onClosePicker).toHaveBeenCalledOnce();
  });
});

describe('TaskDocumentPreviewSection', () => {
  it('renders nothing without a preview URL', () => {
    const { container } = render(
      <TaskDocumentPreviewSection mode="panel" connectorType="local" metadata={{}} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the structured document layout for document intelligence', () => {
    render(
      <TaskDocumentPreviewSection
        mode="panel"
        connectorType="document-intelligence"
        metadata={{
          previewUrl: 'https://docs.example/1',
          documentTitle: 'Invoice 4711',
          correspondent: 'Acme',
          amount: 42.5,
          urgency: 'high',
          previewType: 'pdf',
          docHubUrl: 'https://owl.example/1',
        }}
        dueDate="2026-08-30"
      />,
    );

    expect(screen.getByText('Invoice 4711')).toBeInTheDocument();
    expect(screen.getByText('$42.50')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByTitle('Preview of Invoice 4711')).toHaveAttribute('src', 'https://docs.example/1');
    expect(screen.getByText('Aug 30, 2026')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in OWL/ })).toHaveAttribute('href', 'https://owl.example/1');

    fireEvent.click(screen.getByRole('button', { name: 'Expand document preview' }));
    expect(screen.getByTestId('expanded-document-preview')).toBeInTheDocument();
  });

  it('renders a generic preview link for other connectors', () => {
    render(
      <TaskDocumentPreviewSection
        mode="panel"
        connectorType="local"
        metadata={{ previewUrl: 'https://files.example/a.pdf', correspondent: 'Acme', amount: 8 }}
      />,
    );

    const link = screen.getByRole('link', { name: 'Open Document' });
    expect(link).toHaveAttribute('href', 'https://files.example/a.pdf');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('$8.00');
  });

  it('does not iframe document-intelligence links marked as external', () => {
    render(
      <TaskDocumentPreviewSection
        mode="panel"
        connectorType="document-intelligence"
        metadata={{
          previewUrl: 'https://docs.example/2',
          previewType: 'external',
          documentTitle: 'External statement',
        }}
      />,
    );

    expect(screen.getByText('This source does not expose an embeddable preview. Open the original document to review it.')).toBeInTheDocument();
    expect(screen.queryByTitle('Preview of External statement')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand document preview' })).not.toBeInTheDocument();
  });
});

const sourceActionProps = {
  mode: 'panel' as const,
  dispositionOptions: [],
  updatingDisposition: false,
  onDispositionChange: vi.fn(),
  sameSourceLists: [],
  currentSourceListId: null,
  supportsMoveToList: false,
  hasWritableConnectors: false,
  onOpenMoveDialog: vi.fn(),
  deepLink: null,
  canDeleteTask: false,
  deleteLabel: 'Delete task',
  onDelete: vi.fn(),
};

describe('TaskSourceActionsSection', () => {
  it('renders nothing when no action is available', () => {
    const { container } = renderWithTooltips(<TaskSourceActionsSection {...sourceActionProps} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers deletion, cross-source moves, and the upstream deep link', () => {
    const onDelete = vi.fn();
    const onOpenMoveDialog = vi.fn();
    renderWithTooltips(
      <TaskSourceActionsSection
        {...sourceActionProps}
        canDeleteTask
        onDelete={onDelete}
        hasWritableConnectors
        onOpenMoveDialog={onOpenMoveDialog}
        deepLink={{ url: 'https://github.com/acme/repo/issues/7', label: 'GitHub', icon: '/icons/connectors/github.svg' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move source' }));

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onOpenMoveDialog).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: /Open in GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/repo/issues/7',
    );
  });

  it('renders linked resources without a known source icon', () => {
    renderWithTooltips(
      <TaskSourceActionsSection
        {...sourceActionProps}
        deepLink={{ url: 'https://example.com/tasks/7', label: 'Partner app' }}
      />,
    );

    expect(screen.getByRole('link', { name: /Open in Partner app/ })).toHaveAttribute(
      'href',
      'https://example.com/tasks/7',
    );
  });

  it('hides deletion on mobile, where the action bar owns it', () => {
    const { container } = renderWithTooltips(
      <TaskSourceActionsSection {...sourceActionProps} mode="mobile" canDeleteTask />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('describes each Mission Control disposition option', () => {
    const onDispositionChange = vi.fn();
    renderWithTooltips(
      <TaskSourceActionsSection
        {...sourceActionProps}
        dispositionOptions={[{ value: 'handled', label: 'Mark handled here', detail: 'Hide it locally.' }]}
        onDispositionChange={onDispositionChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled here. Hide it locally.' }));

    expect(onDispositionChange).toHaveBeenCalledWith('handled');
  });
});

describe('TaskDetailFooter', () => {
  it('shows creation and update dates', () => {
    render(
      <TaskDetailFooter
        mode="panel"
        createdAt="2026-07-01T12:00:00.000Z"
        updatedAt="2026-07-31T12:00:00.000Z"
      />,
    );

    expect(screen.getByText(/^Created /)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });
});

describe('TaskMobileActionBar', () => {
  const mobileProps = {
    isClosed: false,
    canEditStatus: true,
    onComplete: vi.fn(),
    isInMyDay: false,
    updatingMyDay: false,
    onToggleMyDay: vi.fn(),
    canDeleteTask: true,
    deleteLabel: 'Delete task',
    onDelete: vi.fn(),
  };

  it('completes and toggles My Day with touch sized targets', () => {
    const onComplete = vi.fn();
    const onToggleMyDay = vi.fn();
    render(<TaskMobileActionBar {...mobileProps} onComplete={onComplete} onToggleMyDay={onToggleMyDay} />);

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    fireEvent.click(screen.getByRole('button', { name: 'My Day' }));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onToggleMyDay).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Complete' })).toHaveClass('min-h-11');
  });

  it('hides completion for closed tasks and disables the overflow menu without actions', () => {
    render(<TaskMobileActionBar {...mobileProps} isClosed canDeleteTask={false} />);

    expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More task actions' })).toBeDisabled();
  });
});

describe('TaskDuplicatesSection', () => {
  it('summarizes duplicates and caps the preview list at three', () => {
    render(
      <TaskDuplicatesSection
        mode="panel"
        duplicates={[
          { id: '1', title: 'One' },
          { id: '2', title: 'Two' },
          { id: '3', title: 'Three' },
          { id: '4', title: 'Four' },
        ] as never}
        canEditStatus
        onCloseAsDuplicate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('4 potential duplicates detected')).toBeInTheDocument();
    expect(screen.queryByText('Four')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close as dup' })).toHaveLength(3);
  });

  it('hides the close action when status is read-only', () => {
    const onDismiss = vi.fn();
    render(
      <TaskDuplicatesSection
        mode="panel"
        duplicates={[{ id: '1', title: 'One' }] as never}
        canEditStatus={false}
        onCloseAsDuplicate={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Close as dup' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders nothing without duplicates', () => {
    const { container } = render(
      <TaskDuplicatesSection
        mode="panel"
        duplicates={[]}
        canEditStatus
        onCloseAsDuplicate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('section layout ordering', () => {
  it('keeps mode specific placement classes on each section', () => {
    const { container } = renderWithTooltips(<TaskTagsSection {...tagsProps} mode="workspace" />);
    const section = container.querySelector('section')!;

    expect(section.className).toContain('col-start-1');
    expect(section.className).toContain('row-start-4');
    expect(within(section).getByRole('heading', { name: 'Tags' })).toBeInTheDocument();
  });
});
