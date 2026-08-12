/**
 * Component Tests – PrioritySetupWizard & PriorityWizardGate
 * Tests #143 (Priority Setup Wizard first-launch onboarding)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Mock motion/react ──────────────────────────────────────────────────────

type MockDivProps = React.ComponentPropsWithoutRef<'div'>;

const MockMotionDiv = React.forwardRef<HTMLDivElement, MockDivProps>(
  ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>,
);
MockMotionDiv.displayName = 'MockMotionDiv';

function MockAnimatePresence({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

vi.mock('motion/react', () => ({
  motion: { div: MockMotionDiv },
  AnimatePresence: MockAnimatePresence,
  useReducedMotion: () => false,
}));

// ─── Mock lucide-react ──────────────────────────────────────────────────────

const makeIcon = (name: string) => {
  const Icon = () => <span data-testid={`icon-${name.toLowerCase()}`}>{name}</span>;
  Icon.displayName = name;
  return Icon;
};

vi.mock('lucide-react', () => ({
  // PrioritySetupWizard icons
  Star: makeIcon('Star'),
  ArrowRight: makeIcon('ArrowRight'),
  ArrowLeft: makeIcon('ArrowLeft'),
  Check: makeIcon('Check'),
  GripVertical: makeIcon('GripVertical'),
  GitBranch: makeIcon('GitBranch'),
  CheckSquare: makeIcon('CheckSquare'),
  Calendar: makeIcon('Calendar'),
  Mail: makeIcon('Mail'),
  X: makeIcon('X'),
  Sparkles: makeIcon('Sparkles'),
  // PriorityEntitiesPanel icons
  Plus: makeIcon('Plus'),
  User: makeIcon('User'),
  Users: makeIcon('Users'),
  Globe: makeIcon('Globe'),
  ChartNetwork: makeIcon('ChartNetwork'),
  Trash2: makeIcon('Trash2'),
  Tag: makeIcon('Tag'),
  ListTree: makeIcon('ListTree'),
  ChevronDown: makeIcon('ChevronDown'),
  ChevronUp: makeIcon('ChevronUp'),
}));

// ─── Mock @dnd-kit ──────────────────────────────────────────────────────────

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock('@dnd-kit/sortable', () => ({
  arrayMove: vi.fn((arr: unknown[], from: number, to: number) => {
    const copy = [...arr];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  }),
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}));

// ─── Mock sonner ────────────────────────────────────────────────────────────

const mockToast = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', () => ({ toast: mockToast }));

// ─── Mock @/lib/smart-score (used by PriorityEntitiesPanel via index re-export) ─

vi.mock('@/lib/smart-score', () => ({
  computeSmartScore: vi.fn(() => ({ score: 50, breakdown: {} })),
  computeBatchSmartScores: vi.fn(() => []),
  getScoreTier: vi.fn(() => 'mid'),
  DEFAULT_SCORE_WEIGHTS: {},
}));

// ─── Global fetch mock ──────────────────────────────────────────────────────

const entityOptions = {
  projects: [{ id: 'project-1', name: 'My Project', description: 'Launch work', color: '#a78bfa' }],
  tags: [{ id: 'tag-1', name: 'Customer', color: '#10b981' }],
  sources: [{ id: 'work:list-1', name: 'Leadership', description: 'Work', color: '#60a5fa' }],
};
const successfulFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  void init;
  return Promise.resolve(new Response(JSON.stringify(
    String(input).includes('/api/priority-entities/options') ? entityOptions : { entities: [] },
  ), { status: 200 }));
};
const fetchMock = vi.fn(successfulFetch);
vi.stubGlobal('fetch', fetchMock);

// ─── Tests: PrioritySetupWizard ─────────────────────────────────────────────

describe('PrioritySetupWizard', () => {
  let PrioritySetupWizard: React.ComponentType<{ onComplete: () => void; onDismiss: () => void }>;
  const onComplete = vi.fn();
  const onDismiss = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(successfulFetch);
    const mod = await import('@/components/smart-score/PrioritySetupWizard');
    PrioritySetupWizard = mod.PrioritySetupWizard;
  });

  it('renders step 1 (Sources) by default', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    expect(screen.getByText('What matters most?')).toBeDefined();
    expect(screen.getByText('GitHub Issues')).toBeDefined();
    expect(screen.getByText('Microsoft Todo')).toBeDefined();
  });

  it('shows first-launch setup badge', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    expect(screen.getByText('First-launch setup')).toBeDefined();
  });

  it('renders as a named modal with an accessible dismiss control', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);

    expect(screen.getByRole('dialog', { name: 'Priority Entities' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dismiss priority setup' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Step 1: Systems' })).toHaveAttribute('aria-current', 'step');
  });

  it('navigates forward through all steps', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);

    // Step 1 → 2
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Rank your active projects')).toBeDefined();

    // Step 2 → 3
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Priority tags and sources')).toBeDefined();

    // Step 3 → 4
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Key people')).toBeDefined();

    // Step 4 → 5
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Review your setup')).toBeDefined();
  });

  it('navigates backward with Back button', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);

    // Go to step 2
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Rank your active projects')).toBeDefined();

    // Back to step 1
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('What matters most?')).toBeDefined();
  });

  it('calls onDismiss when Skip is clicked', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Skip for now'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when X button is clicked', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    const closeBtn = screen.getByTestId('icon-x').closest('button')!;
    fireEvent.click(closeBtn!);

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when Escape is pressed', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('allows adding a project in step 2', async () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Next')); // go to Projects

    const picker = screen.getByRole('combobox', { name: 'Select project' });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: 'My Project' }));
    fireEvent.click(screen.getByText('Add'));

    expect(screen.getByText('My Project')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Select project' })).toHaveTextContent('Select a project...');
  });

  it('allows adding tags and sources in step 3', async () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));

    fireEvent.click(screen.getByRole('combobox', { name: 'Select tag' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Customer' }));
    fireEvent.click(screen.getByText('Add'));
    expect(screen.getByText('Customer')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Select tag' })).toHaveTextContent('Select tag...');

    fireEvent.click(screen.getByRole('combobox', { name: 'Priority entity type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Source' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Select source' }));
    fireEvent.click(screen.getByRole('option', { name: 'Leadership' }));
    fireEvent.click(screen.getByText('Add'));
    expect(screen.getByText('Leadership')).toBeDefined();
  });

  it('allows adding a person in step 4', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Next')); // step 2
    fireEvent.click(screen.getByText('Next')); // step 3
    fireEvent.click(screen.getByText('Next')); // step 4

    const nameInput = screen.getByPlaceholderText('Person name...');
    fireEvent.change(nameInput, { target: { value: 'Alice' } });
    fireEvent.click(screen.getByText('Add person'));

    expect(screen.getByText('Alice')).toBeDefined();
  });

  it('shows review summary on step 4', () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    // Navigate to review
    fireEvent.click(screen.getByText('Next')); // step 2
    fireEvent.click(screen.getByText('Next')); // step 3
    fireEvent.click(screen.getByText('Next')); // step 4
    fireEvent.click(screen.getByText('Next')); // step 5

    expect(screen.getByText('Review your setup')).toBeDefined();
    expect(screen.getByText('Source Rankings')).toBeDefined();
  });

  it('shows Launch scoring button on step 5 and submits', async () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);

    // Navigate to step 5
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));

    fireEvent.click(screen.getByText('Launch scoring'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('shows toast on save failure', async () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('network')));
    fireEvent.click(screen.getByText('Launch scoring'));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Failed to save setup');
    });
  });

  it('does not complete when the API rejects a save', async () => {
    render(<PrioritySetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })),
    );
    fireEvent.click(screen.getByText('Launch scoring'));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Failed to save setup'));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// ─── Tests: PriorityEntitiesPanel ────────────────────────────────────────────

describe('PriorityEntitiesPanel', () => {
  let PriorityEntitiesPanel: React.ComponentType;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(successfulFetch);
    const mod = await import('@/components/smart-score/PriorityEntitiesPanel');
    PriorityEntitiesPanel = mod.PriorityEntitiesPanel;
  });

  it('only offers supported entity types for new entries', async () => {
    render(<PriorityEntitiesPanel />);

    await waitFor(() => {
      expect(screen.getAllByText('Add entity').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText('Add entity')[0]);

    const typePicker = screen.getByRole('combobox', { name: 'Entity type' });
    fireEvent.click(typePicker);
    expect(screen.getByRole('option', { name: 'Person' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Project' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Tag' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Source' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Domain' })).toBeNull();
  });

  it('creates a project using its canonical reference', async () => {
    render(<PriorityEntitiesPanel />);

    await waitFor(() => expect(screen.getAllByText('Add entity').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Add entity')[0]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Entity type' }));
    fireEvent.click(screen.getByRole('option', { name: 'Project' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Select project' }));
    fireEvent.click(screen.getByRole('option', { name: 'My Project' }));
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        name: 'My Project',
        type: 'project',
        referenceId: 'project-1',
      });
    });
  });

  it('continues to display legacy entity types', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({
        entities: [{
          id: 'legacy-domain',
          name: 'Family',
          type: 'domain',
          description: 'Legacy area',
          tier: 'high',
          color: '#f59e0b',
          rank: 1,
          activeTaskCount: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }), { status: 200 })),
    );

    render(<PriorityEntitiesPanel />);

    expect(await screen.findByText('Family')).toBeDefined();
    expect(screen.getByText('domain')).toBeDefined();
  });
});

// ─── Tests: PriorityWizardGate ──────────────────────────────────────────────

describe('PriorityWizardGate', () => {
  let PriorityWizardGate: React.ComponentType;

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    const mod = await import('@/components/smart-score/PriorityWizardGate');
    PriorityWizardGate = mod.PriorityWizardGate;
  });

  it('shows wizard when no entities exist and not dismissed', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ entities: [] }), { status: 200 })),
    );

    render(<PriorityWizardGate />);

    await waitFor(() => {
      expect(screen.getByText('Priority Entities')).toBeDefined();
    });
  });

  it('does not show wizard when entities already exist', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ entities: [{ id: '1' }] }), { status: 200 })),
    );

    render(<PriorityWizardGate />);

    // Give the effect time to run, then check wizard is absent
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByText('Priority Entities')).toBeNull();
  });

  it('does not show wizard when previously dismissed', async () => {
    localStorage.setItem('mc_priority_wizard_dismissed', 'true');

    render(<PriorityWizardGate />);

    // fetch should never be called when dismissed
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Priority Entities')).toBeNull();
  });

  it('sets localStorage when wizard is dismissed', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ entities: [] }), { status: 200 })),
    );

    render(<PriorityWizardGate />);

    await waitFor(() => {
      expect(screen.getByText('Priority Entities')).toBeDefined();
    });

    // Dismiss via Skip
    fireEvent.click(screen.getByText('Skip for now'));

    expect(localStorage.getItem('mc_priority_wizard_dismissed')).toBe('true');
  });
});
