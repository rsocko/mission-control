---
title: "Semantic Entity Projection Contract"
status: implemented
created: 2026-08-29
category: design
related:
  - "./architecture.md"
  - "./roadmap.md"
  - "https://github.com/rsocko/mission-control/issues/1667"
  - "https://github.com/rsocko/mission-control/issues/1665"
---

# Semantic Entity Projection Contract

Mission Control projects authoritative domain records through pure, versioned
adapters in `src/lib/semantic-index/projections`. Projection version 2 enables
tasks, projects, canonical tags, triage items, and alerts. Houston summaries are
not registered.

## Shared contract

- Inline whitespace is collapsed; block text retains single paragraph breaks.
- Titles are limited to 300 UTF-16 code units, bodies to 2,000, keywords to 24
  unique lower-case values of at most 64 code units.
- Embedding input contains only title, keywords, and body. Weighting is explicit:
  title 3, keywords 2, body 1. Metadata, identifiers, revisions, URLs, and raw
  connector payloads are not embedded.
- `sourceRevision` is SHA-256 over every authoritative field read by an adapter.
  `contentFingerprint` is SHA-256 over the normalized projection, sensitivity,
  retention, entity identity, and projection version. Ordering is canonical.
- Navigation targets are generated from the authoritative entity ID. Consumers
  must still resolve the entity through its domain read path; projections are
  never used to reconstruct records or authorize navigation.
- Sensitivity is resolved through the existing AI routing policy before provider
  egress. Repository queries filter allowed sensitivity tiers before scoring or
  result counts.

## Enabled adapters

| Kind | Embedding text | Keyword fields | Metadata and eligibility |
|---|---|---|---|
| Task | title; description | tag and project names, status, micro-status, planning horizon, source list, connector | status, priority, effort, source/list, checklist and parent fields; authoritative task row |
| Project | name; description; at most five representative task titles | project tags, status, override, category | status, category, target date, task count; hidden projects excluded |
| Tag | label; at most five representative task titles | slug, tag type, connector source | usage count, canonicalization fields; unconfirmed and unified alias tags excluded |
| Triage item | AI summary then description, limited to 1,200 code units | AI categories, platform, content type, status, urgency | platform, state, urgency, relevance; dismissed items excluded; URLs and raw metadata omitted |
| Alert/event | title; minimized summary limited to 600 code units | severity, category, connector, disposition, source state | state, severity, actionability, related entity IDs, expiry; deleted/stale source records excluded |

Representative records are selected in ascending stable ID order. Related counts
and timestamps participate in `sourceRevision`, while freshness uses only a
stable authoritative entity timestamp (project `updatedAt`, tag `createdAt`,
and triage `ingestedAt`). At write time, the worker widens this with the
durable intent request timestamp, providing monotonic stale-write ordering
even when a legacy domain table has no update column. Removing a relation
therefore cannot make a source revision appear older. Only bounded
representative labels enter embedding text.
Aggregate sensitivity is the most restrictive policy result across Mission
Control and every connector that contributed a representative task.

## Lifecycle and readiness

All enabled kinds use the #1664 lifecycle without a second write path:

1. create and update publish a coalescing upsert intent;
2. delete publishes a delete intent;
3. the worker rereads the authoritative source and treats a missing or ineligible
   record as deleted; direct ID reads retain ineligible records with
   `semanticEligible: false` so the tombstone keeps the authoritative source
   timestamp and the record can become eligible again at the same revision;
4. backfill and reconciliation walk kinds in the documented risk order with
   stable keyset checkpoints and publish the same intents;
5. expiry tombstones documents and removes vectors; and
6. project, tag, triage capture/action/classification, and lifecycle mutation
   paths publish after their authoritative transaction commits; and
7. retrieval excludes tombstones, expired rows, stale document/vector pairs,
   incompatible identities, disallowed sensitivity tiers, and denied records
   before scoring.

Readiness remains reported independently for every semantic entity kind. A
partially backfilled kind therefore exposes its own document, vector, stale,
incompatible, and expired counts rather than borrowing the aggregate state.

SQLite and PostgreSQL use the same source fields, eligibility predicates,
ordering, representative limits, projection functions, and repository contract.
The existing bounded in-process vector scan limitation is unchanged and remains
the explicit scale limitation tracked by #1663.

## Houston limitation

`houston-summary` remains a recognized storage namespace but is deliberately not
an enabled source kind or projection adapter. Mission Control does not yet have
the #1665 authoritative retained-summary record, configurable retention,
per-conversation exclusion, deletion reconciliation, or conversation
authorization contract. Backfills cannot visit Houston records and manually
queued Houston intents fail closed as unsupported. Full transcripts are never
used as a fallback.
