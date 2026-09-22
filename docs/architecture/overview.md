---
title: "Architecture Overview"
sidebar_label: Overview
sidebar_position: 1
status: active
created: 2026-06-15
last_reviewed: 2026-08-29
category: architecture
related:
  - "[Frontend](frontend.md)"
  - "[Data Model](data-model.md)"
  - "[Sync Engine](sync-engine.md)"
  - "[Connectors](connectors.md)"
  - "[AI Engine](ai-engine.md)"
  - "[Database Scaling Strategy](../design/active/database-scaling-strategy.md)"
---

# Mission Control — Architecture Overview

> Living architecture documentation. Update as the system evolves.

---

## High-Level System Architecture

This is the "30,000 foot" view — major subsystems as single blocks.

```mermaid
flowchart TB
  subgraph Clients["Clients"]
    Browser["Browser / PWA"]
    MCP["MCP client"]
  end

  subgraph Web["Web service - Next.js"]
    direction TB
    UI["React UI"]
    API["Route handlers<br/>API, SSE, full health"]
    Writes["Direct connector write-through"]
    WebFeatures["AI, rules, webhooks,<br/>push notifications"]
    WebMetrics["Runtime sampler"]
  end

  subgraph Worker["Exactly one sync worker replica - Node.js"]
    direction TB
    PollSchedules["Connector poll schedules"]
    QueueSchedules["Nightly full sync and watchdog"]
    Maintenance["Dependency resume and triage schedules"]
    QueueRunner["Sequential queue runner<br/>claim, lease, cancel, retry"]
    Pipeline["Connector pipeline<br/>pending pushes, pull, reconcile, index"]
    WorkerMetrics["Runtime sampler"]
  end

  subgraph Data["Configured relational backend"]
    Domain[("Domain tables")]
    Jobs[("sync_jobs<br/>leases, results, retries")]
    JobEvents[("sync_job_events<br/>durable SSE cursor")]
    Runtime[("runtime_telemetry<br/>web heartbeat and instance-scoped worker heartbeat")]
    DueTimes[("sync_schedules<br/>connector poll due times")]
  end

  Sources["External services<br/>Microsoft Graph, GitHub, Home Assistant,<br/>Monarch, RyMessage, REST, Document Intelligence"]

  Browser --> UI
  MCP --> API
  UI --> API
  API --> Domain
  API -->|"enqueue / deduplicate"| Jobs
  API -->|"poll terminal result"| Jobs
  API -->|"replay events after cursor"| JobEvents
  API --> WebFeatures
  Writes <--> Sources
  API --> Writes
  PollSchedules --> DueTimes
  PollSchedules --> Jobs
  QueueSchedules --> Jobs
  Maintenance --> Domain
  Maintenance <--> Sources
  QueueRunner -->|"transactional claim"| Jobs
  QueueRunner --> Pipeline
  Pipeline <--> Sources
  Pipeline --> Domain
  Pipeline --> JobEvents
  WebMetrics --> Runtime
  WorkerMetrics --> Runtime
```

PostgreSQL is the approved production target and is implemented as an explicit
runtime backend. SQLite remains the default compatibility backend and the
documented homelab backend until the maintenance-window cutover is completed.
See the
[database scaling and migration strategy](../design/active/database-scaling-strategy.md)
for the decision and deployment status.

Production sets `MC_SYNC_EXECUTION_MODE=worker`. The web and worker services use
the same image and database, but they are separate Node processes. Next.js owns
the API, UI, synchronous task write-through, and non-connector web features. The
worker owns connector polling and long-running connector work so event-loop or
CPU pressure in a sync cannot starve HTTP handling. Development defaults to the
legacy inline mode unless worker mode is explicitly enabled.

The supported production topology has exactly one sequential worker replica.
Lease ownership fences durable queue updates, but it cannot stop external
connector side effects that may still be running in a stalled predecessor after
takeover. Fixed Compose container names prevent scaling, and worker startup
rejects `MC_SYNC_WORKER_REPLICA_COUNT` values other than `1`.

---

## Data Flow — Sync Cycle

How data moves between external sources and the configured relational backend.

```mermaid
sequenceDiagram
  actor User
  participant Web as Next.js web
  participant DB as Configured relational backend
  participant Worker as Sync worker
  participant Src as External source

  User->>Web: POST /api/sync
  Web->>DB: Transactional enqueue or deduplicate
  DB-->>Web: Durable job ID
  Note over Web: Durable routing does not load or run the connector
  Worker->>DB: Transactional claim and lease
  DB-->>Worker: Owned job
  Worker->>DB: Renew lease / read cancellation
  Worker->>Src: Retry pending writes, then pull
  Src-->>Worker: Tasks, notifications, lists
  Worker->>DB: Upsert domain data and sync_log
  Worker->>DB: Append monotonic sync_job_events
  Worker->>DB: Owner-qualified complete or retry
  Web->>DB: Poll terminal result
  DB-->>Web: Sync result
  Web-->>User: Compatible synchronous response
  User->>Web: GET /api/sync/stream with cursor
  Web->>DB: Read events after cursor
  Web-->>User: SSE events with durable IDs

  Note over User,Src: Task create/update/delete routes still perform immediate connector write-through in the web process.
```

---

## Key Subsystems (Detail Diagrams)

| Subsystem | Purpose | Detail Doc |
|-----------|---------|------------|
| Connectors | Adapters for external data sources | [connectors.md](./connectors.md) |
| Sync Engine | Durable connector scheduling and execution | [sync-engine.md](./sync-engine.md) |
| AI Engine | Chat, agents, background tasks | [ai-engine.md](./ai-engine.md) |
| Frontend | Pages, components, client state | [frontend.md](./frontend.md) |
| Data Model | Schema, tables, relationships | [data-model.md](./data-model.md) |

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js (App Router) |
| Language | TypeScript |
| UI | React, Tailwind CSS, Lucide Icons |
| Database | PostgreSQL (approved production target) or SQLite (default compatibility backend), selected explicitly at runtime |
| AI | Vercel AI SDK (multi-provider) |
| Auth | Microsoft OAuth2 (multi-tenant) |
| Scheduling | node-cron; connector sync schedules run in the worker, push-notification schedules in the web process |
| Testing | Vitest + Playwright |
| Deployment | Docker / Docker Compose |
| PWA | Serwist (Service Worker) |
| MCP | stdio-based MCP server (tsx) |
