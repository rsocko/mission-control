import {
  WORD_INSIGHT_SOURCES,
  type WordInsight,
  type WordInsightSource,
  type WordInsightsResult,
  type WordInsightTaskRecord,
  type WordSourceAttribution,
} from './types';

export const DEFAULT_WORD_LIMIT = 50;
export const MAX_WORD_LIMIT = 50;
export const DEFAULT_TASK_LIMIT = 500;
export const MAX_TASK_LIMIT = 1_000;
export const MAX_TEXT_LENGTH = 4_000;
export const MAX_TOKENS_PER_VALUE = 64;
export const MAX_VALUES_PER_SOURCE_PER_TASK = 32;

const STOP_WORDS = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'done',
  'down', 'during', 'each', 'for', 'from', 'further', 'get', 'got', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just',
  'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  "aren't", "can't", "couldn't", "didn't", "doesn't", "don't", "hadn't",
  "hasn't", "haven't", "isn't", "shouldn't", "wasn't", "weren't", "won't",
  "wouldn't",
]);

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[-'\u2018\u2019][\p{L}\p{N}]+)*/gu;

export function normalizeToken(token: string): string {
  return token
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'s$/u, '');
}

export function tokenize(text: string): string[] {
  const matches = text.slice(0, MAX_TEXT_LENGTH).match(TOKEN_PATTERN) ?? [];
  const tokens: string[] = [];

  for (const match of matches) {
    const token = normalizeToken(match);
    if (
      token.length < 2
      || STOP_WORDS.has(token)
      || /^\p{N}+$/u.test(token)
    ) continue;
    tokens.push(token);
    if (tokens.length === MAX_TOKENS_PER_VALUE) break;
  }

  return tokens;
}

interface MutableWord {
  count: number;
  sources: Partial<Record<WordInsightSource, number>>;
  tasks: Map<string, Map<WordInsightSource, { count: number; labels: Set<string> }>>;
}

export function extractWordInsights(input: {
  records: WordInsightTaskRecord[];
  enabledSources?: Iterable<WordInsightSource>;
  wordLimit?: number;
  taskLimit?: number;
  truncated?: boolean;
}): WordInsightsResult {
  const enabledSet = new Set(input.enabledSources ?? WORD_INSIGHT_SOURCES);
  const enabledSources = WORD_INSIGHT_SOURCES.filter((source) => enabledSet.has(source));
  const wordLimit = Math.max(1, Math.min(input.wordLimit ?? DEFAULT_WORD_LIMIT, MAX_WORD_LIMIT));
  const taskLimit = Math.max(1, Math.min(input.taskLimit ?? DEFAULT_TASK_LIMIT, MAX_TASK_LIMIT));
  const records = input.records.slice(0, taskLimit);
  const words = new Map<string, MutableWord>();

  for (const record of records) {
    const sourceValueCounts = new Map<WordInsightSource, number>();
    for (const value of record.values) {
      if (!enabledSet.has(value.source)) continue;
      const sourceValueCount = sourceValueCounts.get(value.source) ?? 0;
      if (sourceValueCount >= MAX_VALUES_PER_SOURCE_PER_TASK) continue;
      sourceValueCounts.set(value.source, sourceValueCount + 1);
      for (const token of tokenize(value.text)) {
        const word: MutableWord = words.get(token) ?? {
          count: 0,
          sources: {} as Partial<Record<WordInsightSource, number>>,
          tasks: new Map(),
        };
        word.count += 1;
        word.sources[value.source] = (word.sources[value.source] ?? 0) + 1;

        const taskSources = word.tasks.get(record.id) ?? new Map();
        const attribution = taskSources.get(value.source) ?? {
          count: 0,
          labels: new Set<string>(),
        };
        attribution.count += 1;
        attribution.labels.add(value.label);
        taskSources.set(value.source, attribution);
        word.tasks.set(record.id, taskSources);
        words.set(token, word);
      }
    }
  }

  const selectedWords: WordInsight[] = [...words.entries()]
    .sort(([leftText, left], [rightText, right]) =>
      right.count - left.count || leftText.localeCompare(rightText, 'en-US'))
    .slice(0, wordLimit)
    .map(([text, word]) => {
      const taskIds = [...word.tasks.keys()].sort((left, right) =>
        left.localeCompare(right, 'en-US'));
      return {
        text,
        count: word.count,
        sources: word.sources,
        taskIds,
        provenance: taskIds.map((taskId) => ({
          taskId,
          sources: [...(word.tasks.get(taskId)?.entries() ?? [])]
            .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
            .map(([source, attribution]): WordSourceAttribution => ({
              source,
              count: attribution.count,
              labels: [...attribution.labels].sort((left, right) =>
                left.localeCompare(right, 'en-US')),
            })),
        })),
      };
    });

  const selectedWordSet = new Set(selectedWords.map((word) => word.text));
  const taskWords = new Map<string, Set<string>>();
  for (const word of selectedWords) {
    for (const taskId of word.taskIds) {
      const connected = taskWords.get(taskId) ?? new Set<string>();
      connected.add(word.text);
      taskWords.set(taskId, connected);
    }
  }

  return {
    words: selectedWords,
    tasks: records
      .filter((record) => taskWords.has(record.id))
      .map((record) => ({
        id: record.id,
        title: record.title,
        status: record.status,
        words: [...(taskWords.get(record.id) ?? [])]
          .filter((word) => selectedWordSet.has(word))
          .sort((left, right) => left.localeCompare(right, 'en-US')),
      })),
    enabledSources,
    analyzedTaskCount: records.length,
    truncated: Boolean(input.truncated) || input.records.length > records.length,
    totalWordCount: words.size,
    wordTruncated: words.size > selectedWords.length,
    limits: {
      taskLimit,
      wordLimit,
      maxTextLength: MAX_TEXT_LENGTH,
      maxTokensPerValue: MAX_TOKENS_PER_VALUE,
      maxValuesPerSourcePerTask: MAX_VALUES_PER_SOURCE_PER_TASK,
    },
  };
}
