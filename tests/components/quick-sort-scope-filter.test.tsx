import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScopeFilter from '@/components/quick-sort/ScopeFilter';

const sources = {
  'github-issues': {
    connectorId: 'github',
    lists: [
      { name: 'rsocko/mission-control', count: 12 },
      { name: 'rsocko/website', count: 4 },
    ],
  },
  'microsoft-todo': {
    connectorId: 'todo',
    lists: [{ name: 'Work', count: 8 }],
  },
  'custom-rest': {
    connectorId: 'custom',
    lists: [],
  },
  browser_extension: {
    connectorId: 'browser',
    lists: [],
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

  it('collapses lists until requested and selects one list as the scope', async () => {
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
    await screen.findByRole('button', { name: 'GitHub Issues' });

    expect(screen.queryByRole('button', { name: /rsocko\/mission-control/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand GitHub Issues lists' }));
    const listOption = screen.getByRole('button', { name: /rsocko\/mission-control/ });
    expect(listOption.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(listOption);

    expect(onChange).toHaveBeenCalledWith({
      source: 'github-issues',
      sourceList: 'rsocko/mission-control',
    });
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
