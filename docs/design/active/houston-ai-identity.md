---
title: "Houston: AI Assistant Identity"
sidebar_label: Houston Identity
sidebar_position: 20
---

# Houston — AI Assistant Identity

## Overview

Mission Control's AI assistant is named **Houston** — a direct reference to NASA's Mission Control Center in Houston, Texas. Just as astronauts contact "Houston" for support, guidance, and problem-solving, users contact Houston for task management assistance, planning, and insights.

Houston is primarily a **user-facing assistant identity and policy-aware
interaction surface**, not a promise that one autonomous runtime owns every
request. Houston can answer directly, use bounded MC tools, invoke a
deterministic workflow, or delegate durable work through MC's external-agent
control plane.

## Why "Houston"

- **Instantly recognizable** — "Houston, we have a problem" is universally known
- **Perfect fit** — the app is literally called Mission Control
- **Natural in conversation** — "Ask Houston", "Houston says…", "Houston flagged this"
- **Personality built-in** — calm, competent, supportive, always available
- **Scalable metaphor** — NASA Mission Control has many roles, giving us a naming system for sub-agents

## Capability hierarchy

Houston is the primary user-facing coordinator. As the system grows,
specialized capability roles handle delegated work:

### Primary Assistant

| Name | Role | Description |
|------|------|-------------|
| **Houston** | User-facing coordinator | Receives requests, explains recommendations, obtains approval, and routes work through MC policy. |

### Sub-Agents (Active / Near-term)

| Name | NASA Role | Agent Role | Examples |
|------|-----------|------------|----------|
| **CAPCOM** | Capsule Communicator | Communications & Messaging | Notifications, summaries, status updates, daily digests |
| **Flight** | Flight Director | Decisions & Workflow | Task planning, prioritization, approvals, scheduling |

### Sub-Agents (Future / Planned)

| Name | Inspiration | Agent Role | Examples |
|------|-------------|------------|----------|
| **Orbit** | Orbital mechanics | Monitoring & Observability | Watching metrics, tracking progress, pattern detection |
| **Relay** | Communication relay | Integrations & Data | Syncing between systems, API calls, webhook handling |
| **Beacon** | Guidance signal | Alerts & Anomaly Detection | Proactive warnings, deadline risks, blocked-task detection |
| **Atlas** | Atlas rocket program | Heavy Processing | Bulk operations, data migration, large-scale categorization |

## Interaction Model

```
User → Houston (coordinator)
           ├── Direct answer (simple queries)
           ├── CAPCOM (communication tasks)
           ├── Flight (planning/prioritization)
           ├── Orbit (monitoring requests)
           ├── Relay (integration actions)
           ├── Beacon (alert/anomaly reports)
           └── Atlas (bulk processing)
```

In the UI, Houston is always the conversational partner. Capability roles
appear as attributed actions:
- "Houston routed this to Flight for prioritization"
- "Beacon flagged 2 tasks at risk of missing their deadline"
- "CAPCOM prepared your morning digest"

These names are product attribution, not fixed deployment topology. A role may
map to a built-in MC operation, bounded model call, n8n workflow, Scout,
direct external executor, or Paperclip agent. The UI must also show the real
executor and locality whenever work leaves Houston's conversation.

## Houston and Paperclip

Houston and Paperclip are complementary:

| Concern | Owner |
|---|---|
| Conversation, intent clarification, recommendations, and explanation | Houston |
| MC source authority, disclosure policy, approval, durable dispatch, and receipts | Mission Control |
| Multi-agent decomposition, internal issue assignment, budgets, and agent runs | Paperclip |
| Actual repository, M365, workflow, or general-purpose execution | Copilot, Scout, n8n, OpenClaw, or another runtime |

Houston should **not** become a Paperclip agent by default. Keeping Houston in
MC preserves a responsive chat surface and prevents Paperclip's internal
lifecycle from becoming the authority for ordinary MC conversation or task
changes.

An optional Paperclip agent such as **Mission Control Coordinator** may be
useful for durable background work. It should:

- claim only explicitly delegated MC dispatches or a narrowly scoped queue;
- receive the minimum required task/project context;
- propose reprioritization, decomposition, or scheduling changes for review;
- call allowlisted MC tools through a scoped identity;
- return correlated progress, blockers, artifacts, and receipts.

It must not continuously pull arbitrary MC work, silently reprioritize
projects, or mutate source-owned fields. Repeated automation requires an
explicit rule, bounded scope, budget, and approval policy.

```text
User -> Houston
          |-> answer or read inside MC
          |-> bounded MC action with policy
          |-> direct executor dispatch
          `-> Paperclip parent issue
                 `-> Paperclip coordinator and specialist agents
                        `-> correlated result back to MC
```

## Visual Identity

### Icon / Avatar

Houston uses a **headset** icon (🎧) — representing the CAPCOM/Flight Controller wearing a headset at their console. This replaces the generic robot emoji (🤖) to give Houston a distinct, human-feeling identity that aligns with the NASA metaphor.

Alternative considerations:
- 🛰️ Satellite — too generic/space-y
- 🚀 Rocket — implies launching, not supporting
- 🎧 Headset — **chosen** — evokes the controller at their station
- 📡 Dish — good for Relay sub-agent specifically

### Color Palette

Houston's accent uses the existing blue-to-purple gradient (`from-blue-500 to-purple-600`), which evokes the space theme while staying consistent with the app's design system.

### Tone of Voice

Houston should communicate like a calm, competent flight controller:
- **Concise** — no filler, straight to the point
- **Confident** — clear recommendations, not wishy-washy
- **Supportive** — "Roger that", "Copy", acknowledgment before action
- **Professional but warm** — not robotic, not overly casual

Example greetings:
- "Houston here. What can I help you with?"
- "Ready for your briefing. What's on the agenda?"
- "All systems nominal. How can I assist?"

### Spoken Voice

Houston's spoken identity should be original, provider-neutral, and explicitly
licensed for synthetic speech. The target is a warm, dry, unflappable strategic
adviser rather than an imitation of a celebrity or fictional character.

Start with a local stock voice, then develop a designed voice or commission a
performer under a digital-replica agreement. A recognizable performer or
character voice is allowed only after the performer and all applicable
character or franchise rights holders approve the interactive-assistant use in
writing.

See [Houston Synthetic Voice Strategy](houston-voice-strategy.md) for the
technical options, Azure voice services, licensing constraints, and delivery
plan.

## Implementation Phases

### Phase 1 — Identity (Current)
- [x] Document naming architecture
- [ ] Replace robot icon with headset on AI landing page
- [ ] Rename "AI Assistant" heading to "Houston"
- [ ] Update empty-state copy with Houston personality

### Phase 2 — Personality
- [ ] Update system prompt to use Houston persona
- [ ] Add Houston-flavored greeting messages
- [ ] Update suggestion chips to match tone

### Phase 3 — Sub-Agent Attribution
- [ ] Show sub-agent names when Houston delegates
- [ ] Agents tab displays named agents with their roles
- [ ] Background task labels include agent names

### Phase 4 — Spoken Voice
- [ ] Add a provider-neutral streaming TTS boundary
- [ ] Ship a local stock voice with an offline fallback
- [ ] Evaluate an original designed or contracted Houston voice
- [ ] Add consent, provenance, disclosure, and retention controls

## Related

- [Houston Synthetic Voice Strategy](houston-voice-strategy.md)
- [AI Assistant Feature](../../features/ai-assistant.md)
- [Architecture: AI Engine](../../architecture/ai-engine.md)
- [External Agent Integration](../proposed/external-agent-integration.md)
- [Paperclip Adoption and Integration](../proposed/paperclip-adoption-and-integration.md)
- [Scout Smart Connector](../proposed/scout-smart-connector.md)
