import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScopeFilter from '@/components/quick-sort/ScopeFilter';
import { CONNECTOR_ICONS } from '@/types/dashboard';

const sources = {
  'github-issues': {
    connectorId: 'github',
    lists: [
      { connectorId: 'github', sourceListId: 'rsocko/mission-control', name: 'rsocko/mission-control', count: 12, type: 'repo', icon: null, iconColor: null },
      { connectorId: 'github', sourceListId: 'rsocko/website', name: 'rsocko/website', count: 4, type: 'repo', icon: 'si:github', iconColor: '#f8fafc' },
    ],
    count: 16,
  },
  'microsoft-todo': {
    connectorId: 'todo',
    lists: [
      { connectorId: 'todo', sourceListId: 'work', name: 'Work', count: 8, type: 'list', icon: 'mdi:briefcase', iconColor: '#60a5fa' },
      { connectorId: 'todo', sourceListId: 'inbox', name: 'Inbox', count: 2, type: 'list', icon: null, iconColor: null },
    ],
    count: 10,
  },
  'custom-rest': {
    connectorId: 'custom',
    lists: [{ connectorId: 'custom', sourceListId: 'pinned', name: 'Pinned', count: 1, type: 'list', icon: 'lucide:star', iconColor: '#fbbf24' }],
    count: 1,
  },
  browser_extension: {
    connectorId: 'browser',
    lists: [],
    count: 1,
  },
  scout: {
    connectorId: 'scout',
    lists: [],
    count: 2,
  },
};

describe('Quick Sort source filter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderFilter(onChange = vi.fn()) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sources }))));
    render(<ScopeFilter filter={{}} onChange={onChange} />);
    return onChange;
  }

  it('uses one searchable dropdown instead of an overflowing source chip row', async () => {
    renderFilter();

    expect(screen.queryByRole('button', { name: 'GitHub Issues' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));

    expect(await screen.findByRole('button', { name: 'GitHub Issues' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search sources and lists' })).toBeInTheDocument();
  });

  it('selects a whole source directly', async () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Microsoft To Do' }));

    expect(onChange).toHaveBeenCalledWith({ source: 'microsoft-todo' });
  });

  it('formats known and custom source identifiers as display labels', async () => {
    renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));

    expect(await screen.findByRole('button', { name: 'Custom REST' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browser Extension' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'browser_extension' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Custom REST' }).querySelector('img[src="/icons/connectors/custom-rest.svg"]'),
    ).toBeInTheDocument();
  });

  it('uses the canonical Copilot icon for Scout', async () => {
    renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));

    const scout = await screen.findByRole('button', { name: 'Microsoft Scout' });
    expect(scout.querySelector('img')).toHaveAttribute('src', CONNECTOR_ICONS.scout);
    expect(CONNECTOR_ICONS.scout).toBe('/icons/connectors/scout.svg');
  });

  it('collapses lists until requested and selects one list as the scope', async () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    await screen.findByRole('button', { name: 'GitHub Issues' });

    expect(screen.queryByRole('button', { name: /rsocko\/mission-control/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand GitHub Issues lists' }));
    const listOption = screen.getByRole('button', { name: /rsocko\/mission-control/ });
    expect(listOption.querySelector('img')).toHaveAttribute(
      'src',
      '/icons/connectors/github.svg',
    );
    expect(listOption).toHaveClass('text-[var(--text-secondary)]');
    expect(listOption).toHaveClass('hover:text-[var(--text-primary)]');
    const count = screen.getByText('12');
    expect(count).toHaveClass('text-[var(--text-muted)]');
    expect(count).toHaveClass('tabular-nums');
    expect(count).not.toHaveClass('opacity-50');
    expect(screen.getByRole('button', { name: /rsocko\/website/ }).querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.simpleicons.org/github/f8fafc',
    );
    fireEvent.click(listOption);

    expect(onChange).toHaveBeenCalledWith({
      source: 'github-issues',
      sourceList: 'rsocko/mission-control',
      sourceListId: 'rsocko/mission-control',
      connectorId: 'github',
    });
  });

  it('renders a Microsoft To Do definition-provided icon and selected styling', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sources }))));
    render(
      <ScopeFilter
        filter={{ source: 'microsoft-todo', sourceList: 'Work' }}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Microsoft To Do \/ Work/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Microsoft To Do lists' }));
    const listOption = screen.getByRole('button', { name: 'Work 8' });

    expect(listOption.querySelector('img')).toHaveAttribute(
      'src',
      'https://api.iconify.design/mdi/briefcase.svg?color=%2360a5fa',
    );
    expect(listOption).toHaveClass('bg-[var(--accent)]/15');
    expect(listOption).toHaveClass('text-[var(--accent)]');
    expect(screen.getByRole('button', { name: 'Inbox 2' }).querySelector('svg')).toBeInTheDocument();
  });

  it('preserves a Mission Control assigned list icon', async () => {
    renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Custom REST lists' }));
    const listOption = screen.getByRole('button', { name: 'Pinned 1' });

    expect(listOption.querySelector('img')).toHaveAttribute(
      'src',
      'https://api.iconify.design/lucide/star.svg?color=%23fbbf24',
    );
  });

  it('searches across collapsed list names', async () => {
    renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    const search = await screen.findByRole('textbox', { name: 'Search sources and lists' });

    fireEvent.change(search, { target: { value: 'website' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /rsocko\/website/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Microsoft To Do' })).not.toBeInTheDocument();
  });
});
