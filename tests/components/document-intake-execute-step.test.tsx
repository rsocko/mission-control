import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { IntakeExecuteStep } from '@/components/projects/document-intake/IntakeExecuteStep';
import type { ExecuteResult } from '@/components/projects/document-intake/types';

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
    CheckCircle2: makeIcon('CheckCircle2'),
    ExternalLink: makeIcon('ExternalLink'),
    Loader2: makeIcon('Loader2'),
  };
});

function makeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    dryRun: false,
    projectId: 'project-1',
    phases: [{ name: 'Phase 1', id: 'ph1', findingIds: ['F1'], sortOrder: 0 }],
    issues: [
      { findingId: 'F1', title: 'Missing rate limit', issueNumber: 42, htmlUrl: 'https://github.com/org/repo/issues/42' },
      { findingId: 'F2', title: 'No index', issueNumber: null, htmlUrl: null },
    ],
    assignments: [
      { findingId: 'F1', issueNumber: 42, taskId: 't1', phaseName: 'Phase 1', status: 'assigned' },
      { findingId: 'F2', issueNumber: null, taskId: null, phaseName: null, status: 'missing-task' },
    ],
    tags: ['security'],
    errors: [],
    ...overrides,
  };
}

describe('IntakeExecuteStep', () => {
  it('renders the executing spinner independently of a result', () => {
    render(<IntakeExecuteStep phase="executing" result={null} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Creating tasks, project, and phases...')).toBeInTheDocument();
  });

  it('renders nothing for the done phase when result is null', () => {
    const { container } = render(<IntakeExecuteStep phase="done" result={null} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the done summary, findings table, and project link', () => {
    render(<IntakeExecuteStep phase="done" result={makeResult()} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Intake Complete')).toBeInTheDocument();
    expect(screen.getByText('F1')).toBeInTheDocument();
    expect(screen.getByText('F2')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('assigned')).toBeInTheDocument();
    expect(screen.getByText('missing-task')).toBeInTheDocument();
    const projectLink = screen.getByText('View Project').closest('a');
    expect(projectLink).toHaveAttribute('href', '/projects/project-1');
  });

  it('renders warnings when errors are present', () => {
    render(<IntakeExecuteStep phase="done" result={makeResult({ errors: ['Rate limited on issue #5'] })} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/1 Warning/)).toBeInTheDocument();
    expect(screen.getByText('• Rate limited on issue #5')).toBeInTheDocument();
  });

  it('does not render a project link or View Project action without a projectId', () => {
    render(<IntakeExecuteStep phase="done" result={makeResult({ projectId: null })} onReset={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('View Project')).not.toBeInTheDocument();
  });

  it('calls onReset when Start New Intake is clicked', () => {
    const onReset = vi.fn();
    render(<IntakeExecuteStep phase="done" result={makeResult()} onReset={onReset} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Start New Intake'));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('calls onClose when View Project is clicked', () => {
    const onClose = vi.fn();
    render(<IntakeExecuteStep phase="done" result={makeResult()} onReset={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('View Project'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
