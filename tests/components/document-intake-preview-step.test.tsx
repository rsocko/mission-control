import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { IntakePreviewStep, type IntakePreviewStepProps } from '@/components/projects/document-intake/IntakePreviewStep';
import type { PreviewData } from '@/components/projects/document-intake/types';

// ─── Mock motion/react ──────────────────────────────────────────────────────

vi.mock('motion/react', async () => {
  const React = await import('react');
  const MockMotionDiv = React.forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(
    ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>,
  );
  MockMotionDiv.displayName = 'MockMotionDiv';
  return {
    motion: { div: MockMotionDiv },
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

// ─── Mock lucide-react ──────────────────────────────────────────────────────

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = () => <span data-testid={`icon-${name.toLowerCase()}`}>{name}</span>;
    Icon.displayName = name;
    return Icon;
  };
  return {
    AlertTriangle: makeIcon('AlertTriangle'),
    ChartNetwork: makeIcon('ChartNetwork'),
    ChevronDown: makeIcon('ChevronDown'),
    ChevronRight: makeIcon('ChevronRight'),
    Code: makeIcon('Code'),
    Eye: makeIcon('Eye'),
    FileText: makeIcon('FileText'),
    GitBranch: makeIcon('GitBranch'),
    Layers: makeIcon('Layers'),
    Loader2: makeIcon('Loader2'),
    Pencil: makeIcon('Pencil'),
    Play: makeIcon('Play'),
    Plus: makeIcon('Plus'),
    RotateCcw: makeIcon('RotateCcw'),
    Tag: makeIcon('Tag'),
    X: makeIcon('X'),
  };
});

function makePreview(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    document: {
      title: 'Audit',
      findings: [
        { id: 'F1', area: 'Auth', issue: 'Missing rate limit', impact: 'High', suggestedFix: 'Add limiter', effort: 'M', priorityOrder: 1, priorityLabel: 'P1' },
        { id: 'F2', area: 'DB', issue: 'No index', impact: 'Medium', suggestedFix: 'Add index', effort: 'S', priorityOrder: 2, priorityLabel: 'P2' },
      ],
      phases: [],
      priorityGroups: [{ order: 1, title: 'P1', label: 'Critical', findingIds: ['F1'] }],
    },
    proposedProjectName: 'Security Audit',
    proposedPhases: [
      { name: 'Phase 1', description: 'First phase', estimatedDays: 3, sortOrder: 0, findingIds: ['F1', 'F2'] },
    ],
    proposedIssueCount: 2,
    proposedTags: ['security'],
    ...overrides,
  };
}

function makeProps(overrides: Partial<IntakePreviewStepProps> = {}): IntakePreviewStepProps {
  return {
    preview: makePreview(),
    document: '# Audit\n\nSome content',
    documentUrl: '',
    reprocessing: false,
    onReprocess: vi.fn(async () => true),
    selectedFindingIds: new Set(['F1', 'F2']),
    onToggleFinding: vi.fn(),
    editableTags: ['security'],
    onEditableTagsChange: vi.fn(),
    error: null,
    repo: 'org/repo',
    projectMode: 'new',
    selectedProjectId: '',
    onBack: vi.fn(),
    onExecute: vi.fn(),
    ...overrides,
  };
}

describe('IntakePreviewStep', () => {
  it('renders the analysis view by default with summary cards, phases, and findings', () => {
    render(<IntakePreviewStep {...makeProps()} />);
    expect(screen.getByText('Security Audit')).toBeInTheDocument();
    expect(screen.getByText('Phase 1')).toBeInTheDocument();
    expect(screen.getByText('Missing rate limit')).toBeInTheDocument();
    expect(screen.getByText(/2 included/)).toBeInTheDocument();
  });

  it('toggles a finding via its include checkbox', () => {
    const onToggleFinding = vi.fn();
    render(<IntakePreviewStep {...makeProps({ onToggleFinding })} />);
    fireEvent.click(screen.getByLabelText('Include finding F1'));
    expect(onToggleFinding).toHaveBeenCalledWith('F1', false);
  });

  it('expands a phase to reveal its finding details', () => {
    render(<IntakePreviewStep {...makeProps()} />);
    // The per-finding effort/area badges only render once a phase row is expanded.
    expect(screen.queryByText('Effort M')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Phase 1'));
    expect(screen.getByText('Effort M')).toBeInTheDocument();
  });

  it('adds a tag via the Add button and removes it via its remove control', () => {
    const onEditableTagsChange = vi.fn();
    render(<IntakePreviewStep {...makeProps({ onEditableTagsChange, editableTags: ['security'] })} />);

    fireEvent.change(screen.getByPlaceholderText('Add tag and press Enter'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByText('Add'));
    expect(onEditableTagsChange).toHaveBeenCalledWith(expect.any(Function));
    expect(onEditableTagsChange.mock.calls[0][0](['security'])).toEqual(['security', 'p1']);

    fireEvent.click(screen.getByLabelText('Remove tag security'));
    expect(onEditableTagsChange).toHaveBeenLastCalledWith(expect.any(Function));
    expect(onEditableTagsChange.mock.calls[1][0](['security'])).toEqual([]);
  });

  it('adds a tag by pressing Enter in the tag input', () => {
    const onEditableTagsChange = vi.fn();
    render(<IntakePreviewStep {...makeProps({ onEditableTagsChange })} />);
    const input = screen.getByPlaceholderText('Add tag and press Enter');
    fireEvent.change(input, { target: { value: 'urgent' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onEditableTagsChange.mock.calls[0][0](['security'])).toEqual(['security', 'urgent']);
  });

  it('switches to the source/raw tab and shows the raw document text', () => {
    render(<IntakePreviewStep {...makeProps()} />);
    fireEvent.click(screen.getByText('View Source Document'));
    fireEvent.click(screen.getByText('Raw'));
    expect(screen.getByText('# Audit', { exact: false })).toBeInTheDocument();
  });

  it('reprocesses successfully: resets to the rendered view and clears the buffer', async () => {
    const onReprocess = vi.fn(async () => true);
    render(<IntakePreviewStep {...makeProps({ onReprocess })} />);
    fireEvent.click(screen.getByText('View Source Document'));
    fireEvent.click(screen.getByText('Edit'));

    const textarea = screen.getByPlaceholderText('Edit document content...');
    fireEvent.change(textarea, { target: { value: 'Edited content' } });
    await fireEventClickAsync(screen.getByText('Reprocess'));

    expect(onReprocess).toHaveBeenCalledWith('Edited content');
    // Back on the rendered sub-view: the "Edit" toggle label should read "Edit" again, not "Editing".
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('keeps the edit buffer open when reprocessing fails', async () => {
    const onReprocess = vi.fn(async () => false);
    render(<IntakePreviewStep {...makeProps({ onReprocess })} />);
    fireEvent.click(screen.getByText('View Source Document'));
    fireEvent.click(screen.getByText('Edit'));

    const textarea = screen.getByPlaceholderText('Edit document content...');
    fireEvent.change(textarea, { target: { value: 'Broken edit' } });
    await fireEventClickAsync(screen.getByText('Reprocess'));

    expect(onReprocess).toHaveBeenCalledWith('Broken edit');
    expect(screen.getByText('Editing')).toBeInTheDocument();
  });

  it('disables Execute without a repo, with no findings selected, or with existing-mode and no project chosen', () => {
    const { rerender } = render(<IntakePreviewStep {...makeProps({ repo: '' })} />);
    expect(screen.getByText(/Execute —/).closest('button')).toBeDisabled();
    expect(screen.getByText('Select a target repo above to execute')).toBeInTheDocument();

    rerender(<IntakePreviewStep {...makeProps({ selectedFindingIds: new Set() })} />);
    expect(screen.getByText(/Execute —/).closest('button')).toBeDisabled();
    expect(screen.getByText('Select at least one finding to execute')).toBeInTheDocument();

    rerender(<IntakePreviewStep {...makeProps({ projectMode: 'existing', selectedProjectId: '' })} />);
    expect(screen.getByText(/Execute —/).closest('button')).toBeDisabled();
    expect(screen.getByText('Select an existing project above to execute')).toBeInTheDocument();

    rerender(<IntakePreviewStep {...makeProps({ projectMode: 'existing', selectedProjectId: 'p1' })} />);
    expect(screen.getByText(/Execute —/).closest('button')).toBeEnabled();
  });

  it('calls onBack and onExecute from the sticky action bar', () => {
    const onBack = vi.fn();
    const onExecute = vi.fn();
    render(<IntakePreviewStep {...makeProps({ onBack, onExecute })} />);
    fireEvent.click(screen.getByText('← Back'));
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText(/Execute —/));
    expect(onExecute).toHaveBeenCalledOnce();
  });

  it('renders the error banner when an error is present', () => {
    render(<IntakePreviewStep {...makeProps({ error: 'Execution failed' })} />);
    expect(screen.getByText('Execution failed')).toBeInTheDocument();
  });
});

/** fireEvent.click a button whose onClick is async, then flush microtasks inside act(). */
async function fireEventClickAsync(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}
