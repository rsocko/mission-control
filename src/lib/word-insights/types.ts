export const WORD_INSIGHT_SOURCES = [
  'title',
  'notes',
  'tag',
  'list',
  'project',
  'phase',
] as const;

export type WordInsightSource = (typeof WORD_INSIGHT_SOURCES)[number];

export interface WordSourceValue {
  source: WordInsightSource;
  id: string;
  label: string;
  text: string;
}

export interface WordInsightTaskRecord {
  id: string;
  title: string;
  status: string;
  values: WordSourceValue[];
}

export interface WordSourceAttribution {
  source: WordInsightSource;
  count: number;
  labels: string[];
}

export interface WordTaskProvenance {
  taskId: string;
  sources: WordSourceAttribution[];
}

export interface WordInsight {
  text: string;
  count: number;
  sources: Partial<Record<WordInsightSource, number>>;
  taskIds: string[];
  provenance: WordTaskProvenance[];
}

export interface WordInsightTask {
  id: string;
  title: string;
  status: string;
  words: string[];
}

export interface WordInsightsResult {
  words: WordInsight[];
  tasks: WordInsightTask[];
  enabledSources: WordInsightSource[];
  analyzedTaskCount: number;
  truncated: boolean;
  totalWordCount: number;
  wordTruncated: boolean;
  limits: {
    taskLimit: number;
    wordLimit: number;
    maxTextLength: number;
    maxTokensPerValue: number;
    maxValuesPerSourcePerTask: number;
  };
}
