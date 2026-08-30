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

The SQLite vector repository remains a compatibility implementation with a
default 5,000-candidate ceiling. It does not meet the 100,000-entity recall
gate and explicitly reports:

- `kind: bounded-in-process`;
- `guaranteesFullRecall: false`; and
- `guaranteedScale: 5000` by default.

SQLite is therefore supported for semantic retrieval only up to the configured
scan ceiling. Above it, keyword search remains supported and semantic enrichment
is best-effort with visible truncated-scan metrics.

PostgreSQL selects pgvector 0.8.6 with HNSW for the 100,000-entity path. HNSW
provides the best measured speed/recall tradeoff without IVFFlat's training step.
It costs more memory and takes longer to build than IVFFlat, so build time, index
size, backend memory, and restore behavior remain explicit gates and measurements.
The extension is an administrator-installed deployment prerequisite rather than an
unconditional application migration. Runtime-selected dimensions require a
dimension-specific vector table/index migration before an index identity becomes
active.

No separate vector service is introduced.

## Synthetic relevance set

`tests/search/fixtures/hybrid-evaluation.ts` contains synthetic cases for exact ID,
exact title, lexical, conceptual, cross-source, filtered, duplicate, and no-result
queries. The set contains no user content. `tests/search/hybrid-ranking.test.ts`
enforces the relevance and deterministic-ordering gates.

## Repeatable benchmarks

Run:

```text
npm run benchmark:hybrid-search
```

This in-memory harness remains a ranking and bounded-scan regression baseline. It
is not evidence for production PostgreSQL scale.

The PostgreSQL gate runs against an administrator-provisioned PostgreSQL 17
database with pgvector 0.8.6:

```text
MC_BENCHMARK_POSTGRES_URL=postgresql://... \
 npm run --silent benchmark:postgres-vector
```

The default and required CI dimension is the production-representative 1536.
Both local and CI runs use the same pgvector image, production repository,
semantic tables, ANN projection, HNSW parameters, corpus sizes, filters, and gates.

### Method

`scripts/benchmark-postgres-vector.ts` creates only deterministic synthetic
metadata and vectors. For both corpus sizes it:

1. initializes the production migrations, creates a production semantic index
   identity, bulk-backfills `semantic_documents`, `semantic_vectors`, and
   `semantic_vector_ann`, and rebuilds that identity's production HNSW cosine index;
2. obtains full-precision `vector` cosine reference results with ANN, ordinary
   index, index-only, and bitmap scans disabled; HNSW candidate generation remains
   the production `halfvec` expression followed by full-precision repository rerank;
3. runs unfiltered and selective scope/category/expiry ANN queries through
   `PostgresSemanticIndexRepository.queryVectors`, whose indexed transaction disables
   sequential scans and explicit sorts locally so PostgreSQL cannot silently replace
   the required order-producing ANN path with a full or B-tree-filtered scan;
   two unmeasured warm-up queries precede 20 measured queries so p95 does not collapse
   to a single cold-start sample;
   candidate generation uses a minimum `ef_search`/rerank budget of 200 to keep
   100,000-row recall above the required floor;
4. parses `EXPLAIN (ANALYZE, FORMAT JSON)` and rejects any ANN plan that does not
  contain the named HNSW index or that contains a sequential scan;
5. seeds explicit `restricted` and non-task (`project`) negative cohorts, queries
   only `task` plus `standard`, rejects any unauthorized result, and compares ANN
   with the exact top ten to gate average recall@10;
6. instruments the production repository's nearest-neighbor SQL for vector-lookup
  p50/p95, records the complete `queryVectors` call as end-to-end repository
  p50/p95, and reports `EXPLAIN ANALYZE` execution time separately;
7. records table/index bytes and, in CI, whole-PostgreSQL-container cgroup memory
  before and after each corpus; outside a container it clearly labels the current
  backend memory-context fallback;
8. separately times one `repository.upsertVector` update, a 99-row SQL batch update,
  100 repository vector deletes, and 100 repository expiry deletions; and
9. writes a full-database custom-format `pg_dump`, creates a fresh disposable
  database, installs pgvector first, runs `pg_restore`, reruns required vector
  initialization to prove the isolated migration stream is idempotent, and verifies
  counts, checksums, the identity-specific HNSW plan, and a repository query.

The 10,000-row run omits the redundant dump. The 100,000-row run performs the full
backup/restore rehearsal using PostgreSQL 17 tools from the pinned service container
in CI, or compatible local `pg_dump`/`pg_restore` binaries.

### Gates and output

The command emits one JSON document and no query text, vector, content, connection
string, or per-result identity. It exits non-zero unless PostgreSQL is major version
17, pgvector is exactly 0.8.6, every measured query reports the production
`postgres-hnsw` scan contract, every plan uses the matching identity-specific HNSW
index without a sequential scan, and each corpus passes:

- average recall@10 of at least 0.90 unfiltered and 0.80 with selective filters;
- non-empty restricted/non-task cohorts with zero unauthorized results;
- at the critical 100,000-row profile, vector lookup p95 at most 200 ms and
 end-to-end repository p95 at most 300 ms;
- at the 10,000-row smoke profile, vector lookup p95 at most 400 ms and
 end-to-end repository p95 at most 450 ms, while reporting the same p50/p95
 measurements and preserving all recall, plan, filtering, and lifecycle gates;
- measurable PostgreSQL container cgroup memory in CI;
- backfill and HNSW build at most 900 seconds each;
- one repository update at most 5 seconds, the 99-row batch update at most 60
 seconds, and delete/expiry at most 60 seconds; and
- custom-format backup and fresh-database restore at most 900 seconds each with
 matching counts/checksums, idempotent required vector initialization, and a
 working restored repository/HNSW query.

CI output is the run record. Capture representative 1536-dimension JSON alongside
the deployment change and repeat it after changing the embedding model, dimensions,
HNSW parameters, PostgreSQL/pgvector version, host class, or material filter shape.
