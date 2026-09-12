import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');
  type MotionTestProps = {
    children?: React.ReactNode;
    [key: string]: unknown;
  };

  function createMotionComponent(tag: keyof React.JSX.IntrinsicElements) {
    return ReactModule.forwardRef<HTMLElement, MotionTestProps>(function MotionComponent(props, ref) {
      const { children } = props;
      const rest = Object.fromEntries(
        Object.entries(props).filter(([key]) =>
          !['children', 'variants', 'initial', 'animate', 'exit', 'transition', 'layout'].includes(key)),
      );

      return ReactModule.createElement(tag, { ref, ...rest }, children as React.ReactNode);
    });
  }

  return {
    motion: {
      button: createMotionComponent('button'),
      div: createMotionComponent('div'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <aside aria-label={`Task preview ${taskId}`}>
      <button type="button" onClick={onClose}>Close preview</button>
    </aside>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/client-logger', () => ({
  taskLogger: { error: vi.fn() },
}));

import { SearchCommand } from '@/components/search/SearchCommand';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function result(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'task',
    id,
    title,
    snippet: `${title} details`,
    score: 1,
    source: 'fts',
    href: `/tasks/${id}`,
    metadata: { status: 'Open', sourceListName: 'Work' },
    ...overrides,
  };
}

function openSearch() {
  fireEvent.click(screen.getByRole('button', { name: /search ctrl k/i }));
  return screen.getByRole('textbox', { name: 'Search tasks and notifications' });
}

function projectResponse() {
  return jsonResponse({ projects: [] });
}

describe('SearchCommand', () => {
  beforeEach(() => {
    navigation.push.mockReset();
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders keyword results before semantic capability detection completes', async () => {
    const status = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) return status.promise;
      if (url.includes('mode=keyword')) {
        return Promise.resolve(jsonResponse({
          results: [result('exact', 'Alpha exact')],
          durationMs: 12,
        }));
      }
      if (url.includes('mode=semantic')) return Promise.resolve(jsonResponse({ results: [] }));
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    fireEvent.change(openSearch(), { target: { value: 'alpha' } });

    expect(await screen.findByText('Alpha exact')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('mode=semantic'))).toBe(false);

    status.resolve(jsonResponse({
      semanticEnabled: true,
      semanticAvailable: true,
      results: [],
    }));

    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('mode=semantic'))).toBe(true);
    });
  });

  it('appends semantic results without disturbing keyword order, selection, or preview', async () => {
    const semantic = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) {
        return Promise.resolve(jsonResponse({
          semanticEnabled: true,
          semanticAvailable: true,
          results: [],
        }));
      }
      if (url.includes('mode=keyword')) {
        return Promise.resolve(jsonResponse({
          results: [
            result('exact', 'Alpha'),
            result('second', 'Alpha follow-up'),
          ],
          durationMs: 8,
        }));
      }
      if (url.includes('mode=semantic')) return semantic.promise;
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'alpha' } });
    await screen.findByText('Alpha follow-up');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Task preview exact' })).toBeInTheDocument();

    semantic.resolve(jsonResponse({
      results: [
        result('related', 'Related planning', {
          source: 'semantic',
          metadata: { status: 'Open', sourceListName: 'Work' },
        }),
      ],
      durationMs: 30,
    }));

    await screen.findByText('Related planning');
    expect(
      Array.from(document.querySelectorAll('[data-search-item]')).map((item) =>
        item.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Alpha follow-up'),
      expect.stringContaining('Related planning'),
    ]);
    expect(screen.getByRole('complementary', { name: 'Task preview exact' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Task preview exact' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('prevents stale responses from replacing the latest query', async () => {
    const alpha = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) {
        return Promise.resolve(jsonResponse({
          semanticEnabled: false,
          semanticAvailable: false,
          results: [],
        }));
      }
      if (url.includes('q=alpha')) return alpha.promise;
      if (url.includes('q=beta')) {
        return Promise.resolve(jsonResponse({
          results: [result('beta', 'Beta latest')],
          durationMs: 4,
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('q=alpha'),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.change(input, { target: { value: 'beta' } });
    expect(await screen.findByText('Beta latest')).toBeInTheDocument();

    await act(async () => {
      alpha.resolve(jsonResponse({
        results: [result('alpha', 'Alpha stale')],
        durationMs: 40,
      }));
    });

    expect(screen.queryByText('Alpha stale')).not.toBeInTheDocument();
    expect(screen.getByText('Beta latest')).toBeInTheDocument();
  });

  it('keeps keyword results usable when semantic enrichment fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) {
        return Promise.resolve(jsonResponse({
          semanticEnabled: true,
          semanticAvailable: true,
          results: [],
        }));
      }
      if (url.includes('mode=keyword')) {
        return Promise.resolve(jsonResponse({
          results: [result('exact', 'Keyword survives')],
          durationMs: 6,
        }));
      }
      if (url.includes('mode=semantic')) {
        return Promise.resolve(new Response('Semantic unavailable', { status: 503 }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'survives' } });

    expect(await screen.findByText('Keyword survives')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Finding related…')).not.toBeInTheDocument());

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Task preview exact' })).toBeInTheDocument();
  });

  it('sends filter changes to the server and presents the filtered response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) {
        return Promise.resolve(jsonResponse({
          semanticEnabled: false,
          semanticAvailable: false,
          results: [],
        }));
      }
      if (url.includes('type=tasks')) {
        return Promise.resolve(jsonResponse({
          results: [result('task', 'Task only')],
          durationMs: 5,
        }));
      }
      if (url.includes('mode=keyword')) {
        return Promise.resolve(jsonResponse({
          results: [
            result('task', 'Task only'),
            result('notification', 'Notification result', {
              type: 'notification',
              href: '/notifications/notification',
              metadata: { category: 'Unread', connectorType: 'Teams' },
            }),
          ],
          durationMs: 5,
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    fireEvent.change(openSearch(), { target: { value: 'work' } });
    expect(await screen.findByText('Notification result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('type=tasks'))).toBe(true);
      expect(screen.queryByText('Notification result')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Task only')).toBeInTheDocument();
  });

  it('announces loading, empty, and keyword failure feedback', async () => {
    const firstSearch = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/hub-projects') return Promise.resolve(projectResponse());
      if (url.includes('__status_check__')) {
        return Promise.resolve(jsonResponse({
          semanticEnabled: false,
          semanticAvailable: false,
          results: [],
        }));
      }
      if (url.includes('q=alpha')) return firstSearch.promise;
      if (url.includes('q=broken')) {
        return Promise.resolve(new Response('Search service unavailable', { status: 503 }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(<SearchCommand />);
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'alpha' } });

    expect((await screen.findByText('Searching...')).closest('[role="status"]')).not.toBeNull();

    firstSearch.resolve(jsonResponse({ results: [], durationMs: 3 }));
    expect((await screen.findByText('No matching results.')).closest('[role="status"]')).not.toBeNull();

    fireEvent.change(input, { target: { value: 'broken' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Search unavailable.');
    expect(alert).toHaveTextContent('Search service unavailable');
  });
});
