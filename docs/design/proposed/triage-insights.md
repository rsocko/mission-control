# Triage Insights — AI-Powered Content Analysis & Action Engine

## Problem Statement

Users accumulate hundreds of saved/bookmarked items across platforms (Reddit, Instagram, YouTube, etc.) but lack the ability to:
1. **Find patterns** — "What have I saved about UX?" requires manual scrolling
2. **Extract actionable learnings** — A saved post contains tips, but those tips aren't surfaced as discrete actions
3. **Turn insights into work** — No bridge from "interesting content" → "task I'll actually do"

The Triage Queue currently treats items individually. This feature adds a **batch analysis layer** that groups, scores, summarizes, and enables bulk action on content themes.

## User Stories

- "Show me everything I've saved about improving app UX" → grouped digest with key learnings
- "Turn these 5 CSS tips into a task checklist I can work through" → task/template creation
- "What patterns exist in my saved content?" → category discovery across sources
- "Give me a weekly digest of high-value dev content I saved" → scheduled analysis

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Triage Queue DB                          │
│  (triage_items: title, description, aiCategories, source, etc.) │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Analysis Engine     │
                    │  (AI-powered)        │
                    │                      │
                    │  • Semantic grouping  │
                    │  • Value scoring      │
                    │  • Learning extract   │
                    │  • Action suggestion  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌──────▼──────┐
     │  Digest View   │ │  Houston   │ │  MCP Tool   │
     │  (Triage UI)   │ │  (Chat)    │ │  (Agents)   │
     └────────┬───────┘ └─────┬──────┘ └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Action Outcomes     │
                    │                      │
                    │  • Create task        │
                    │  • Create template    │
                    │  • Bulk dismiss       │
                    │  • Save to KB         │
                    │  • Schedule follow-up │
                    └─────────────────────┘
```

## Feature: Insights Digest

### What It Is

A new view (accessible from Triage Queue or Houston) that runs an AI analysis across a subset of triage items and presents:

1. **Grouped results** — Semantic clusters, not just source-platform buckets
2. **Value/relevance scoring** — "How actionable is this for me?"
3. **Key learnings extraction** — Discrete tips/patterns pulled from content
4. **Action affordances** — One-click: Create Task, Create Template, Dismiss, Save to KB

### UI Entry Points

| Entry Point | Trigger |
|-------------|---------|
| Triage Queue toolbar | "Analyze" button → opens Insights panel |
| Houston chat | "Analyze my saved dev content" → streams digest |
| MCP tool | `mc_analyze_triage` → returns structured analysis |
| Scheduled workflow | Weekly "New Insights" digest notification |

### Digest Structure

```typescript
interface InsightsDigest {
  id: string;
  query: string;                    // What was asked
  createdAt: string;
  totalScanned: number;
  totalMatched: number;
  
  groups: InsightGroup[];
}

interface InsightGroup {
  id: string;
  name: string;                     // "Vibe-Coding & App UX"
  description: string;              // "Tips for making AI-built apps look professional"
  icon: string;                     // Lucide icon
  items: InsightItem[];
  keyLearnings: string[];           // Extracted discrete tips
  suggestedActions: SuggestedGroupAction[];
}

interface InsightItem {
  triageItemId: string;
  title: string;
  url: string;
  sourcePlatform: TriageSourcePlatform;
  valueScore: number;               // 0-10
  contentType: 'tip' | 'tutorial' | 'tool' | 'reference' | 'discussion';
  extractedLearnings: string[];     // Individual tips pulled from this item
}

interface SuggestedGroupAction {
  type: 'create_task' | 'create_template' | 'create_checklist' | 'save_to_kb';
  label: string;                    // "Create UX Audit Checklist from these 8 tips"
  description: string;
  prefilledData: Record<string, unknown>;  // Pre-filled task/template data
}
```

## Feature: Action Outcomes

### 1. Create Task

Single item → task. Pre-fills:
- Title: "Apply: {learning}" or "Explore: {tool name}"
- Description: Source URL + extracted context
- Tags: Auto-derived from insight group

### 2. Create Template

Pattern recognition: "You have 6 items about loading states" → 
- Template: "Loading State Implementation Checklist"
- Subtasks auto-generated from extracted learnings:
  - [ ] Add skeleton screens to data-fetching views
  - [ ] Implement optimistic updates for mutations
  - [ ] Add progress indicators for file uploads
  - [ ] Handle empty states gracefully

### 3. Create Checklist (Bulk)

Multiple items in a group → single task with checklist subtasks:
- "CSS Patterns to Implement" with each pattern as a subtask
- Links to source content in each subtask description

### 4. Save to Knowledge Base

Route high-value content to long-term reference storage (Karakeep / internal KB).

### 5. Bulk Dismiss

"I've seen these, they're not actionable" → dismiss entire group or filtered set.

## Feature: Scheduled Digest

### Weekly "What's New" Analysis

Runs automatically on newly-ingested items since last digest:
- Groups new content by theme
- Highlights items scoring 5+ value
- Pushes notification: "12 new dev/UX items saved this week — 3 high-value"
- One-tap to open digest view

### Configuration

```typescript
interface DigestConfig {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  topics: string[];          // User-defined interest areas
  minValueScore: number;     // Only include items >= this score
  sourcePlatforms: TriageSourcePlatform[];  // Which sources to analyze
  deliveryMethod: 'in_app' | 'push' | 'email';
}
```

## Implementation Plan

### Phase 1: Analysis Engine + MCP Tool (2-3 days)

- [ ] `POST /api/triage/analyze` endpoint
  - Accepts: query string, source filter, date range
  - Returns: InsightsDigest JSON
  - Uses LLM to: group items semantically, score value, extract learnings
- [ ] `mc_analyze_triage` MCP tool wrapping the endpoint
- [ ] Houston integration: "analyze my saved..." triggers the endpoint

### Phase 2: Digest UI in Triage View (3-4 days)

- [ ] "Insights" tab/panel in Triage Queue page
- [ ] Group cards with expand/collapse
- [ ] Value score badges + sorting
- [ ] "Key Learnings" extraction display
- [ ] Item cards with source embeds (Instagram iframe, Reddit preview)
- [ ] Filter bar: by group, value, source, content type

### Phase 3: Action Engine (2-3 days)

- [ ] "Create Task" flow from insight item (pre-filled)
- [ ] "Create Template" flow from insight group
- [ ] "Create Checklist" bulk action
- [ ] "Save to KB" action (Karakeep integration exists)
- [ ] "Bulk Dismiss" with confirmation
- [ ] Action history: "You created 3 tasks from last week's digest"

### Phase 4: Scheduled Digests (1-2 days)

- [ ] Digest cron job (reuse existing triage cron infrastructure)
- [ ] DigestConfig in settings
- [ ] Push notification for new digest
- [ ] Digest history (past digests viewable)

## UI Mockup — Triage Insights Panel

```
┌─────────────────────────────────────────────────────────────┐
│ Triage Queue                              [Insights] [+Add] │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Analysis: "Software dev, UX, vibe-coding tips"          │ │
│ │ 512 matches from 1,987 items · 60 high-value            │ │
│ │ [All] [High Value 5+] [Instagram] [Reddit]              │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─── ✨ Vibe-Coding & App UX (34) ───────────────────────┐ │
│ │ Key Learnings:                                          │ │
│ │ • 5 ways your vibecoded app is slow                     │ │
│ │ • Make your UI look less vibecoded (series)             │ │
│ │ • Loading states matter more than you think             │ │
│ │                                                         │ │
│ │ [Create "UX for Vibe-Coded Apps" Checklist]             │ │
│ │                                                         │ │
│ │ ┌─────────────────────────────────────────────────┐     │ │
│ │ │ 🟣 IG  8/10  5 ways your vibecoded app is slow  │     │ │
│ │ │ Tips: lazy loading, code splitting, image opt... │     │ │
│ │ │                    [+ Task] [Template] [Dismiss] │     │ │
│ │ └─────────────────────────────────────────────────┘     │ │
│ │ ┌─────────────────────────────────────────────────┐     │ │
│ │ │ 🟣 IG  7/10  Building with Good UX (Part 2)     │     │ │
│ │ │ Tips: skeleton screens, progressive disclosure  │     │ │
│ │ │                    [+ Task] [Template] [Dismiss] │     │ │
│ │ └─────────────────────────────────────────────────┘     │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─── 🎨 Frontend & UX Patterns (87) ────────────────────┐  │
│ │ ...                                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Houston Integration

Houston can trigger and display analyses conversationally:

```
User: "What have I saved about making apps feel more polished?"

Houston: I analyzed 1,987 items in your triage queue and found 
         34 items about app polish and UX quality. Here's the breakdown:

         ✨ Vibe-Coding & App UX (12 items, avg value 6.2/10)
         Key tips:
         1. Use loading skeletons, not spinners
         2. Add micro-interactions on state changes
         3. CSS clamp() for responsive typography
         4. oklch color space for perceptually uniform gradients
         5. Implement optimistic updates for perceived speed

         🎨 Frontend Patterns (22 items, avg value 4.8/10)
         Key tips:
         1. Floating labels with smooth transitions
         2. Scroll fade masks with CSS mask-image
         3. Design tokens over hardcoded values
         ...

         Would you like me to:
         • Create a "Polish My App" checklist task from these tips?
         • Save the key learnings to your knowledge base?
         • Show me more items in a specific group?
```

## Genericization: "Smart Lenses"

The analysis engine should be generic — not hardcoded to "dev/UX content." 
Users define **Lenses** — saved analysis configurations:

```typescript
interface Lens {
  id: string;
  name: string;                    // "Dev & UX Tips"
  description: string;
  query: string;                   // Natural language or structured
  sourcePlatforms: TriageSourcePlatform[];
  dateRange?: { from: string; to: string };
  minScore?: number;
  autoSchedule?: DigestConfig;     // Optional: run this lens on a schedule
}
```

Preset lenses:
- "Dev & UX Tips" — software development guidance
- "Tools & Repos to Try" — open source tools worth exploring
- "Home Automation Ideas" — HA/IoT project inspiration
- "Content to Revisit" — high-score items not yet actioned

Users create custom lenses via Houston: "Create a lens for 3D printing techniques I've saved"

## Open Questions

1. **LLM cost:** Full analysis of 500+ items requires either batching or pre-computed embeddings. Should we embed at ingest time?
2. **Freshness:** Should digests only show new-since-last-viewed items, or re-analyze everything?
3. **Template marketplace:** If templates are useful, should users be able to share them?
4. **Cross-source dedup:** Same content saved on both Reddit and Instagram — merge or show both?

## Related Existing Infrastructure

- `src/lib/triage/suggestion-engine.ts` — Rule-based scoring (extend for value scoring)
- `src/lib/triage/content-type-registry.ts` — Content type detection (extend for content nature)
- `src/app/api/triage/digest/route.ts` — Existing digest infrastructure (extend for insights)
- `src/mcp/tools/triage.ts` — MCP search tool (extend with `mc_analyze_triage`)
- `src/components/ai/AIChatTab.tsx` — Houston UI (add tool-call for analysis)
