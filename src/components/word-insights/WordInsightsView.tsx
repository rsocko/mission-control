'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Network, RotateCcw } from 'lucide-react';
import WordCloud from './WordCloud';
import WordTaskGraph from './WordTaskGraph';
import {
  WORD_INSIGHT_SOURCES,
  type WordInsightSource,
  type WordInsightsResult,
} from '@/lib/word-insights/types';
import { cn } from '@/lib/utils';

const SOURCE_LABELS: Record<WordInsightSource, string> = {
  title: 'Titles',
  notes: 'Notes',
  tag: 'Tags',
  list: 'Lists',
  project: 'Projects',
  phase: 'Phases',
};

export default function WordInsightsView() {
  const [mode, setMode] = useState<'cloud' | 'graph'>('cloud');
  const [enabledSources, setEnabledSources] = useState<WordInsightSource[]>([
    ...WORD_INSIGHT_SOURCES,
  ]);
  const [data, setData] = useState<WordInsightsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sources: enabledSources.join(',') });
      const response = await fetch(`/api/word-insights?${params}`, { signal });
      if (!response.ok) throw new Error('Failed to load word insights');
      const result = await response.json() as WordInsightsResult;
      if (requestId !== requestIdRef.current) return;
      setData(result);
      setSelectedWord((current) =>
        current && result.words.some((word) => word.text === current) ? current : null);
      setSelectedTaskId((current) =>
        current && result.tasks.some((task) => task.id === current) ? current : null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
      if (requestId !== requestIdRef.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load word insights');
    } finally {
      if (requestId === requestIdRef.current && !signal?.aborted) setLoading(false);
    }
  }, [enabledSources]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const taskById = useMemo(
    () => new Map(data?.tasks.map((task) => [task.id, task]) ?? []),
    [data],
  );
  const selectedWordData = data?.words.find((word) => word.text === selectedWord);
  const selectedTask = selectedTaskId ? taskById.get(selectedTaskId) : undefined;
  const provenanceByTask = new Map(
    selectedWordData?.provenance.map((provenance) => [provenance.taskId, provenance]) ?? [],
  );
  const shownTasks = selectedWordData
    ? selectedWordData.taskIds
        .map((taskId) => taskById.get(taskId))
        .filter((task) => Boolean(task))
    : selectedTask ? [selectedTask] : [];

  const selectWord = (word: string) => {
    setSelectedWord(word);
    setSelectedTaskId(null);
  };
  const selectTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedWord(null);
  };
  const toggleSource = (source: WordInsightSource) => {
    setEnabledSources((current) =>
      current.includes(source)
        ? current.filter((candidate) => candidate !== source)
        : WORD_INSIGHT_SOURCES.filter((candidate) =>
            candidate === source || current.includes(candidate)));
  };

  return (
    <main className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 pb-12 sm:px-6">
        <header className="mb-5">
          <h1 className="text-2xl font-bold">Word Insights</h1>
          <p className="mt-1 text-sm text-slate-400">
            Explore recurring words and the exact tasks they came from.
          </p>
        </header>

        <section
          className="mb-5 rounded-2xl border border-slate-800 bg-slate-900 p-4"
          aria-label="Word insight controls"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-slate-950 p-1" aria-label="Visualization mode">
              {([
                ['cloud', 'Cloud', Cloud],
                ['graph', 'Graph', Network],
              ] as const).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
                    mode === value ? 'bg-cyan-900 text-cyan-100' : 'text-slate-400 hover:text-white',
                  )}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <span className="ml-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              Sources
            </span>
            {WORD_INSIGHT_SOURCES.map((source) => {
              const enabled = enabledSources.includes(source);
              return (
                <button
                  key={source}
                  type="button"
                  aria-pressed={enabled}
                  onClick={() => toggleSource(source)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    enabled
                      ? 'border-cyan-700 bg-cyan-950 text-cyan-200'
                      : 'border-slate-700 bg-slate-900 text-slate-400',
                  )}
                >
                  {SOURCE_LABELS[source]}
                </button>
              );
            })}
            {data ? (
              <span className="ml-auto text-xs text-slate-400">
                {data.analyzedTaskCount} tasks analyzed{data.truncated ? ' (bounded)' : ''}
              </span>
            ) : null}
          </div>
        </section>

        {error ? (
          <section className="rounded-2xl border border-red-900/60 bg-red-950/20 p-8 text-center">
            <p className="text-sm text-red-300">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
            >
              <RotateCcw size={15} aria-hidden="true" />
              Retry
            </button>
          </section>
        ) : loading && !data ? (
          <div className="flex items-center justify-center py-28" role="status">
            <span className="mr-3 h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
            Analyzing task words
          </div>
        ) : data && data.words.length === 0 ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-12 text-center">
            <h2 className="text-lg font-semibold">No words to show</h2>
            <p className="mt-2 text-sm text-slate-400">
              Enable at least one source containing non-stop words.
            </p>
          </section>
        ) : data ? (
          <>
            <section
              className="relative rounded-2xl border border-slate-800 bg-slate-900 p-3 sm:p-5"
              aria-busy={loading}
            >
              {loading ? (
                <div className="absolute right-4 top-4 z-10 rounded-full bg-slate-950/90 px-3 py-1 text-xs text-slate-300" role="status">
                  Updating
                </div>
              ) : null}
              {data.wordTruncated ? (
                <p className="mb-2 text-center text-xs text-slate-400" role="status">
                  Showing the top {data.words.length} of {data.totalWordCount} words.
                </p>
              ) : null}
              {mode === 'cloud' ? (
                <WordCloud
                  words={data.words}
                  selectedWord={selectedWord}
                  onSelectWord={selectWord}
                />
              ) : (
                <WordTaskGraph
                  words={data.words}
                  tasks={data.tasks}
                  selectedWord={selectedWord}
                  selectedTaskId={selectedTaskId}
                  onSelectWord={selectWord}
                  onSelectTask={selectTask}
                />
              )}
            </section>

            <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold">
                  {selectedWordData
                    ? `"${selectedWordData.text}" tasks (${shownTasks.length})`
                    : selectedTask
                      ? `Task word connections (${selectedTask.words.length})`
                      : 'Connected tasks'}
                </h2>
                {shownTasks.length > 0 ? (
                  <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
                    {shownTasks.map((task) => task ? (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => selectTask(task.id)}
                          className={cn(
                            'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                            selectedTaskId === task.id
                              ? 'border-violet-500 bg-violet-950/40'
                              : 'border-slate-800 bg-slate-950/50 hover:border-slate-700',
                          )}
                        >
                          <span className="block text-sm text-slate-100">{task.title}</span>
                          <span className="mt-1 block text-xs text-slate-500">
                            {task.status} - {task.words.join(', ')}
                          </span>
                          {provenanceByTask.get(task.id)?.sources.map((source) => (
                            <span
                              key={source.source}
                              className="mt-1 mr-2 inline-block text-[11px] text-cyan-300/80"
                            >
                              {SOURCE_LABELS[source.source]}: {source.labels.join(', ')}
                              {source.count > 1 ? ` (${source.count})` : ''}
                            </span>
                          ))}
                        </button>
                      </li>
                    ) : null)}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">
                    Select a word to show every connected task. Select a task to expose its word connections.
                  </p>
                )}
              </section>

              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold">Accessible word list</h2>
                <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
                  {data.words.map((word) => (
                    <li key={word.text}>
                      <button
                        type="button"
                        onClick={() => selectWord(word.text)}
                        aria-pressed={selectedWord === word.text}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-800 aria-pressed:bg-cyan-950"
                      >
                        <span>{word.text}</span>
                        <span className="text-xs tabular-nums text-slate-500">
                          {word.count} - {word.taskIds.length} tasks
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            {selectedWordData ? (
              <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold">Source attribution for &quot;{selectedWordData.text}&quot;</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(selectedWordData.sources).map(([source, count]) => (
                    <span key={source} className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
                      {SOURCE_LABELS[source as WordInsightSource]}: {count}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
