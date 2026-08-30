---
title: "Semantic Retrieval Relevance and Performance Baseline"
status: proposed
created: 2026-08-30
category: design
related:
  - "./architecture.md"
  - "./roadmap.md"
  - "https://github.com/rsocko/mission-control/issues/1663"
---

# Semantic Retrieval Relevance and Performance Baseline

## Decision

Hybrid search uses deterministic reciprocal-rank fusion (RRF) rather than mixing
backend scores. Exact IDs and titles sort first, title-prefix matches sort next, and
RRF orders the remaining lexical and semantic candidates. Results deduplicate by
`(entity kind, entity ID)`, apply per-kind caps when multiple kinds are present, and
break ties by entity kind, normalized title, then stable ID.

The current SQLite and PostgreSQL vector repositories remain compatibility
implementations with a default 5,000-candidate ceiling. They do not meet the
100,000-entity recall gate and explicitly report:

- `kind: bounded-in-process`;
- `guaranteesFullRecall: false`; and
- `guaranteedScale: 5000` by default.

SQLite is therefore supported for semantic retrieval only up to the configured scan
ceiling. Above it, keyword search remains supported and semantic enrichment is
best-effort with visible truncated-scan metrics.

PostgreSQL continues to use the same explicit limitation. `pgvector`/ANN is not
enabled by this change because Mission Control does not currently provision the
extension, stored embeddings have runtime-selected dimensions, and no supported
deployment target was available to validate extension installation, backup,
migration, filtered recall, or update/delete behavior. Adding an unconditional
extension migration would make existing PostgreSQL deployments fail. An indexed
PostgreSQL implementation remains blocked on an approved deployment contract and a
representative integration environment with `pgvector` available.

No separate vector service is introduced.

## Synthetic relevance set

`tests/search/fixtures/hybrid-evaluation.ts` contains synthetic cases for exact ID,
exact title, lexical, conceptual, cross-source, filtered, duplicate, and no-result
queries. The set contains no user content. `tests/search/hybrid-ranking.test.ts`
enforces the relevance and deterministic-ordering gates.

## Repeatable benchmark

Run:

```text
npm run benchmark:hybrid-search
```

The harness builds deterministic 64-dimension vectors, performs a full-scan top-100
lookup, fuses lexical and semantic candidates through the production RRF function,
and emits JSON only. Timings and aggregate memory contain no query text, result body,
or vector values.

The command exits non-zero unless every relevance case passes and each corpus meets
these deterministic harness gates: index build at most 2,000 ms, incremental vector
memory at most 128 MiB, synthetic query embedding p95 at most 5 ms, vector lookup p95
at most 50 ms, indexed lexical lookup p95 at most 5 ms, fusion p95 at most 5 ms,
and end-to-end p95 at most 75 ms.

Baseline environment: Windows, Node.js 24.14.0, 20 warm-process queries per corpus,
captured 2026-08-30.

| Entities | Index build | Memory | Query embedding p50/p95 | Lexical lookup p50/p95 | Vector lookup p50/p95 | Fusion p50/p95 | End-to-end p50/p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 10.58 ms | 4.37 MiB | 0.01 / 0.02 ms | 0.00 / 0.00 ms | 1.53 / 1.71 ms | 0.10 / 0.16 ms | 1.63 / 1.89 ms |
| 100,000 | 254.11 ms | 19.85 MiB | 0.01 / 0.01 ms | 0.00 / 0.00 ms | 7.92 / 10.55 ms | 0.15 / 0.30 ms | 8.10 / 10.82 ms |

These are deterministic algorithm baselines, not provider or database claims. The
lexical stage measures lookup in a prebuilt in-memory term index. Query
embedding measures local synthetic vector generation so runs are repeatable and do
not send data to a provider. Index build measures in-memory vector construction and
allocation. Production provider latency, database serialization, and I/O must be
measured separately in the approved deployment environment before an ANN adapter can
claim the 100,000-entity gate.

The baseline demonstrates that RRF is not the bottleneck and that a compact
64-dimension full scan can be computationally inexpensive. It does not justify
removing the repository candidate ceiling: configured embedding models commonly use
larger dimensions, and the current adapters deserialize text vectors into process
memory. The supported limit remains explicit until an indexed backend passes the
deployment and recall gates.
