'use client';

import type {
  WordInsight,
  WordInsightTask,
} from '@/lib/word-insights/types';

const MAX_RENDERED_TASKS = 80;
const WIDTH = 920;

export default function WordTaskGraph({
  words,
  tasks,
  selectedWord,
  selectedTaskId,
  onSelectWord,
  onSelectTask,
}: {
  words: WordInsight[];
  tasks: WordInsightTask[];
  selectedWord: string | null;
  selectedTaskId: string | null;
  onSelectWord: (word: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const selectedTask = selectedTaskId ? taskById.get(selectedTaskId) : undefined;
  const visibleWords = selectedTask
    ? words.filter((word) => selectedTask.words.includes(word.text))
    : words;
  const connectedTaskIds = selectedWord
    ? words.find((word) => word.text === selectedWord)?.taskIds ?? []
    : selectedTask ? [selectedTask.id] : [];
  const connectedTasks = connectedTaskIds
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is WordInsightTask => Boolean(task))
    .slice(0, MAX_RENDERED_TASKS);
  const rowCount = Math.max(visibleWords.length, connectedTasks.length, 10);
  const height = Math.max(420, rowCount * 34 + 60);
  const wordY = new Map(visibleWords.map((word, index) => [
    word.text,
    40 + ((index + 0.5) * (height - 80)) / visibleWords.length,
  ]));
  const taskY = new Map(connectedTasks.map((task, index) => [
    task.id,
    40 + ((index + 0.5) * (height - 80)) / connectedTasks.length,
  ]));
  const edges = connectedTasks.flatMap((task) =>
    task.words
      .filter((word) => wordY.has(word))
      .map((word) => ({ word, taskId: task.id })));

  return (
    <div className="max-h-[620px] overflow-auto rounded-xl bg-slate-950/60">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="min-w-[700px] w-full"
        role="group"
        aria-label="Word to task connections"
      >
        <title>Interactive word to task graph</title>
        {edges.map((edge) => (
          <line
            key={`${edge.word}:${edge.taskId}`}
            x1={260}
            y1={wordY.get(edge.word)}
            x2={650}
            y2={taskY.get(edge.taskId)}
            stroke="#475569"
            strokeWidth={selectedTaskId === edge.taskId ? 2.5 : 1}
            opacity={0.7}
          />
        ))}
        {visibleWords.map((word) => {
          const y = wordY.get(word.text);
          const selected = selectedWord === word.text || selectedTask?.words.includes(word.text);
          return (
            <g
              key={word.text}
              role="button"
              tabIndex={0}
              aria-label={`Select word ${word.text}`}
              aria-pressed={Boolean(selected)}
              className="cursor-pointer"
              onClick={() => onSelectWord(word.text)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectWord(word.text);
                }
              }}
            >
              <rect
                x={40}
                y={(y ?? 0) - 13}
                width={220}
                height={26}
                rx={13}
                fill={selected ? '#0e7490' : '#1e293b'}
                stroke={selected ? '#67e8f9' : '#475569'}
              />
              <text x={54} y={(y ?? 0) + 4} fill="#f8fafc" fontSize={12}>
                {word.text} ({word.count})
              </text>
            </g>
          );
        })}
        {connectedTasks.map((task) => {
          const y = taskY.get(task.id);
          const selected = selectedTaskId === task.id;
          return (
            <g
              key={task.id}
              role="button"
              tabIndex={0}
              aria-label={`Select task ${task.title}`}
              aria-pressed={selected}
              className="cursor-pointer"
              onClick={() => onSelectTask(task.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectTask(task.id);
                }
              }}
            >
              <rect
                x={650}
                y={(y ?? 0) - 15}
                width={230}
                height={30}
                rx={7}
                fill={selected ? '#4c1d95' : '#172554'}
                stroke={selected ? '#c4b5fd' : '#3b82f6'}
              />
              <text x={662} y={(y ?? 0) + 4} fill="#e2e8f0" fontSize={11}>
                {task.title.length > 34 ? `${task.title.slice(0, 31)}...` : task.title}
              </text>
            </g>
          );
        })}
      </svg>
      {connectedTaskIds.length > MAX_RENDERED_TASKS ? (
        <p className="px-4 pb-3 text-xs text-slate-400" role="status">
          Graph limited to the first {MAX_RENDERED_TASKS} tasks. The exact full task list is shown below.
        </p>
      ) : null}
    </div>
  );
}
