# Search UX and Performance Redesign

**Issues:** #318, #334, #502

## Direction

Global search uses keyword retrieval as its primary, immediate contract. Optional
semantic search enriches already-visible keyword results; it never gates first
results, replaces exact matches, or turns a provider failure into a failed search.

Semantic enrichment is off by default. Users enable it in AI Settings and select
an embedding model independently from the completion model, including
Bifrost-qualified model IDs.

## Why search currently feels slow

The keyword branch uses the selected backend's search repository: PostgreSQL
full-text search for the approved production target or SQLite FTS5 for the
compatibility backend. Both are already fast. Hybrid mode joins keyword and
semantic work with `Promise.all`, so completed keyword results wait for route
resolution, a query embedding request, a scan of stored vectors, and metadata
loading. The task-list filter feels faster because it uses deterministic
filtering and cached React Query state without invoking an embedding provider.
See the
[database scaling and migration strategy](database-scaling-strategy.md) for
backend and deployment status.

Task and notification embeddings are persisted by the durable semantic index
(`semantic_documents`/`semantic_vectors`, issue #1664), maintained by the index
worker rather than by the request path. Only a previously unseen query phrase
must be embedded interactively. Repeated query vectors can be reused from a
bounded, process-local LRU/TTL cache keyed by normalized query and the active
index identity (its provider, model, dimensions, and projection version).

## Experience contract

1. Debounce once and request keyword results.
2. Render keyword results immediately and make them interactive.
3. If semantic enrichment is enabled and ready, request it independently.
4. Merge duplicates by entity identity while preserving keyword order,
   highlights, selection, preview, and scroll position.
5. Append semantic-only candidates as related results.
6. Preserve keyword results when semantic enrichment is unavailable, stale,
   aborted, timed out, or failed.
7. Abort superseded stages and reject stale responses by query revision.

Desktop retains its compact command palette and inline task preview. Mobile
retains its full-screen, touch-sized presentation. Both use the same staged search
state and result merge behavior.

## Server design

- Explicit `keyword` and `semantic` API modes remain compatible.
- Interactive semantic requests do not seed or rebuild the full entity index.
  Missing or stale indexes report readiness while keyword search remains usable.
- Entity indexing and rebuilds run as controlled background work.
- Query embeddings use a bounded memory-only cache with in-flight request
  coalescing. Failures and empty vectors are not cached.
- Query text and vectors are not persisted by default because that would create a
  durable search-history store requiring retention, deletion, and encryption
  policy.
- Search telemetry separates keyword first-result latency, semantic provider
  latency, scan duration, cache hits/misses, candidate counts, and failures.

## Settings

AI Settings exposes:

- **Enable semantic enrichment** (off by default)
- **Embedding model** (separate from the completion model)
- resolved provider/model and index readiness
- an explicit rebuild action when a model change makes the corpus incompatible

The global-search setting is feature-scoped. Disabling it does not remove semantic
infrastructure required by graph-neighbor features.

## Filters and relevance

Supported type, source, status, and completion filters are applied server-side to
both branches. Facets come from the authoritative search domain rather than only
the returned top-k rows. Overlapping task syntax should reuse the canonical task
filter grammar.

Ranking guarantees:

1. exact title keyword match
2. title prefix keyword match
3. other keyword match
4. keyword plus semantic match
5. semantic-only related result

Semantic scores may annotate keyword matches but do not displace strong lexical
matches.

## Performance gates

- Warm keyword API p95: at most 100 ms on the representative seeded dataset.
- Visible keyword results: at most 150 ms after debounce.
- Semantic work never delays keyword rendering.
- At most one provider embedding request per distinct uncached query.
- Repeated identical queries within TTL make no additional provider request.
- Rapid typing can publish results only for the latest query revision.
- Interactive requests never trigger a full entity-index rebuild.

## Delivery order

1. Progressive API contract and feature-scoped settings.
2. Background-only corpus readiness and bounded query-vector reuse.
3. Shared desktop/mobile staged-search orchestration.
4. Progressive result feedback and stable related-result merging.
5. Authoritative filters/facets and telemetry.
6. Unit, API, component, race, failure, and performance coverage.
