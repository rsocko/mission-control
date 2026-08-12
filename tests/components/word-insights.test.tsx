import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WordInsight } from '@/lib/word-insights/types';

vi.mock('lucide-react', () => {
  const Icon = () => <span aria-hidden="true" />;
  return { Cloud: Icon, Network: Icon, RotateCcw: Icon };
});

vi.mock('@/components/word-insights/WordCloud', () => ({
  default: ({
    words,
    onSelectWord,
  }: {
    words: WordInsight[];
    onSelectWord: (word: string) => void;
  }) => (
    <div aria-label="Mock word cloud">
      {words.map((word) => (
        <button key={word.text} onClick={() => onSelectWord(word.text)}>
          Cloud word {word.text}
        </button>
      ))}
    </div>
  ),
}));

const payload = {
  words: [
    {
      text: 'api',
      count: 3,
      sources: { title: 2, tag: 1 },
      taskIds: ['task-1', 'task-2'],
      provenance: [
        {
          taskId: 'task-1',
          sources: [
            { source: 'title', count: 1, labels: ['Task title'] },
            { source: 'tag', count: 1, labels: ['Backend'] },
          ],
        },
        {
          taskId: 'task-2',
          sources: [{ source: 'title', count: 1, labels: ['Task title'] }],
        },
      ],
    },
    {
      text: 'deploy',
      count: 1,
      sources: { title: 1 },
      taskIds: ['task-1'],
      provenance: [],
    },
  ],
  tasks: [
    { id: 'task-1', title: 'Deploy API', status: 'todo', words: ['api', 'deploy'] },
    { id: 'task-2', title: 'Document API', status: 'in_progress', words: ['api'] },
  ],
  enabledSources: ['title', 'notes', 'tag', 'list', 'project', 'phase'],
  analyzedTaskCount: 2,
  truncated: false,
  totalWordCount: 2,
  wordTruncated: false,
  limits: {
    taskLimit: 500,
    wordLimit: 50,
    maxTextLength: 4_000,
    maxTokensPerValue: 64,
    maxValuesPerSourcePerTask: 32,
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WordInsightsView', () => {
  it('filters to exact connected tasks and exposes a selected task word set', async () => {
    const { default: WordInsightsView } = await import(
      '@/components/word-insights/WordInsightsView'
    );
    await act(async () => {
      render(<WordInsightsView />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Cloud word api' }));
    const taskSection = screen.getByRole('heading', { name: '"api" tasks (2)' }).parentElement;
    expect(taskSection).not.toBeNull();
    expect(within(taskSection!).getByText('Deploy API')).toBeInTheDocument();
    expect(within(taskSection!).getByText('Document API')).toBeInTheDocument();
    expect(within(taskSection!).getByText('Tags: Backend')).toBeInTheDocument();

    fireEvent.click(within(taskSection!).getByRole('button', { name: /Deploy API/ }));
    expect(screen.getByRole('heading', { name: 'Task word connections (2)' })).toBeInTheDocument();
    expect(screen.getByText('todo - api, deploy')).toBeInTheDocument();
  });

  it('refetches with deterministic source toggles', async () => {
    const { default: WordInsightsView } = await import(
      '@/components/word-insights/WordInsightsView'
    );
    await act(async () => {
      render(<WordInsightsView />);
    });
    await screen.findByText('2 tasks analyzed');

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/word-insights?sources=title%2Ctag%2Clist%2Cproject%2Cphase',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('switches to the accessible graph and supports word and task selection', async () => {
    const { default: WordInsightsView } = await import(
      '@/components/word-insights/WordInsightsView'
    );
    await act(async () => {
      render(<WordInsightsView />);
    });
    await screen.findByText('2 tasks analyzed');

    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.getByRole('group', { name: 'Word to task connections' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select word api' }));
    expect(screen.getByRole('button', { name: 'Select task Deploy API' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select task Deploy API' }));
    expect(screen.getByRole('button', { name: 'Select word deploy' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('does not let an older retry overwrite a newer source-filtered response', async () => {
    let resolveRetry: ((response: Response) => void) | undefined;
    const filteredPayload = { ...payload, analyzedTaskCount: 1 };
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRetry = resolve;
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(filteredPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const { default: WordInsightsView } = await import(
      '@/components/word-insights/WordInsightsView'
    );
    await act(async () => {
      render(<WordInsightsView />);
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(await screen.findByText('1 tasks analyzed')).toBeInTheDocument();

    await act(async () => {
      resolveRetry?.(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    expect(screen.getByText('1 tasks analyzed')).toBeInTheDocument();
  });
});
