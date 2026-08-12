import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TagReviewPanel } from '@/app/settings/components/TagReviewPanel';
import { TooltipProvider } from '@/components/ui/Tooltip';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

type MotionProps = React.ComponentPropsWithoutRef<'div'> & {
  variants?: unknown;
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
};

function MotionDiv({ variants, initial, animate, exit, ...props }: MotionProps) {
  void variants;
  void initial;
  void exit;
  return <div data-motion-state={typeof animate === 'string' ? animate : undefined} {...props} />;
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <TagReviewPanel />
    </TooltipProvider>,
  );
}

vi.mock('motion/react', () => ({
  motion: { div: MotionDiv },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/settings/components/ConnectorBrandIcon', () => ({
  ConnectorBrandIcon: ({ type }: { type: string }) => <span aria-hidden="true">{type}</span>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const tags = [
  {
    id: 'github-area-triage',
    name: 'Area: Triage',
    slug: 'area-triage',
    type: 'source',
    source: 'github-issues',
    sources: ['github-issues'],
    sourceNames: ['mission-control'],
    color: '#6b7280',
    confirmed: true,
    usageCount: 3,
    unifiedInto: null,
    listUsage: [{ connectorInstanceId: 'github-1', sourceListId: 'org/mission-control', usageCount: 3 }],
    sourceUsage: [{ connectorType: 'github-issues', usageCount: 3 }],
  },
  {
    id: 'todo-area-triage',
    name: 'area:triage',
    slug: 'area-triage',
    type: 'source',
    source: 'microsoft-todo',
    sources: ['microsoft-todo'],
    sourceNames: ['Tasks'],
    color: '#3b82f6',
    confirmed: true,
    usageCount: 2,
    unifiedInto: null,
    listUsage: [{ connectorInstanceId: 'todo-1', sourceListId: 'tasks', usageCount: 2 }],
    sourceUsage: [{ connectorType: 'microsoft-todo', usageCount: 2 }],
  },
];

function stubTagRequests(responseTags: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/tags?includeListUsage=true') {
      return new Response(JSON.stringify({
        tags: responseTags,
        sourceTagSlugs: tags.map(tag => tag.slug),
      }), { status: 200 });
    }
    if (url === '/api/connectors') {
      return new Response(JSON.stringify({ connectors: [], sourceLists: [] }), { status: 200 });
    }
    if (url === '/api/tags/unify') {
      return new Response(JSON.stringify({ success: true, unified: 1, linked: 2 }), { status: 200 });
    }
    if (url === '/api/tags/merge') {
      return new Response(JSON.stringify({ success: true, merged: 1, reassigned: 2 }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}

function stubListScopedTagRequests() {
  const githubTags = [
    {
      ...tags[0],
      id: 'tag-bug',
      name: 'bug',
      slug: 'bug',
      listUsage: [{ connectorInstanceId: 'github-1', sourceListId: 'org/repo-one', usageCount: 2 }],
    },
    {
      ...tags[0],
      id: 'tag-enhancement',
      name: 'enhancement',
      slug: 'enhancement',
      listUsage: [{ connectorInstanceId: 'github-1', sourceListId: 'org/repo-two', usageCount: 4 }],
    },
  ];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/tags?includeListUsage=true') {
      return new Response(JSON.stringify({
        tags: githubTags,
        sourceTagSlugs: githubTags.map(tag => tag.slug),
      }), { status: 200 });
    }
    if (url === '/api/connectors') {
      return new Response(JSON.stringify({
        connectors: [{
          id: 'github-1',
          type: 'github-issues',
          name: 'GitHub',
          capabilities: { tagScope: 'per-list' },
        }],
        sourceLists: [
          { id: 'sl-one', connectorInstanceId: 'github-1', sourceId: 'org/repo-one', name: 'org/repo-one', type: 'repo' },
          { id: 'sl-two', connectorInstanceId: 'github-1', sourceId: 'org/repo-two', name: 'org/repo-two', type: 'repo' },
        ],
      }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
}

describe('TagReviewPanel', () => {
  beforeEach(() => {
    routerPush.mockReset();
    stubTagRequests(tags);
  });

  it('shows suggestion sources and performs a reviewed cross-source unification', async () => {
    renderPanel();

    expect(await screen.findByText('1 potential duplicate found')).toBeInTheDocument();
    expect(screen.getByText('GitHub Issues · mission-control')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Todo · Tasks')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tag list' })).toHaveClass('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: /1 potential duplicate found/ }));
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 potential duplicate found/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('data-motion-state', 'show');
    expect(screen.getByRole('heading', { name: 'Choose the tag to keep' })).toBeInTheDocument();
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    expect(screen.getByText('Merge in Mission Control')).toBeInTheDocument();
    expect(screen.getByText(/duplicate Hub assignments will be detached/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review Outcome' }));
    expect(screen.getByRole('heading', { name: 'Review the outcome' })).toBeInTheDocument();
    expect(screen.getByText('What wins in Mission Control')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Merge Tags' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/tags/unify', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sourceTagIds: ['github-area-triage', 'todo-area-triage'],
          targetTagId: 'github-area-triage',
        }),
      }));
    });
  });

  it('filters per-list tags by connector instance and source list', async () => {
    stubListScopedTagRequests();
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'GitHub Issues 2' }));
    expect(screen.getByRole('button', { name: 'Collapse GitHub Issues lists' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(await screen.findByRole('button', { name: /org\/repo-one/ }));

    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.queryByText('enhancement')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse GitHub Issues lists' }));
    expect(screen.getByRole('button', { name: 'Expand GitHub Issues lists' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTitle('org/repo-one is still filtering tags')).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.queryByText('enhancement')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select bug' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Tasks' }));

    expect(routerPush).toHaveBeenCalledWith(
      '/?tag=bug&listId=github-1%3Aorg%2Frepo-one&source=github-issues',
    );
  });

  it('shows selected-source and all-source task counts and carries filters to the dashboard', async () => {
    stubTagRequests([{
      ...tags[0],
      usageCount: 8,
      sourceUsage: [
        { connectorType: 'github-issues', usageCount: 3 },
        { connectorType: 'microsoft-todo', usageCount: 5 },
      ],
    }]);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /GitHub Issues/ }));

    expect(screen.getByTitle('3 in selected source; 8 across all sources')).toHaveTextContent(/3\s*\(8 all\)/);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Area: Triage' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Tasks' }));

    expect(routerPush).toHaveBeenCalledWith('/?tag=area-triage&source=github-issues');
  });

  it('makes available tag actions discoverable', async () => {
    renderPanel();

    expect(await screen.findByText('Actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View tasks tagged Area: Triage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Area: Triage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recolor Area: Triage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Area: Triage' })).toBeInTheDocument();
    expect(screen.getByText(/select tags to merge, rename, recolor, remove, or view their tasks/i)).toBeInTheDocument();
  });

  it('opens the same review dialog from a row and names the duplicate counterpart', async () => {
    renderPanel();

    const rowReview = await screen.findByRole('button', { name: 'Merge with area:triage' });
    expect(rowReview).toHaveTextContent('Merge with area:triage');

    fireEvent.click(rowReview);

    expect(screen.getByRole('heading', { name: 'Choose the tag to keep' })).toBeInTheDocument();
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });

  it('preserves unrelated bulk selection after applying a suggestion', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Area: Triage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Outcome' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge Tags' }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select Area: Triage' })).toBeChecked();
    });
  });

  it('explains that source-backed tags merge without changing source labels', async () => {
    stubTagRequests(tags.map(tag => ({
      ...tag,
      source: 'github-issues',
      sources: ['github-issues'],
    })));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Merge with area:triage' }));

    expect(screen.getByRole('heading', { name: 'Choose the tag to keep' })).toBeInTheDocument();
    expect(screen.getByText(/duplicate Hub assignments will be detached/)).toBeInTheDocument();
  });

  it('deletes duplicate records when merging local tags', async () => {
    stubTagRequests(tags.map((tag, index) => ({
      ...tag,
      id: `hub-${index}`,
      type: 'hub',
      source: null,
      sources: [],
      sourceNames: [],
    })));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));

    expect(screen.getByText(/other local tag records will be deleted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review Outcome' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge Tags' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/tags/merge', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('disables an unused source tag as the winner over a local tag', async () => {
    stubTagRequests([
      { ...tags[0], type: 'hub', source: null, sources: [], sourceNames: [], usageCount: 2 },
      { ...tags[1], usageCount: 0 },
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));

    expect(screen.getByRole('button', { name: /^area:triage Microsoft Todo/ })).toBeDisabled();
    expect(screen.getByText(/Cannot keep this source tag/)).toBeInTheDocument();
  });

  it('allows an unused source winner when another selected source provides scope', async () => {
    stubTagRequests([
      { ...tags[0], type: 'hub', source: null, sources: [], sourceNames: [], usageCount: 2 },
      { ...tags[1], usageCount: 0 },
      {
        ...tags[1],
        id: 'github-area-triage-secondary',
        name: 'AREA TRIAGE',
        source: 'github-issues',
        sources: ['github-issues'],
        sourceNames: ['mission-control'],
        usageCount: 3,
      },
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Area: Triage' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select area:triage' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select AREA TRIAGE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Merge' }));

    expect(screen.getByRole('button', { name: /^area:triage Microsoft Todo/ })).toBeEnabled();
  });

  it('does not suggest tags that have already been unified', async () => {
    stubTagRequests(tags.map((tag, index) => ({
      ...tag,
      unifiedInto: index === 1 ? tags[0].id : null,
    })));
    renderPanel();

    await screen.findByRole('region', { name: 'Tag list' });

    expect(screen.queryByText(/potential duplicate/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Merge with/ })).not.toBeInTheDocument();
  });

  it('recommends a hub tag as the Mission Control winner and previews source outcomes', async () => {
    stubTagRequests([
      { ...tags[0], type: 'hub', source: null, sources: [], sourceNames: [], usageCount: 1 },
      { ...tags[1], source: 'github-issues', sources: ['github-issues'], sourceNames: ['mission-control'], usageCount: 20 },
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: /Area: Triage Recommended/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Review Outcome' }));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Area: Triage is kept as the winning Mission Control tag.',
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'area:triage remains unchanged in GitHub Issues · mission-control',
    );
  });

  it('previews detaching only the selected source when it wins over a shared hub tag', async () => {
    stubTagRequests([
      { ...tags[0], type: 'hub', source: null, sources: [], sourceNames: [], usageCount: 1 },
      { ...tags[1], source: 'github-issues', sources: ['github-issues'], sourceNames: ['mission-control'], usageCount: 20 },
    ]);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: /^area:triage GitHub Issues/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Outcome' }));

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Area: Triage is detached only from tasks using the selected source tags and remains unchanged elsewhere.',
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'area:triage remains unchanged in GitHub Issues · mission-control and becomes the winning tag in Mission Control.',
    );
  });
});
