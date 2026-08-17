import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPush = vi.fn();
const mockFetch = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/',
}));

vi.mock('motion/react', async () => {
  const React = await import('react');

  function createMotionComponent(tag: keyof React.JSX.IntrinsicElements) {
    return React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionComponent(props, ref) {
      const {
        children,
        variants,
        initial,
        animate,
        exit,
        transition,
        layout,
        style,
        ...rest
      } = props;

      return React.createElement(tag, { ref, style, ...rest }, children);
    });
  }

  return {
    motion: {
      div: createMotionComponent('div'),
      section: createMotionComponent('section'),
      button: createMotionComponent('button'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
  };
});

import { MobileSearchScreen } from '@/components/mobile/MobileSearchScreen';

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'task',
    id: 'task-1',
    title: 'Alpha task',
    snippet: 'Task details',
    score: 0.92,
    source: 'hybrid',
    href: '/tasks/task-1',
    metadata: {
      projectName: 'Alpha',
      status: 'Open',
      priority: 'High',
      dueDate: '2030-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function mockSearchApi(results: unknown[] = []) {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('__status_check__')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ semanticAvailable: true, results: [] }),
      });
    }

    if (url.includes('/api/ai/search?')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results, durationMs: 42, note: null }),
      });
    }

    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

describe('MobileSearchScreen', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockFetch.mockReset();
    localStorage.clear();
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders when open and is hidden when closed', () => {
    mockSearchApi();
    const { rerender } = render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search across tasks, triage, and notes/i })).toBeInTheDocument();

    rerender(<MobileSearchScreen isOpen={false} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('auto-focuses the search input on open', async () => {
    mockSearchApi();

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /search across tasks, triage, and notes/i })).toHaveFocus();
    });
  });

  it('shows recent searches from localStorage and suggested searches when there is no query', () => {
    localStorage.setItem('mc:recent-searches', JSON.stringify(['Overdue', 'Planning']));
    mockSearchApi();

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Recent Searches' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Search for Overdue' })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Suggested Searches' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search for High priority tasks' })).toBeInTheDocument();
  });

  it('debounces the search API call', async () => {
    vi.useFakeTimers();
    mockSearchApi();

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} />);

    const input = screen.getByRole('searchbox', { name: /search across tasks, triage, and notes/i });
    fireEvent.change(input, { target: { value: 'alpha' } });

    const hasAlphaRequest = () =>
      mockFetch.mock.calls.some(([url]) => String(url).includes('q=alpha'));

    expect(hasAlphaRequest()).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(hasAlphaRequest()).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(hasAlphaRequest()).toBe(true);
  });

  it('shows keyword results without waiting for semantic route detection', async () => {
    let resolveStatus!: (response: {
      ok: boolean;
      json: () => Promise<{
        semanticEnabled: boolean;
        semanticAvailable: boolean;
        results: never[];
      }>;
    }) => void;
    const statusResponse = new Promise<{
      ok: boolean;
      json: () => Promise<{
        semanticEnabled: boolean;
        semanticAvailable: boolean;
        results: never[];
      }>;
    }>((resolve) => {
      resolveStatus = resolve;
    });
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('__status_check__')) return statusResponse;
      if (url.includes('/api/ai/search?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [makeResult()], durationMs: 42, note: null }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} initialQuery="alpha" />);

    await screen.findByRole('button', { name: /open task alpha task/i });
    const keywordCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('q=alpha'));
    expect(keywordCalls).toHaveLength(1);
    expect(String(keywordCalls[0][0])).toContain('mode=keyword');

    resolveStatus({
      ok: true,
      json: () => Promise.resolve({
        semanticEnabled: true,
        semanticAvailable: true,
        results: [],
      }),
    });

    await waitFor(() => {
      const searchCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('q=alpha'));
      expect(searchCalls).toHaveLength(2);
      expect(String(searchCalls[1][0])).toContain('mode=semantic');
    });
  });

  it('renders filter chips and filters results by type', async () => {
    mockSearchApi([
      makeResult({ id: 'task-1', title: 'Alpha task', href: '/tasks/task-1' }),
      makeResult({
        id: 'notif-1',
        type: 'notification',
        title: 'Inbox alert',
        snippet: 'Triage item',
        href: '/notifications/notif-1',
        metadata: { projectName: 'Ops', severity: 'urgent' },
      }),
      makeResult({
        id: 'note-1',
        type: 'notification',
        title: 'Capture note',
        snippet: 'Meeting note',
        href: '/capture/note-1',
        metadata: { itemType: 'note', projectName: 'Notes', createdAt: '2030-01-02T00:00:00.000Z' },
      }),
    ]);

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} initialQuery="alpha" />);

    await screen.findByRole('button', { name: /open task alpha task/i });
    const typeToolbar = screen.getByRole('toolbar', { name: 'Type filters' });
    expect(typeToolbar).toBeInTheDocument();

    fireEvent.click(within(typeToolbar).getByRole('button', { name: 'Notes' }));

    expect(screen.getByRole('button', { name: /open capture capture note/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open task alpha task/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open triage inbox alert/i })).not.toBeInTheDocument();
  });

  it('highlights matched text in results', async () => {
    mockSearchApi([
      makeResult({
        highlights: {
          title: '<mark>Alpha</mark> task',
          snippet: 'Ship <mark>Alpha</mark> work this week',
        },
      }),
    ]);

    render(<MobileSearchScreen isOpen={true} onClose={vi.fn()} initialQuery="alpha" />);

    await screen.findByRole('button', { name: /open task alpha task/i });

    const marks = Array.from(document.querySelectorAll('mark')).map((node) => node.textContent);
    expect(marks).toContain('Alpha');
    expect(document.querySelectorAll('mark').length).toBeGreaterThanOrEqual(2);
  });

  it('calls onClose when Escape is pressed', () => {
    mockSearchApi();
    const onClose = vi.fn();

    render(<MobileSearchScreen isOpen={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates when a result is tapped', async () => {
    mockSearchApi([makeResult()]);
    const onClose = vi.fn();

    render(<MobileSearchScreen isOpen={true} onClose={onClose} initialQuery="alpha" />);

    fireEvent.click(await screen.findByRole('button', { name: /open task alpha task/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/tasks/task-1');
  });
});
