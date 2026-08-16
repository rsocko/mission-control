import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { IntakeInputStep, type IntakeInputStepProps } from '@/components/projects/document-intake/IntakeInputStep';
import type { ConnectedRepo, ExistingProject } from '@/components/projects/document-intake/types';

// ─── Mock motion/react ──────────────────────────────────────────────────────

type MockDivProps = React.ComponentPropsWithoutRef<'div'>;

const MockMotionDiv = React.forwardRef<HTMLDivElement, MockDivProps>(
  ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>,
);
MockMotionDiv.displayName = 'MockMotionDiv';

vi.mock('motion/react', () => ({
  motion: { div: MockMotionDiv },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// ─── Mock lucide-react ──────────────────────────────────────────────────────

const makeIcon = (name: string) => {
  const Icon = () => <span data-testid={`icon-${name.toLowerCase()}`}>{name}</span>;
  Icon.displayName = name;
  return Icon;
};

vi.mock('lucide-react', () => ({
  AlertTriangle: makeIcon('AlertTriangle'),
  ChevronDown: makeIcon('ChevronDown'),
  Eye: makeIcon('Eye'),
  GitBranch: makeIcon('GitBranch'),
  Layers: makeIcon('Layers'),
  Loader2: makeIcon('Loader2'),
  Plus: makeIcon('Plus'),
  Upload: makeIcon('Upload'),
  X: makeIcon('X'),
}));

const connectedRepos: ConnectedRepo[] = [
  { connectorId: 'c1', connectorName: 'GitHub', repo: 'org/repo-a', displayName: 'org/repo-a' },
  { connectorId: 'c1', connectorName: 'GitHub', repo: 'org/repo-b', displayName: 'org/repo-b' },
];

const existingProjects: ExistingProject[] = [
  { id: 'p1', name: 'Alpha Project', category: 'Ops' },
  { id: 'p2', name: 'Beta Project', category: null },
];

function makeProps(overrides: Partial<IntakeInputStepProps> = {}): IntakeInputStepProps {
  return {
    document: '',
    documentUrl: '',
    onDocumentChange: vi.fn(),
    onDocumentUrlChange: vi.fn(),
    inputMode: 'paste',
    onInputModeChange: vi.fn(),
    repo: '',
    onRepoChange: vi.fn(),
    connectedRepos,
    projectMode: 'new',
    onProjectModeChange: vi.fn(),
    projectName: '',
    onProjectNameChange: vi.fn(),
    existingProjects,
    selectedProjectId: '',
    onSelectedProjectIdChange: vi.fn(),
    category: '',
    onCategoryChange: vi.fn(),
    existingCategories: ['Ops', 'Growth'],
    loading: false,
    error: null,
    onAnalyze: vi.fn(),
    ...overrides,
  };
}

describe('IntakeInputStep', () => {
  it('renders independently with the paste tab active by default', () => {
    render(<IntakeInputStep {...makeProps()} />);
    expect(screen.getByPlaceholderText('Paste your audit findings markdown here...')).toBeInTheDocument();
    expect(screen.getByText('Select a connected repo…')).toBeInTheDocument();
  });

  it('calls onDocumentChange when typing in the paste textarea', () => {
    const onDocumentChange = vi.fn();
    render(<IntakeInputStep {...makeProps({ onDocumentChange })} />);
    fireEvent.change(screen.getByPlaceholderText('Paste your audit findings markdown here...'), {
      target: { value: '# Audit' },
    });
    expect(onDocumentChange).toHaveBeenCalledWith('# Audit');
  });

  it('switches to the URL tab and reports changes via onDocumentUrlChange', () => {
    const onDocumentUrlChange = vi.fn();
    const onInputModeChange = vi.fn();
    const { rerender } = render(
      <IntakeInputStep {...makeProps({ onDocumentUrlChange, onInputModeChange })} />,
    );
    fireEvent.click(screen.getByText('From URL'));
    expect(onInputModeChange).toHaveBeenCalledWith('url');
    rerender(
      <IntakeInputStep {...makeProps({
        inputMode: 'url',
        onDocumentUrlChange,
        onInputModeChange,
      })}
      />,
    );
    const urlInput = screen.getByPlaceholderText('https://raw.githubusercontent.com/owner/repo/main/docs/audit.md');
    fireEvent.change(urlInput, { target: { value: 'https://example.com/doc.md' } });
    expect(onDocumentUrlChange).toHaveBeenCalledWith('https://example.com/doc.md');
  });

  it('restores the URL tab when remounted with an existing URL', () => {
    render(
      <IntakeInputStep
        {...makeProps({ documentUrl: 'https://example.com/doc.md', inputMode: 'url' })}
      />,
    );
    expect(screen.getByDisplayValue('https://example.com/doc.md')).toBeInTheDocument();
  });

  it('restores the selected project name when remounted after Back', () => {
    render(<IntakeInputStep {...makeProps({ projectMode: 'existing', selectedProjectId: 'p1' })} />);
    expect(screen.getByDisplayValue('Alpha Project')).toBeInTheDocument();
  });

  it('opens the repo dropdown and reports the selected repo', () => {
    const onRepoChange = vi.fn();
    render(<IntakeInputStep {...makeProps({ onRepoChange })} />);
    fireEvent.click(screen.getByText('Select a connected repo…'));
    fireEvent.click(screen.getByText('org/repo-b'));
    expect(onRepoChange).toHaveBeenCalledWith('org/repo-b');
  });

  it('switches project mode to existing and selects a project from the dropdown', () => {
    const onProjectModeChange = vi.fn();
    const onSelectedProjectIdChange = vi.fn();
    const { rerender } = render(
      <IntakeInputStep {...makeProps({ onProjectModeChange, onSelectedProjectIdChange })} />,
    );
    fireEvent.click(screen.getByText('Existing'));
    expect(onProjectModeChange).toHaveBeenCalledWith('existing');

    // Simulate the parent applying the mode change (state is hook-owned).
    rerender(
      <IntakeInputStep {...makeProps({
        projectMode: 'existing',
        onProjectModeChange,
        onSelectedProjectIdChange,
      })}
      />,
    );
    fireEvent.focus(screen.getByPlaceholderText('Search existing projects…'));
    fireEvent.click(screen.getByText('Alpha Project'));
    expect(onSelectedProjectIdChange).toHaveBeenCalledWith('p1');
  });

  it('filters category suggestions and reports selection', () => {
    const onCategoryChange = vi.fn();
    render(<IntakeInputStep {...makeProps({ onCategoryChange })} />);
    const categoryInput = screen.getByPlaceholderText('Uncategorized');
    fireEvent.focus(categoryInput);
    fireEvent.click(screen.getByText('Growth'));
    expect(onCategoryChange).toHaveBeenCalledWith('Growth');
  });

  it('disables Analyze when there is no document content, and enables it once there is', () => {
    const { rerender } = render(<IntakeInputStep {...makeProps({ document: '', documentUrl: '' })} />);
    expect(screen.getByText('Analyze Document').closest('button')).toBeDisabled();

    rerender(<IntakeInputStep {...makeProps({ document: 'some content' })} />);
    expect(screen.getByText('Analyze Document').closest('button')).toBeEnabled();
  });

  it('disables Analyze while loading and calls onAnalyze on click', () => {
    const onAnalyze = vi.fn();
    const { rerender } = render(<IntakeInputStep {...makeProps({ document: 'content', onAnalyze })} />);
    fireEvent.click(screen.getByText('Analyze Document'));
    expect(onAnalyze).toHaveBeenCalledOnce();

    rerender(<IntakeInputStep {...makeProps({ document: 'content', loading: true, onAnalyze })} />);
    expect(screen.getByText('Analyze Document').closest('button')).toBeDisabled();
  });

  it('renders the error banner when an error is present', () => {
    render(<IntakeInputStep {...makeProps({ error: 'Something went wrong' })} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });
});
