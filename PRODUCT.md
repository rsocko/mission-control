# Product

## Register

product

## Users

Power user managing 50+ active tasks across multiple sources (Microsoft Todo, GitHub, future connectors). Context: solo operator juggling development projects, 3D printing, home improvement, and automation — needs a single control plane to see everything, decide what's next, and act without switching tools.

## Product Purpose

Mission Control aggregates tasks, alerts, and project status from disparate source systems into one unified interface. It replaces tab-switching and mental overhead with a dense, keyboard-driven command center. Success = the user opens MC once, sees the full picture, acts on what matters, and trusts the system to keep sources in sync.

## Brand Personality

Focused, capable, efficient.

Voice: direct, no filler. Interface: information-dense but never cluttered. Every element earns its pixels. Motion is purposeful (confirms actions, reveals hierarchy), never decorative.

## Anti-references

- **Jira / Monday.com** — overwhelming chrome, nested menus, configuration ceremony, visual noise
- **Generic SaaS templates** — hero-metric cards, identical rounded-corner grids, gradient accents, startup polish without substance
- **Todoist / playful task apps** — candy colors, gamification, over-simplified views that hide information
- **Apple Reminders** — too sparse, no density, no power-user affordances, treats tasks as an afterthought

## Design Principles

1. **Density over simplicity** — show more information per viewport; trust the user to parse it. Whitespace is structural, not decorative.
2. **Auto-infer over manual ceremony** — derive status, tags, and groupings from data. Never ask the user to configure what can be computed.
3. **Act from anywhere** — keyboard shortcuts, quick-add, inline editing. Minimize navigation to accomplish an action.
4. **Source-aware, not source-bound** — surface where data came from (icons, subtle indicators) but never let source boundaries dictate the UX.
5. **Optimistic and immediate** — write-through on actions, instant UI feedback, correct on failure rather than block on confirmation.

## Accessibility & Inclusion

- WCAG AA compliance (4.5:1 contrast for body text, 3:1 for large text/UI components)
- `prefers-reduced-motion` respected: all animations have instant/crossfade fallback
- Keyboard navigable: all interactive elements reachable via Tab, actions via Enter/Space
- Focus indicators visible in both light and dark themes
- No information conveyed by color alone (icons/labels supplement status colors)

## Roadmap — Future Features

### Near-term (designed, not yet implemented)
- **Wave/Phase Planning** — group tasks into ordered phases (within a project or cross-project), with AI-assisted grouping, gap detection, and Gantt-style timeline visualization. Three modes: manual curation, AI suggestions, AI autonomous with approval. See `docs/WAVE-PLANNING-DESIGN.md`.
- **Goals & Ideas Smart View** — tag-based filtered page (`#goal`, `#idea`, `#brainstorm`) for capturing aspirations and developing them into projects/tasks via AI "Develop" feature. No new schema entity — leverages existing tags system.
- **Focus mode** — hide sidebar + alerts panel, full-width task list for distraction-free work
- **Export** — CSV/JSON export of current filtered view
- **Daily completion counter** — persistent "✓ N today" badge in the header; resets at midnight. Visible momentum signal that makes small wins compound psychologically
- **Completion micro-animation** — subtle scale + particle burst on task completion. Purposeful motion (not decorative) that makes clicking "Done" feel rewarding

### Medium-term
- **AI triage** — "Suggest what to work on today" using priority, due date, and behavioral patterns
- **Keyboard command palette** — extend Ctrl+K to support actions (e.g. "complete task X", "move to list Y", "tag with Z")
- **Undo last action** — global undo for task completion, moves, deletes (toast with undo button, 5s window)
- **Pin to My Day** — quick action to pin current filtered view's top items to My Day
- **Micro-statuses / blocked reasons** — extend task status beyond To Do / In Progress / Done with honest states: "Waiting on someone," "Need to think about this," "Ready but unmotivated," "Started but stuck," "Done but needs review." Surfaces *why* things aren't moving, not just *that* they're stalled. AI can auto-suggest status based on age + inactivity patterns
- **Task & workflow templates** — reusable templates for common task+subtask patterns (e.g. "Trip packing checklist," "3D print project," "New home improvement project"). Two tiers: (1) single task with pre-filled subtasks, (2) multi-task "workflow set" that stamps out a group of related tasks at once. User-created + AI-suggested from repeated patterns
- **Focus countdown timer** — opt-in "Mission Impossible" countdown on individual tasks you keep avoiding. Visible on the task card, turns red as deadline approaches, pulses in final minutes. Triggerable via keyboard shortcut or right-click. Stressful by design — a self-imposed pressure mechanism for procrastination-prone tasks

### Longer-term
- **Energy-aware "What's Next"** — extend AI suggestions to factor in energy/focus level. Tasks tagged (manually or AI-inferred) as "high focus" vs "low energy." Time-of-day heuristics (post-lunch = low energy suggestions). Optional quick "How's your energy?" prompt when opening My Day that adjusts recommendations
- **Notification preferences** — snooze alerts, set reminder intervals, per-source notification rules
