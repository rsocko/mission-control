---
title: "Insights Page"
status: proposed
created: 2026-07-10
last_reviewed: 2026-07-19
category: design
issues: ["#116"]
related:
  - "[Dashboard KPI Customization](DASHBOARD-KPI-CUSTOMIZATION.md)"
  - "[Go-Forward Plan](Mission%20Control%20—%20Go-Forward%20Plan.md)"
  - "[AI Assistant Completion](AI-ASSISTANT-COMPLETION-DESIGN.md)"
mockups:
  - "[mockup-insights-page.html](../mockups/mockup-insights-page.html)"
  - "[mockup-insights-feed.html](../mockups/mockup-insights-feed.html)"
  - "[mockup-ai-weekly-summary.html](../mockups/mockup-ai-weekly-summary.html)"
---

# Insights Page Design — #116

## Recommendation: YES — Build a Dedicated /insights Page

### Why

Based on competitive analysis of 10+ tools (Azure DevOps, Jira, Todoist, Linear, Asana, ClickUp, Sunsama, Akiflow, Motion, Notion, Planner, Things 3), the strongest pattern is:

> **Dashboard = present tense ("what is the state of work right now?")**
> **Insights = past tense ("how has work been going over time?")**

Every tool with respected analytics maintains this separation (Linear, Azure DevOps, Todoist, Asana). Tools that skip it (Things 3, basic Planner) are consistently criticized for lacking visibility.

**Key differentiator for Mission Control:** Most enterprise tools (Jira, Azure DevOps, Asana) are team-first — individual analytics require filtering by assignee. Most solo tools (Things 3, basic Todoist) offer minimal data. **There's a gap for individual-focused, ADHD-friendly productivity analytics** that don't require team scaffolding.

### What NOT to Do

Per PRODUCT.md anti-references and research:
- ❌ No gamification (no karma scores, no XP, no levels — Todoist anti-pattern)
- ❌ No guided wizards / multi-step rituals (Sunsama's approach is compelling but conflicts with "no ceremony" philosophy)
- ❌ No team management views (workload charts, member comparisons)
- ❌ No export to Power BI / data warehouse (over-engineering for solo use)

## Page Architecture

The /insights page is a **read-only analytics surface** — no task management actions happen here. It's organized into four zones:

### Zone 1: Period Summary KPIs (top bar)
Five summary stats for the selected period, with delta comparisons:
- **Completed** — tasks finished this period (+ % change vs prior period)
- **Created** — tasks created this period
- **Net Change** — completed minus created (backlog growing or shrinking)
- **Avg Task Age** — mean time from creation to completion
- **Streak** — consecutive active days (with 7-day dot indicator)

### Zone 2: Completion Trend + Source Breakdown
- **Completion Trend** — bar chart showing daily completed vs created, grouped by day of week. 7/30/90 day periods.
- **Completions by Source** — horizontal bar breakdown: Microsoft Todo, GitHub, Email, Calendar, etc.

### Zone 3: Task Age Distribution + AI Observations
- **Open Task Age** — histogram of open task ages (<1 day, 1-7 days, 8-30 days, 30+ days) with action link for stale items
- **AI Observations** — 3 insight cards surfaced by AI analysis:
  - **Pattern** insights ("Fridays are your most productive day")
  - **Stale Work** alerts ("5 tasks haven't moved in 30+ days")
  - **Balance** observations ("GitHub completions dropped 50%")

### Zone 4: Routines + Projects
- **Routine Completion Heatmap** — week-day grid per routine showing completion status
- **Project Velocity** — per-project done/open delta for the period

## Period Selector

Top-right tabs: **7 days** | **30 days** | **90 days**

All charts and KPIs respond to period selection. The default is 7 days. Longer periods provide trend depth without overwhelming the solo user.

## Data Dependencies

All data comes from the **shared stats engine** (`src/lib/stats/index.ts`) plus a few new computations:

| Widget | Data Source | Status |
|--------|-------------|--------|
| Completed / Created / Net | Task created_at + completed_at aggregation | 🔧 New computation |
| Avg Task Age | `date(completed_at) - date(created_at)` average | 🔧 New computation |
| Streak | `computeKpi('streak')` | ✅ Stats engine |
| Completion Trend Chart | Daily completed + created counts | 🔧 New computation |
| Source Breakdown | Group completions by connector_type | 🔧 New computation |
| Task Age Distribution | Group open tasks by age buckets | 🔧 New computation |
| AI Observations | `/api/ai/insights-observations` (new endpoint) | 🔧 New |
| Routine Heatmap | `/api/routines` with completion data | ✅ Exists |
| Project Velocity | Task completions grouped by project, period delta | 🔧 New computation |

## Relationship to Insights Sidebar Panel

The existing **AIInsightsPanel** (sidebar) and the **/insights page** serve different purposes:

| Aspect | Sidebar Panel | /insights Page |
|--------|---------------|----------------|
| Location | Right sidebar on dashboard | Dedicated route |
| Purpose | Actionable nudges (apply, dismiss, do it) | Read-only analytics |
| Content | AI suggestions about specific tasks | Aggregate trends and patterns |
| Interaction | Button-driven (apply, dismiss, date it) | Passive viewing + period selection |
| Data depth | Current state observations | Historical trend analysis |

**Both should be built.** The sidebar panel drives daily actions; the insights page drives weekly/monthly reflection.

## Implementation Phases

### Phase 1: Core Page (MVP)
- Route: `/insights`
- Period selector (7/30/90 days)
- 5 summary KPIs with deltas
- Completion trend bar chart
- Source breakdown

### Phase 2: Depth
- Task age distribution
- Routine completion heatmap
- Project velocity

### Phase 3: AI Layer
- AI observations feed (reuses existing AI infrastructure)
- Pattern detection (productive days, stale work, source balance)

#### Phase 3 Implementation Details

**Pattern Detection Engine** (`src/lib/stats/observations.ts`)

Five deterministic rule-based detectors run against the `InsightsSnapshot`:

| Detector | Signal | Threshold |
|----------|--------|-----------|
| Day-of-week productivity | Completion counts by weekday | 40%+ above average |
| Stale work | Open tasks in 30+ day age bucket | Any count > 0 |
| Source balance shift | Connector completion ratio vs prior period | 40%+ drop |
| Streak monitoring | Current streak value + previous | ≥7 days (positive) or reset from ≥5 |
| Workload imbalance | Created vs completed ratio | Created ≥ 2× completed |

Detectors are prioritized: warnings → info → positive. Capped at 3 observations.

**LLM Enrichment** (optional, graceful degradation)

When fewer than 3 rule-based observations fire, the engine passes the analytics snapshot to the configured LLM (via `@ai-sdk/openai` + provider factory) with a structured prompt requesting 2-3 natural-language observations. Falls back silently if AI is not configured or errors.

**Merge strategy:** Rule-based observations take priority slots; LLM fills remaining (up to 3 total), avoiding duplicate types.

## Charting Library

The app currently has no charting library. Options:
- **Recharts** — React-native, good for bar/line/pie, lightweight
- **Victory** — Flexible, good dark theme support
- **Custom SVG** — Sparklines already use inline SVG in KpiCard; could extend

Recommendation: **Recharts** — minimal footprint, active maintenance, SSR-safe.
