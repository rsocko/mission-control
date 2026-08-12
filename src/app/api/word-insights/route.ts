import { NextResponse } from 'next/server';
import {
  DEFAULT_TASK_LIMIT,
  DEFAULT_WORD_LIMIT,
  MAX_TASK_LIMIT,
  MAX_WORD_LIMIT,
} from '@/lib/word-insights/extract';
import { getWordInsights } from '@/lib/word-insights/service';
import {
  WORD_INSIGHT_SOURCES,
  type WordInsightSource,
} from '@/lib/word-insights/types';
import logger from '@/lib/logger';

function parseLimit(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, maximum)) : fallback;
}

function parseSources(params: URLSearchParams): WordInsightSource[] | undefined {
  if (!params.has('sources')) return undefined;
  const validSources = new Set<string>(WORD_INSIGHT_SOURCES);
  const requestedSources = new Set(
    (params.get('sources') ?? '').split(',').filter((source) => validSources.has(source)),
  );
  return WORD_INSIGHT_SOURCES.filter((source) => requestedSources.has(source));
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const result = await getWordInsights({
      enabledSources: parseSources(params),
      taskLimit: parseLimit(params.get('taskLimit'), DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT),
      wordLimit: parseLimit(params.get('wordLimit'), DEFAULT_WORD_LIMIT, MAX_WORD_LIMIT),
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Failed to build word insights');
    return NextResponse.json({ error: 'Failed to load word insights' }, { status: 500 });
  }
}
