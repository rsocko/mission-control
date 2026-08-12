---
title: AI Assistant
sidebar_label: AI Assistant
sidebar_position: 10
route: /ai
---

# AI Assistant

A multi-tab AI interface combining chat, background agents, and analytical insights.

## Purpose

Natural language interface to your task data. Ask questions, give commands, get summaries, and let AI agents handle background work like categorization and prioritization.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Tabs: [Chat] [Agents] [Insights]                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Chat Tab:                                                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  User: What's overdue this week?                         ││
│  │                                                          ││
│  │  Assistant: You have 3 overdue tasks:                    ││
│  │  1. Fix login bug (GitHub, due Jul 18)                   ││
│  │  2. Review PR #42 (GitHub, due Jul 19)                   ││
│  │  3. Order 3D filament (Todo, due Jul 20)                 ││
│  │                                                          ││
│  │  Sidebar Result (when applicable):                       ││
│  │  [Task list / action confirmation]                       ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  [Message input]                              [Send]     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Key Behaviors

### Chat Tab
- **Conversational queries** — Ask about tasks, deadlines, workload in natural language
- **Action execution** — "Create a task to...", "Complete task X", "Move Y to next week"
- **Summaries** — "Weekly summary", "What did I accomplish yesterday?"
- **Streaming responses** — Real-time token streaming with JSON event parsing
- **Message history** — Cached locally, persists across page navigations
- **Sidebar results** — Structured data (task lists, confirmations) shown alongside chat
- **Provider info** — Shows active AI model and provider

### Agents Tab
- **Background AI tasks** — Long-running operations that process in the background
- **Task status** — View running/completed/failed background tasks
- **Examples**: Bulk categorization, smart scoring recalculation, triage processing
- **Bounded maintenance** — Each bulk maintenance run scans at most 101 rows (including one lookahead), mutates at most 100 rows, runs for at most 5 seconds, and returns at most 20 detail records. Larger workloads persist a deterministic checkpoint and resume on the next invocation. Duplicate concurrent runs of the same agent are rejected.

### Insights Tab
- **AI-generated analysis** — Deeper analytical insights about productivity patterns
- **Project-aware** — Understands hub project context for relevant suggestions
- **Proactive recommendations** — Surfaces things you might not think to ask about

### AI Tools (available to the chat model)
The AI has access to tools for:
- Querying tasks (filter, search, aggregate)
- Creating and updating tasks
- Managing project assignments
- Analyzing completion patterns
- Suggesting priorities and schedules

### Provider Configuration
- Multi-provider support via Vercel AI SDK
- Configurable in Settings (OpenAI, Azure, Ollama)
- Model selection affects quality/speed tradeoff

## Data Sources

- Full task database (read + write access via tools)
- Project and list metadata
- Completion history for pattern analysis
- Provider configuration from settings

## Related

- [Architecture: AI Engine](../architecture/ai-engine.md)
- [Design: AI Assistant Completion](../design/active/ai-assistant-completion.md)
- [Design: External Agent Integration](../design/proposed/external-agent-integration.md)
