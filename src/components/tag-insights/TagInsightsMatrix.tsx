'use client';

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { makeTagPairKey } from '@/lib/tag-insights/aggregate';
import type {
  TagInsightPair,
  TagInsightTag,
  TagInsights,
} from '@/lib/tag-insights/types';

function pairFor(
  pairs: Map<string, TagInsightPair>,
  firstTag: TagInsightTag,
  secondTag: TagInsightTag,
): TagInsightPair | undefined {
  return pairs.get(makeTagPairKey(firstTag.id, secondTag.id));
}

function cellColor(count: number, maximum: number): string {
  if (count === 0 || maximum === 0) return 'rgba(71, 85, 105, 0.14)';
  const opacity = 0.18 + (count / maximum) * 0.72;
  return `rgba(59, 130, 246, ${opacity.toFixed(2)})`;
}

export default function TagInsightsMatrix({ data }: { data: TagInsights }) {
  const [selectedPair, setSelectedPair] = useState<TagInsightPair | null>(null);
  const pairs = useMemo(
    () => new Map(data.pairs.map((pair) => [pair.key, pair])),
    [data.pairs],
  );
  const activePair = selectedPair && pairs.has(selectedPair.key) ? selectedPair : null;
  const maximum = useMemo(
    () => Math.max(0, ...data.tags.map((tag) => tag.taskCount)),
    [data.tags],
  );
  const selectedTags = activePair
    ? [
        data.tags.find((tag) => tag.id === activePair.sourceTagId),
        data.tags.find((tag) => tag.id === activePair.targetTagId),
      ].filter((tag): tag is TagInsightTag => Boolean(tag))
    : [];

  return (
    <div className="grid min-h-[30rem] lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 overflow-x-auto p-4">
        <table className="mx-auto border-separate border-spacing-1 text-xs">
          <caption className="sr-only">
            Tag co-occurrence counts. Diagonal cells are total tasks for one tag.
            Other cells are tasks shared by two tags.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-[var(--surface-0)]" />
              {data.tags.map((tag) => (
                <th
                  key={tag.id}
                  scope="col"
                  className="h-28 w-11 min-w-11 align-bottom font-medium text-[var(--text-secondary)]"
                >
                  <span className="inline-block max-w-24 origin-bottom-left -rotate-45 truncate">
                    {tag.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.tags.map((rowTag) => (
              <tr key={rowTag.id}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-40 truncate bg-[var(--surface-0)] pr-2 text-right font-medium text-[var(--text-secondary)]"
                  title={rowTag.name}
                >
                  {rowTag.name}
                </th>
                {data.tags.map((columnTag) => {
                  const diagonal = rowTag.id === columnTag.id;
                  const pair = diagonal ? undefined : pairFor(pairs, rowTag, columnTag);
                  const count = diagonal ? rowTag.taskCount : pair?.count ?? 0;
                  const label = diagonal
                    ? `${rowTag.name}: ${count} tasks`
                    : `${rowTag.name} and ${columnTag.name}: ${count} shared tasks`;
                  return (
                    <td key={columnTag.id}>
                      <button
                        type="button"
                        aria-label={label}
                        title={label}
                        disabled={diagonal || !pair}
                        onClick={() => pair && setSelectedPair(pair)}
                        className="h-11 w-11 rounded text-center font-semibold text-white outline-none ring-[var(--accent-300)] transition hover:scale-105 focus-visible:ring-2 disabled:cursor-default disabled:text-[var(--text-muted)]"
                        style={{ backgroundColor: cellColor(count, maximum) }}
                      >
                        {count || '–'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-center text-xs text-[var(--text-muted)]">
          Diagonal = all tasks with that tag. Cells below the threshold are hidden.
        </p>
      </div>

      <aside
        className="border-t border-[var(--border)] p-4 lg:border-l lg:border-t-0"
        aria-live="polite"
      >
        {activePair ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Shared tasks</h2>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {selectedTags.map((tag) => tag.name).join(' + ')}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close shared tasks"
                onClick={() => setSelectedPair(null)}
                className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {activePair.count} {activePair.count === 1 ? 'task' : 'tasks'}
            </p>
            <ol className="mt-2 space-y-2">
              {activePair.taskIds.map((taskId) => {
                const task = data.tasks[taskId];
                if (!task) return null;
                return (
                  <li key={task.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
                    <p className="text-sm font-medium">{task.title}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                      <span className="capitalize text-[var(--text-muted)]">
                        {task.status.replaceAll('_', ' ')}
                      </span>
                      <a
                        href={`/?taskId=${encodeURIComponent(task.id)}`}
                        className="text-[var(--accent-300)] hover:underline"
                      >
                        Open task
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <div className="flex h-full min-h-36 flex-col items-center justify-center text-center">
            {data.pairs.length === 0 ? (
              <>
                <p className="text-sm font-medium">No visible relationships</p>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  {data.tags.length === 1
                    ? 'Add another non-system tag to a task to create a relationship.'
                    : 'Lower the minimum shared tasks threshold to reveal weaker relationships.'}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Select a relationship</p>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  Choose an off-diagonal cell to reveal its shared tasks.
                </p>
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
