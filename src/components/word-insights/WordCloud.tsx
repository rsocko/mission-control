'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import cloud from 'd3-cloud';
import type * as d3 from 'd3';
import type { WordInsight, WordInsightSource } from '@/lib/word-insights/types';

interface PositionedWord extends d3.layout.cloud.Word {
  insight: WordInsight;
  text: string;
  size: number;
  x: number;
  y: number;
  rotate: number;
}

const SOURCE_COLORS: Record<WordInsightSource | 'multiple', string> = {
  title: '#60a5fa',
  notes: '#94a3b8',
  tag: '#c084fc',
  list: '#fbbf24',
  project: '#34d399',
  phase: '#22d3ee',
  multiple: '#f472b6',
};

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function wordColor(word: WordInsight): string {
  const sources = Object.keys(word.sources) as WordInsightSource[];
  return SOURCE_COLORS[sources.length === 1 ? sources[0] : 'multiple'];
}

export default function WordCloud({
  words,
  selectedWord,
  onSelectWord,
}: {
  words: WordInsight[];
  selectedWord: string | null;
  onSelectWord: (word: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([800, 440]);
  const [layoutResult, setLayoutResult] = useState<{
    key: string;
    words: PositionedWord[];
  }>({ key: '', words: [] });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSize = () => setSize([
      Math.max(320, Math.floor(container.clientWidth)),
      Math.max(360, Math.min(520, Math.floor(container.clientWidth * 0.58))),
    ]);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const layoutWords = useMemo(() => {
    const counts = words.map((word) => word.count);
    const minimum = Math.min(...counts, 1);
    const maximum = Math.max(...counts, 1);
    return words.map((insight) => ({
      insight,
      text: insight.text,
      size: minimum === maximum
        ? 30
        : 16 + ((insight.count - minimum) / (maximum - minimum)) * 38,
      rotate: 0,
      x: 0,
      y: 0,
    }));
  }, [words]);
  const layoutKey = useMemo(
    () => words.map((word) => `${word.text}:${word.count}`).join('|'),
    [words],
  );
  const positioned = layoutResult.key === layoutKey ? layoutResult.words : [];

  useEffect(() => {
    if (layoutWords.length === 0) return;
    const layout = cloud<PositionedWord>()
      .size(size)
      .words(layoutWords)
      .padding(5)
      .rotate(0)
      .font('Arial')
      .fontWeight((word) => word.insight.count > 2 ? 650 : 500)
      .fontSize((word) => word.size)
      .random(seededRandom(17))
      .on('end', (placed) => setLayoutResult({ key: layoutKey, words: placed }));
    layout.start();
    return () => {
      layout.stop();
    };
  }, [layoutKey, layoutWords, size]);

  return (
    <div ref={containerRef} className="min-h-[360px] w-full">
      <svg
        viewBox={`0 0 ${size[0]} ${size[1]}`}
        className="h-auto w-full"
        role="group"
        aria-label={`Word cloud with ${words.length} words`}
      >
        <title>Interactive word cloud</title>
        <g transform={`translate(${size[0] / 2},${size[1] / 2})`}>
          {positioned.map((word) => {
            const selected = selectedWord === word.text;
            const activate = () => onSelectWord(word.text);
            return (
              <text
                key={word.text}
                x={word.x}
                y={word.y}
                textAnchor="middle"
                transform={`rotate(${word.rotate})`}
                fill={wordColor(word.insight)}
                fontSize={word.size}
                fontWeight={selected ? 800 : 600}
                opacity={selectedWord && !selected ? 0.35 : 0.9}
                className="cursor-pointer transition-opacity focus:stroke-white"
                role="button"
                tabIndex={0}
                aria-label={`${word.text}, ${word.insight.count} occurrences in ${word.insight.taskIds.length} tasks`}
                aria-pressed={selected}
                onClick={activate}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    activate();
                  }
                }}
              >
                {word.text}
              </text>
            );
          })}
        </g>
      </svg>
      {layoutResult.key === layoutKey && positioned.length < words.length ? (
        <p className="px-3 pb-2 text-center text-xs text-slate-400" role="status">
          {positioned.length} of {words.length} words fit this cloud. The full list remains available below.
        </p>
      ) : null}
    </div>
  );
}
