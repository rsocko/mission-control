---
title: "Radial Clock View & MCP Tool Exposure"
status: proposed
created: 2026-07-12
last_reviewed: 2026-07-12
category: design
related:
  - "[My Day Enhancements](MY-DAY-ENHANCEMENTS.md)"
  - "[Wave Planning](WAVE-PLANNING-DESIGN.md)"
inspiration: "[Reassign.app](https://reassign.app/) by [@leospanovic](https://twitter.com/leospanovic)"
mockups: []
---

# Radial Clock View & MCP Tool Exposure — Design Doc

## Background — Reassign App Analysis

Reassign is a **24-hour circular day planner** that renders the entire day as a radial dial (full 360° = 24 hours). It was surfaced via [r/ProductivityApps](https://www.reddit.com/r/ProductivityApps/comments/1ur886s/my_day_planner_is_a_clock_face_now_it_syncs_with/) and exemplifies several concepts worth incorporating into Mission Control.

### How Reassign Works

1. **Circular time visualization** — Events and tasks are colored arcs on a 24-hour dial. The user "sees their day as a shape" — dense days look full, free time is empty wedge space. This is fundamentally different from linear timelines because it gives instant gestalt of day density.

2. **Direct manipulation** — Drag on empty space to create a time block, pull an arc's edge to resize, drag an arc to move it. All interactions map to natural clock-face gestures.

3. **Real-time AI reshaping via MCP** — Reassign exposes **13 tools** over the Model Context Protocol (MCP). Users tell Claude things like "push everything after 3pm back an hour" and the dial reshapes live. Uses a two-step `schedule` → `confirm_schedule` pattern so nothing lands until the user confirms.

4. **Contextual overlays** — Weather ring around the center, energy curve visualization, and a red "now" indicator sweep on the dial.

5. **Inline rendering** — Their `show_day` tool renders the actual dial inside a Claude chat message, so the user sees the plan they're editing without switching apps.

6. **Safety & control** — OAuth-scoped grants (read vs write per client), 30-minute undo window for any change, revocable per-client.

### What Makes It Compelling

- **Spatial memory** — Circular layout maps to how humans naturally think about time (clock face). You remember "that meeting is at the 2 o'clock position" more easily than "it's the 5th item in a scrollable list."
- **Density at a glance** — Full day = full circle. One look tells you if the day is packed or has breathing room. Linear timelines require scrolling.
- **ADHD-friendly** — The concrete visual shape makes an abstract day tangible. This aligns directly with MC's target user profile.
- **AI-native planning** — MCP integration means the planner isn't just a display — it's a tool that AI agents can manipulate, turning "plan my day" from advice into action.

---

## Proposed Features for Mission Control

Three additions, ordered by impact:

### 1. Radial Clock View Toggle (My Day)

**Summary:** Add an optional circular/radial view mode to the My Day page alongside the existing linear timeline.

**Why:** MC's My Day is currently a linear list + timeline. A radial view gives instant gestalt of day density and brings a differentiated, visually engaging interaction model that aligns with MC's "density over simplicity" principle.

#### Visualization

```
         12 (noon)
          │
    11 ───┼─── 1
   /      │      \
  10   ┌──────┐   2
  │    │ NOW  │   │
  9    │  ●   │   3
  │    └──────┘   │
  8    \      /   4
    7 ───┼─── 5
          │
         6 (6 PM)
```

- Full 360° = 24 hours (midnight at top, noon at bottom — or configurable)
- Tasks render as colored arcs with label text along the arc or in a tooltip
- Calendar events render as ghosted/muted arcs (consistent with MY-DAY-ENHANCEMENTS.md §1.4)
- Unscheduled tasks remain in a sidebar list (same as current behavior)
- Current time shown as a radial hand/indicator line that sweeps in real-time

#### Interaction Model

| Action | Gesture |
|--------|---------|
| Create time block | Click-drag on empty arc segment |
| Move time block | Drag arc to new position |
| Resize duration | Drag leading/trailing edge of arc |
| Complete task | Click checkbox overlay on arc |
| View details | Click arc → detail panel slides in |
| Schedule from list | Drag task from sidebar onto dial |

#### Snap Grid

- 15-minute increments (consistent with MY-DAY-ENHANCEMENTS.md §1.1)
- Visual tick marks at hour boundaries, subtle ticks at 15-min intervals
- Hold Shift to snap to 5-minute increments (power user)

#### Visual Design

- **Arc colors:** Inherit from task source color system (blue for GitHub, amber for calendar, etc.) as defined in existing source badges
- **Ghost events:** Calendar events at 40% opacity with subtle pattern fill (per MY-DAY-ENHANCEMENTS.md §1.4)
- **Now indicator:** Red radial line from center, thin (2px), with a small dot at the current position
- **Center area:** Show summary stats — "5 tasks · 3h blocked · 2h free" or a mini weather widget
- **Dark mode:** Arcs use source colors at reduced saturation; dial background follows MC's existing dark theme
- **Empty state:** Faint hour markings only, with a "Drag tasks here or click to block time" hint

#### Responsive Behavior

- Desktop: Clock is the primary view, sidebar list on the right
- Tablet: Clock fills the viewport, sidebar collapses to a bottom drawer
- Mobile: Default to linear timeline (existing view), clock available via toggle but interaction is limited to tap-to-view (no drag gestures)

#### Technical Approach

- SVG-based rendering (arcs via `<path>` with arc commands)
- Or Canvas for performance with many overlapping arcs
- React component: `<RadialDayView>` consuming the same schedule data as the linear timeline
- Animation: Use Motion (framer-motion) for arc enter/exit transitions (consistent with MC's motion system in `src/lib/motion.ts`)
- State: Same `task_schedules` table and schedule API — no schema changes needed

---

### 2. "Now" Indicator on Linear Timeline

**Summary:** Even without the radial view, add a real-time "now" line to the existing linear My Day timeline.

**Why:** Trivial to implement, high utility. Instantly answers "where am I in my day?" without mental math.

#### Implementation

- Thin red horizontal line (2px) spanning the full width of the timeline
- Positioned based on current time relative to the visible time range
- Auto-scroll to current time on page load (with 1h buffer above)
- Updates position every 60 seconds (or use CSS animation for smooth sweep)
- Label: small "Now" badge at the left edge, or just the current time "2:45 PM"
- Past items above the line get subtle opacity reduction (e.g., 60% opacity) to visually "fade" completed time

#### Code Location

- Add to the existing timeline component in `src/app/today/page.tsx`
- CSS: `position: absolute` within the timeline container, `top` calculated from current hour/minute

---

### 3. MCP Tool Exposure for AI Agents

**Summary:** Expose Mission Control's schedule and task APIs as MCP tools, enabling Claude, Copilot, or any MCP-compatible AI to read and manipulate the user's day.

**Why:** MC already has an AI assistant page and "AI Plan My Day" concept. MCP exposure turns MC from an AI-advised app into an AI-operable app — consistent with the "act from anywhere" design principle.

#### Proposed Tool Set

| Tool | Scope | Description |
|------|-------|-------------|
| `get_my_day` | `read` | Returns today's scheduled tasks, calendar events, and unscheduled My Day items |
| `get_schedule` | `read` | Returns schedule for a specific date or date range |
| `get_task` | `read` | Returns full detail for a single task by ID |
| `search_tasks` | `read` | Search tasks by keyword, status, source, priority, tags |
| `add_to_my_day` | `write` | Add a task to My Day (optionally with a time slot) |
| `remove_from_my_day` | `write` | Remove a task from My Day |
| `schedule_task` | `write` | Assign a time block to a task (start time + duration) |
| `reschedule_task` | `write` | Move an existing time block to a new time |
| `complete_task` | `write` | Mark a task as done |
| `create_task` | `write` | Create a new task in MC (triage inbox) |
| `get_suggestions` | `read` | Returns the smart suggestion groups (yesterday, overdue, AI recommended, etc.) |
| `propose_plan` | `write` | AI proposes a full day schedule; returns a preview without committing |
| `confirm_plan` | `write` | Confirms a proposed plan, committing all changes |

#### Propose → Confirm Pattern

Borrowed directly from Reassign. For batch operations (AI rescheduling multiple items):

1. AI calls `propose_plan` with desired changes
2. MC returns a structured diff: `[{ task: "Fix auth", from: "10:00", to: "2:00" }, ...]`
3. User reviews in MC UI (or the AI summarizes the diff in chat)
4. AI calls `confirm_plan` to commit — or user rejects and AI adjusts

This prevents AI from silently reshuffling the entire day without oversight.

#### Undo Window

Extend the planned undo mechanism (currently spec'd as 5s toast in PRODUCT.md) to **5 minutes for MCP-initiated changes**. Rationale: AI-driven batch edits are higher-risk than single manual actions, so a longer rollback window is appropriate.

#### Auth & Scoping

- OAuth 2.0 grants scoped to `tasks:read`, `tasks:write`, `schedule:read`, `schedule:write`
- Per-client grants (revocable from MC Settings page)
- Rate limiting: 60 requests/minute per client
- Audit log: all MCP-initiated changes logged with client ID and timestamp

#### Technical Approach

- MCP endpoint at `https://<mc-host>/api/mcp` (streamable HTTP)
- Implement using the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- Tools map to existing Next.js API routes — MCP handlers are thin wrappers
- OAuth discovery via `.well-known/mcp` endpoint

---

## Concept Comparison: Reassign vs Mission Control

| Dimension | Reassign | MC (Current) | MC (Proposed) |
|-----------|----------|--------------|---------------|
| Day view | Circular dial only | Linear timeline + list | Linear + circular toggle |
| Time awareness | "Now" sweep hand | None | "Now" line (linear) + hand (radial) |
| Calendar integration | Native sync | Calendar events fetched + displayed | Same, with ghost styling |
| AI interaction | MCP-native (13 tools) | Chat-based AI assistant page | MCP tools + existing chat |
| AI safety | Propose → confirm + 30min undo | Optimistic writes | Propose → confirm + 5min undo |
| Energy awareness | Energy curve ring on dial | Planned (longer-term roadmap) | Energy curve overlay on radial view |
| Weather context | Weather ring overlay | None | Optional center-area widget (low priority) |
| Scope | Single-purpose day planner | Full task management platform | Full platform + radial day view |

---

## Implementation Phases

### Phase 1: "Now" Indicator (Linear Timeline)
- Effort: ~2 hours
- Add real-time now line to existing My Day timeline
- Auto-scroll to current time on load
- Past-time opacity fade

### Phase 2: Radial Clock View (Read-Only)
- Effort: ~1-2 weeks
- SVG radial rendering of scheduled tasks + calendar events
- Toggle between linear and radial views
- Now indicator as radial hand
- Center stats (task count, blocked time, free time)
- No drag interactions yet — view only

### Phase 3: Radial Clock Interactions
- Effort: ~1-2 weeks
- Drag-to-create on empty arc space
- Drag-to-move arcs
- Drag-to-resize arc edges
- Drag from sidebar list onto dial
- 15-minute snap grid

### Phase 4: MCP Tool Exposure
- Effort: ~1-2 weeks
- Implement MCP endpoint with read tools first (`get_my_day`, `get_schedule`, `search_tasks`)
- Add write tools (`schedule_task`, `complete_task`, `add_to_my_day`)
- OAuth scoping and per-client grants
- Propose → confirm pattern for batch operations

### Phase 5: Polish & Contextual Overlays
- Effort: ~1 week
- Energy curve overlay (when energy-aware feature lands)
- Weather widget in center area
- Inline `show_day` rendering for MCP responses
- Accessibility: keyboard navigation for radial arcs, screen reader arc labels

---

## Open Questions

1. **Clock orientation** — Should midnight be at top (traditional 24h clock) or should the visible range auto-center on waking hours (e.g., 6am–midnight)? Reassign uses full 24h with midnight at top.

2. **Dual-ring vs single-ring** — Traditional 24h clocks sometimes use an inner ring (12am–12pm) and outer ring (12pm–12am). Single ring with full 360° = 24h is simpler but arcs are narrower. Need to prototype both.

3. **Mobile viability** — Is the radial view useful on phone screens, or should it be desktop/tablet only? Reassign is designed mobile-first, but MC's density-first approach may make it too cramped on small screens.

4. **MCP hosting** — MC currently runs as a self-hosted Docker container. MCP over HTTP requires the instance to be reachable. This works for homelab with a tunnel, but may need a cloud relay option for broader use.

---

## References

- [Reassign.app](https://reassign.app/) — The 24-hour circular day planner
- [Reassign MCP documentation](https://reassign.ai/mcp) — 13-tool MCP integration with Claude
- [Model Context Protocol](https://modelcontextprotocol.io/) — Open protocol spec
- [Reddit discussion](https://www.reddit.com/r/ProductivityApps/comments/1ur886s/my_day_planner_is_a_clock_face_now_it_syncs_with/) — Original post that surfaced the app
- MC docs: `MY-DAY-ENHANCEMENTS.md` — Existing My Day timeline enhancement plans
- MC docs: `PRODUCT.md` — Product principles and roadmap
