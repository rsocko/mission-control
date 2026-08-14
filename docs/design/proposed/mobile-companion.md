---
title: "Mobile Companion"
status: superseded
superseded_by: "[Mobile iOS Redesign](../active/mobile-ios-redesign.md)"
created: 2026-07-10
last_reviewed: 2026-07-28
category: design
related:
  - "[My Day Enhancements](MY-DAY-ENHANCEMENTS.md)"
  - "[Triage Queue](TRIAGE-QUEUE-DESIGN.md)"
  - "[Radial Clock View](RADIAL-CLOCK-VIEW-DESIGN.md)"
mockups:
  - "[mockup-mobile-companion.html](../mockups/mockup-mobile-companion.html)"
  - "[mockup-app-icons.html](../mockups/mockup-app-icons.html)"
---

> **SUPERSEDED** - This document has been replaced by the
> [Mobile iOS Redesign spec](../active/mobile-ios-redesign.md) which reflects
> the finalized 20-screen mockup design. Key changes: Inbox replaced by Quick Sort,
> More replaced by Houston AI, timeline-based Today replaced by priority-sorted list,
> hamburger drawer replaces More tab for secondary navigation.

# Mission Control Mobile Companion — Feature Design Spec

## Summary

Mission Control Mobile should be a **companion**, not a desktop clone.  
The mobile app focuses on fast, in-the-moment interactions:

1. **My Day (mobile-first execution)** — view, complete, reorder, and time-block today’s plan quickly
2. **Triage (queue reduction)** — swipe-based classify/defer/plan actions for backlog and inbound items
3. **Capture (frictionless intake)** — quick text, voice, and share-sheet capture into inbox/triage queue

## Product Principles

- **Execution over configuration**: prioritize doing work, not managing system settings
- **One-thumb ergonomics**: primary actions reachable in bottom-half UI
- **Fast decisions**: reduce each triage decision to a small set of high-confidence actions
- **Desktop continuity**: mobile changes sync immediately and appear in web views

## Scope

### In Scope (V1)

1. **My Day Mobile View**
   - Today timeline + unscheduled list
   - Complete, snooze, reprioritize, and move-to-tonight actions
   - “Add to Day” from suggestions (yesterday, overdue, due soon)

2. **Triage Mobile View**
   - Card stack for unprocessed items
   - Swipe/quick actions: Keep, Plan, Defer, Delegate, Archive
   - Filter chips by source, urgency, and effort
   - Bulk mode for low-risk queue cleanup

3. **Quick Capture**
   - Floating “+ Capture” action
   - Text, voice transcription, and share target ingestion
   - Optional “needs triage” flag on creation

4. **Notifications & Nudges**
   - Morning “Start My Day” prompt
   - Midday “Triage Queue > N items” nudge
   - End-of-day carry-forward reminder

### Out of Scope (V1)

- Full settings/connectors management
- Full dashboard analytics parity
- Complex project editing flows
- Deep AI chat surface parity with desktop assistant

## Information Architecture

Bottom tab model:

1. **Today** (default)
2. **Triage**
3. **Capture**
4. **Inbox**
5. **More** (settings-lite, account, sync health)

## Feature Outline

## 1) Today (My Day Companion)

### Core Jobs
- See what matters now
- Mark progress quickly
- Adjust plan in under 10 seconds

### Primary Components
- **Now/Next panel**: current time block + next item
- **Timeline strip**: compact schedule blocks and calendar ghost blocks
- **Unscheduled section**: drag/reorder and add-to-time-slot shortcuts
- **Suggestion tray**: Yesterday, Overdue, Due Soon, AI Picks

### Key Mobile Interactions
- Tap checkbox = complete
- Swipe right = complete, swipe left = options
- Long-press = quick plan (15/30/60 min)
- Pull-to-refresh = sync + re-score suggestions

## 2) Triage (Queue Reduction Engine)

### Core Jobs
- Reduce queue quickly
- Convert noise to clear outcomes
- Maintain inbox-zero style processing rhythm

### Primary Components
- **Queue card stack** with source badges and relevance hints
- **Decision rail**: Keep / Plan / Defer / Delegate / Archive
- **Filter chips**: Source, Priority, Due, Estimated effort
- **Session stats**: processed count, remaining, streak

### Key Mobile Interactions
- Swipe up = Keep
- Swipe right = Plan
- Swipe left = Defer
- Swipe down = Archive
- Tap “…” = full metadata and advanced actions

## 3) Capture (Mobile-Only Leverage)

### Core Jobs
- Capture ideas/tasks in context immediately
- Preserve context (source app, URL, timestamp, screenshot/attachment)

### Primary Components
- **Quick text entry** with natural-language parsing
- **Voice capture** with transcript preview
- **Share extension target** for browser/social/email capture
- **Context chips** (project, energy, due, source)

## 4) Inbox

### Purpose
- Lightweight review list of newly captured and newly synced items
- Entry point to open item detail or send to triage

## Functional Requirements

1. Mobile actions update the same task entities as web (`status`, scheduling, metadata)
2. Triaged decisions are idempotent and safe to replay after offline periods
3. App supports intermittent connectivity with optimistic UI and sync retry queue
4. Filters and sort preferences persist per user
5. Notification windows respect quiet hours and calendar busy blocks

## Non-Functional Requirements

- **Performance**: first meaningful paint under 2s on modern LTE
- **Responsiveness**: action feedback under 100ms for optimistic actions
- **Reliability**: offline queue durability across app restarts
- **Accessibility**: 44px tap targets, screen-reader labels, high-contrast mode support

## Data & API Alignment

Reuse existing task/triage APIs where possible; add only mobile-specific endpoints when necessary:

- `GET /api/my-day` + timeline shape (compact mode)
- `POST /api/triage/decision` (single)
- `POST /api/triage/decision/bulk` (batch)
- `POST /api/capture` (text/voice/share payload)
- `GET /api/mobile/summary` (Today + Queue counts + sync health)

## Rollout Phases

### Phase 1 — Companion Core
- Today tab + basic Triage + text Capture + Inbox
- Push notifications for morning start and queue threshold

### Phase 2 — Speed & Intelligence
- Swipe customization, smarter suggestion tray, bulk triage mode
- Voice capture and richer share ingest metadata

### Phase 3 — Advanced Mobility
- Offline-first triage sessions
- Context-aware nudges (location/time-window aware, optional)
- Wearable quick-complete hooks (future integration)

## Success Metrics

- Daily mobile active users / total active users
- Triage items processed per mobile session
- Time-to-inbox-zero (median)
- My Day completion rate delta (mobile users vs baseline)
- Capture-to-triage conversion rate

## Risks & Mitigations

- **Risk:** Mobile becomes over-scoped desktop clone  
  **Mitigation:** Enforce companion scope; keep heavy management in web

- **Risk:** Swipe actions create accidental destructive outcomes  
  **Mitigation:** Undo toast + safe defaults + confirmation for archive/delete

- **Risk:** Notification fatigue  
  **Mitigation:** Nudge caps, quiet hours, per-category controls
