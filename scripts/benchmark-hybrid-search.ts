import { performance } from 'node:perf_hooks';
import { fuseHybridResults } from '../src/lib/search/hybrid-ranking';
import type { SearchResult } from '../src/lib/search/repository';
import {
  applyEvaluationFilter,
  SYNTHETIC_HYBRID_EVALUATION,
} from './fixtures/hybrid-evaluation';

const DIMENSIONS = 64;
const QUERY_RUNS = 20;
const CANDIDATE_LIMIT = 100;
const CORPUS_SIZES = [10_000, 100_000] as const;
const GATES = {
  indexBuildMs: 2_000,
  memoryMiB: 128,
  queryEmbeddingP95Ms: 5,
  lexicalLookupP95Ms: 5,
  vectorLookupP95Ms: 50,
  fusionP95Ms: 5,
  endToEndP95Ms: 75,
} as const;

interface Timings {
  p50Ms: number;
  p95Ms: number;
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function timings(values: number[]): Timings {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
  };
}

function embedQuery(seed: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
    const value = Math.sin((seed + 1) * (dimension + 3));
    vector[dimension] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let dimension = 0; dimension < DIMENSIONS; dimension++) vector[dimension] *= scale;
  return vector;
}

function buildIndex(size: number): {
  vectors: Float32Array;
  lexicalIndex: Map<string, number[]>;
  buildMs: number;
  memoryBytes: number;
} {
  const before = process.memoryUsage();
  const startedAt = performance.now();
  const vectors = new Float32Array(size * DIMENSIONS);
  const lexicalIndex = new Map<string, number[]>();
  for (let row = 0; row < size; row++) {
    const offset = row * DIMENSIONS;
    let norm = 0;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      const value = Math.sin((row + 7) * (dimension + 11));
      vectors[offset + dimension] = value;
      norm += value * value;
    }
    const scale = 1 / Math.sqrt(norm);
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      vectors[offset + dimension] *= scale;
    }
    const term = `topic-${row % 1_000}`;
    const matches = lexicalIndex.get(term);
    if (matches) matches.push(row);
    else lexicalIndex.set(term, [row]);
  }
  const after = process.memoryUsage();
  return {
    vectors,
    lexicalIndex,
    buildMs: Number((performance.now() - startedAt).toFixed(2)),
    memoryBytes: Math.max(
      0,
      (after.arrayBuffers + after.heapUsed) - (before.arrayBuffers + before.heapUsed),
    ),
  };
}

function vectorLookup(vectors: Float32Array, query: Float32Array): number[] {
  const size = vectors.length / DIMENSIONS;
  const top: Array<{ row: number; score: number }> = [];
  for (let row = 0; row < size; row++) {
    const offset = row * DIMENSIONS;
    let score = 0;
    for (let dimension = 0; dimension < DIMENSIONS; dimension++) {
      score += vectors[offset + dimension] * query[dimension];
    }
    if (top.length < CANDIDATE_LIMIT) {
      top.push({ row, score });
      if (top.length === CANDIDATE_LIMIT) top.sort((left, right) => left.score - right.score);
    } else if (score > top[0].score) {
      top[0] = { row, score };
      top.sort((left, right) => left.score - right.score);
    }
  }
  return top.sort((left, right) => right.score - left.score).map((item) => item.row);
}

function searchResult(row: number, source: SearchResult['source']): SearchResult {
  const type = row % 5 === 0 ? 'notification' : 'task';
  return {
    type,
    id: `${type}-${row}`,
    title: `Synthetic entity ${row}`,
    snippet: '',
    score: 1,
    source,
    href: '/',
    metadata: {},
  };
}

function benchmark(size: number) {
  const index = buildIndex(size);
  const queryEmbeddingMs: number[] = [];
  const lexicalLookupMs: number[] = [];
  const vectorLookupMs: number[] = [];
  const fusionMs: number[] = [];
  const endToEndMs: number[] = [];

  for (let run = 0; run < QUERY_RUNS; run++) {
    const endToEndStartedAt = performance.now();
    const embeddingStartedAt = performance.now();
    const query = embedQuery(run);
    queryEmbeddingMs.push(performance.now() - embeddingStartedAt);

    const lexicalStartedAt = performance.now();
    const lexicalRows = index.lexicalIndex.get(`topic-${run % 1_000}`) ?? [];
    lexicalLookupMs.push(performance.now() - lexicalStartedAt);

    const lookupStartedAt = performance.now();
    const rows = vectorLookup(index.vectors, query);
    vectorLookupMs.push(performance.now() - lookupStartedAt);

    const lexical = lexicalRows.slice(0, 20).map((row) => searchResult(row, 'fts'));
    const semantic = rows.map((row) => searchResult(row, 'semantic'));
    const fusionStartedAt = performance.now();
    fuseHybridResults('synthetic entity', lexical, semantic, {
      limit: 20,
      perKindLimit: 15,
    });
    fusionMs.push(performance.now() - fusionStartedAt);
    endToEndMs.push(performance.now() - endToEndStartedAt);
  }

  return {
    entities: size,
    dimensions: DIMENSIONS,
    runs: QUERY_RUNS,
    indexBuildMs: index.buildMs,
    memoryMiB: Number((index.memoryBytes / 1024 / 1024).toFixed(2)),
    queryEmbedding: timings(queryEmbeddingMs),
    lexicalLookup: timings(lexicalLookupMs),
    vectorLookup: timings(vectorLookupMs),
    fusion: timings(fusionMs),
    endToEnd: timings(endToEndMs),
  };
}

const relevance = SYNTHETIC_HYBRID_EVALUATION.map((evaluation) => {
  const results = fuseHybridResults(
    evaluation.query,
    applyEvaluationFilter(evaluation.lexical, evaluation.filter),
    applyEvaluationFilter(evaluation.semantic, evaluation.filter),
    { limit: 20 },
  );
  const ids = results.map((result) => result.id);
  const passed = evaluation.expectedFirst
    ? ids[0] === evaluation.expectedFirst
    : JSON.stringify(ids) === JSON.stringify(evaluation.expectedIds);
  return { category: evaluation.category, passed };
});

const performanceResults = CORPUS_SIZES.map(benchmark);
const gatesPassed = relevance.every((result) => result.passed)
  && performanceResults.every((result) => (
    result.indexBuildMs <= GATES.indexBuildMs
    && result.memoryMiB <= GATES.memoryMiB
    && result.queryEmbedding.p95Ms <= GATES.queryEmbeddingP95Ms
    && result.lexicalLookup.p95Ms <= GATES.lexicalLookupP95Ms
    && result.vectorLookup.p95Ms <= GATES.vectorLookupP95Ms
    && result.fusion.p95Ms <= GATES.fusionP95Ms
    && result.endToEnd.p95Ms <= GATES.endToEndP95Ms
  ));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  strategy: 'deterministic-full-scan-baseline',
  gates: GATES,
  gatesPassed,
  relevance,
  performance: performanceResults,
}, null, 2));

if (!gatesPassed) process.exitCode = 1;
